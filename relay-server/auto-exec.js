'use strict';
/* 자동매매 2단계(2026-11-15) — 승인한 후보를 가상매매(paper.js)로 매수하고 손절·5분할 익절 계획을 붙인다.
   · 매수가·목표가·익절 단계는 매매 화면(web/index.html trdRecBids·buildPriceProfile·trdTarget·trdPlan·trdStopPrice)과 같은 계산을 옮긴 것
     - 매수가: 매수 호가 10단계 중 잔량이 가장 많은 가격(설정 buyPick='low' 면 가장 낮은 호가)
     - 목표가: 현재가 위 개인 순매수 매물대를 오늘 거래대금과 5거래일 평균 거래대금 중 큰 값으로 뚫을 수 있는 데까지 올라간 뒤 그 위 가장 큰 매물대 바로 아래.
               위쪽 매물대가 없으면(신고가 등) 손절폭 × 3(손익비 1:3, 손절 5% → +15%), 전고점이 더 높으면 전고점. 상한가를 넘지 않음
     - 익절: 매수가→목표가를 5등분(1단계는 최소 +3%), 수량 균등·나머지는 마지막 단계. 각 단계는 엔진의 트레일링 익절(기본 2%)
     - 손절: 매수가 × (1 − 5%) 호가 내림
   · 승인 직후 재확인: 체결강도 100%↑ · 알림 시점 가격 대비 ±1.5% 이내 · 시가 대비 +8% 이하 · VI·거래정지 아님
   · 미체결: 3분 뒤 남은 수량을 현재 매수 1호가로 한 번 정정, 다시 3분 뒤에도 남으면 취소(일부 체결분은 계획대로 관리)
   · 중복 방지: 주문 전에 auto_runs 에 '주문 의도(intent)'를 먼저 저장. 서버가 재시작돼 결과를 모르면 가상매매 주문 목록에서
     같은 종목 매수 주문을 찾아 이어받고, 못 찾으면 다시 내지 않고 '확인 불가'로 알린다 */

const { capCheck } = require('./auto-risk');
const TICKS = [[2000, 1], [5000, 5], [20000, 10], [50000, 50], [200000, 100], [500000, 500]];
const EOK = 1e8;
const tickOf = p => { for (const [lim, t] of TICKS) if (p < lim) return t; return 1000; };
const floorTick = p => { const t = tickOf(p); return Math.floor(p / t + 1e-9) * t; };
const ceilTick = p => { const t = tickOf(p); return Math.ceil(p / t - 1e-9) * t; };
const below = p => { let f = floorTick(p); if (f >= p - 1e-9) f -= tickOf(f - 1); return f; };

const PROFILE_DOWN = 0.30, PROFILE_UP = 0.70;
const DEF = Object.freeze({ stopPct: 5, rr: 3, trail: 2, split: 5, minPct: 3, coef: 1, recheckPct: 1.5, openRiseMax: 8, cttrMin: 100, fillWaitMs: 180e3, intentLostMs: 60e3 });

/* 매수 호가에서 추천: 잔량 1위·2위, 가장 낮은 호가 (trdRecBids) */
function recBids(bids, cur) {
  const L = (bids || []).filter(b => b.p > 0 && b.q > 0);
  if (!L.length) return [];
  const byQ = [...L].sort((a, b) => b.q - a.q || b.p - a.p);
  const low = L.reduce((m, b) => (b.p < m.p ? b : m), L[0]);
  const mk = (k, b) => ({ k, p: b.p, q: b.q, dist: cur > 0 ? (b.p / cur - 1) * 100 : 0 });
  const out = [mk('q1', byQ[0])]; if (byQ[1]) out.push(mk('q2', byQ[1])); out.push(mk('low', low));
  return out;
}
/* 가격대별 개인 순매수(억원) — 높은 가격대부터 (buildPriceProfile) */
function buildProfile(rows, n = 24, valueFn = r => +r.individual_net || 0) {
  const closes = (rows || []).map(r => +r.close).filter(v => !isNaN(v));
  if (!closes.length) return [];
  const cur = +rows[rows.length - 1].close;
  const lo = cur * (1 - PROFILE_DOWN), hi = cur * (1 + PROFILE_UP);
  const span = (hi - lo) || Math.max(1, lo * 0.02), size = span / n;
  const idx = c => Math.min(n - 1, Math.max(0, Math.floor((c - lo) / size)));
  const b = Array.from({ length: n }, () => 0);
  rows.forEach(r => { b[idx(+r.close)] += valueFn(r) / EOK; });
  return b.map((v, i) => ({ lo: lo + i * size, hi: lo + (i + 1) * size, v })).reverse();
}
/* 목표가 (trdTarget) */
function calcTarget({ cur, prof, capEok, coef = 1, prevHigh = 0, upper = 0, stopPct = 5, rr = 3 }) {
  const cap = Math.max(0, capEok || 0) * coef;
  const above = (prof || []).filter(b => b.lo >= cur - 1e-9).sort((a, b) => a.lo - b.lo);
  let cum = 0, ri = -1;
  for (let i = 0; i < above.length; i++) { const v = Math.max(0, above[i].v); if (cum + v <= cap) { cum += v; ri = i; } else break; }
  const rest = above.slice(ri + 1).filter(b => b.v > 0);
  let target = null, mode;
  if (rest.length) {
    const top = ri < 0 ? rest[0] : rest.reduce((m, b) => (b.v > m.v ? b : m), rest[0]);
    mode = ri < 0 ? 'blocked' : 'normal';
    target = below(top.lo);
  } else {
    mode = 'no-supply';
    const rrT = cur > 0 && stopPct > 0 && rr > 0 ? floorTick(cur * (1 + stopPct / 100 * rr)) : null;
    target = Math.max(prevHigh > cur ? floorTick(prevHigh) : 0, rrT || 0) || null;
  }
  if (target != null && upper > 0 && target > upper) target = floorTick(upper);
  if (target != null && target <= cur) { target = null; mode += '-none'; }
  return { target, mode, cap, cum };
}
/* 익절 단계 (trdPlan) */
function splitPlan(buy, target, qty, want = 5, minPct = 3) {
  qty = Math.floor(qty); want = Math.min(5, Math.max(1, Math.floor(want) || 5));
  if (!(buy > 0) || !(target > buy) || qty < 1) return { steps: [] };
  const base = Math.floor(qty / want), rem = qty - base * want, steps = [];
  const min = ceilTick(buy * (1 + minPct / 100)), lift = want > 1 && target > min && floorTick(buy + (target - buy) / want) < min;
  for (let i = 1; i <= want; i++) steps.push({ n: i, p: lift ? floorTick(min + (target - min) * (i - 1) / (want - 1)) : floorTick(buy + (target - buy) * i / want), q: qty >= want ? base + (i === want ? rem : 0) : (i <= qty ? 1 : 0) });
  return { steps };
}
const stopPrice = (buy, pct) => floorTick(buy * (1 - pct / 100));

/* 매수 주문 내용 계산: 시세(q) + 일봉(rows) → 가격·수량·계획 */
function makeOrder({ q, rows, perStockKrw, opt = {} }) {
  const o = { ...DEF, ...opt };
  const cur = q.price > 0 ? q.price : +(rows[rows.length - 1] || {}).close;
  const rec = recBids(q.bids, cur);
  const bid1 = (q.bids || []).filter(b => b.p > 0 && b.q > 0).reduce((m, b) => (!m || b.p > m.p ? b : m), null);   // 최우선 매수 호가
  const pick = (o.buyPick === 'low' ? rec.find(r => r.k === 'low') : o.buyPick === 'bid1' ? (bid1 && { k: 'bid1', p: bid1.p }) : rec[0]) || null;
  const buy = pick ? pick.p : floorTick(cur);
  const qty = Math.floor(perStockKrw / buy);
  if (qty < 1) return { skip: `금액 ${perStockKrw.toLocaleString('ko-KR')}원으로 1주도 못 삼(${buy.toLocaleString('ko-KR')}원)` };
  const last5 = rows.slice(-5), avg5 = last5.length ? last5.reduce((a, r) => a + (+r.trade_amount || 0), 0) / last5.length : 0;
  const capEok = Math.max(avg5, q.amt || 0) / EOK;
  const prevHigh = rows.length ? Math.max(...rows.map(r => (+r.high > 0 ? +r.high : +r.close))) : 0;
  const tgt = calcTarget({ cur, prof: buildProfile(rows), capEok, coef: o.coef, prevHigh, upper: q.upper, stopPct: o.stopPct, rr: o.rr });
  const steps = tgt.target ? splitPlan(buy, tgt.target, qty, o.split, o.minPct).steps.filter(s => s.q > 0) : [];
  const plan = { stopPct: o.stopPct, stop: stopPrice(buy, o.stopPct), target: tgt.target, trail: o.trail, steps: steps.map(s => ({ n: s.n, p: s.p, q: s.q })) };
  return { buy, qty, plan, target: tgt.target, mode: tgt.mode, pick: pick ? pick.k : 'cur' };
}

/* 승인 직후 재확인 — 실패 사유 배열(빈 배열이면 통과) */
function recheck(q, notice, opt = {}) {
  const o = { ...DEF, ...opt }, why = [];
  if (!q || !(q.price > 0)) return ['시세 없음'];
  if (q.vi) why.push('VI 발동 중');
  if ((q.warnings || []).some(w => /거래정지|정리매매|관리종목|투자위험|투자경고/.test(w))) why.push(`경고 종목(${q.warnings.join(',')})`);
  if (q.strength == null) why.push('체결강도 없음'); else if (q.strength < o.cttrMin) why.push(`체결강도 ${Math.round(q.strength)}%`);
  if (notice && notice.price > 0) {
    const d = (q.price / notice.price - 1) * 100;
    if (d > o.recheckPct) why.push(`알림 후 +${d.toFixed(1)}% 더 오름`);
    if (d < -o.recheckPct) why.push(`알림 후 ${d.toFixed(1)}% 밀림`);
  }
  if (q.open > 0 && Math.round((q.price / q.open - 1) * 1e4) / 100 > o.openRiseMax) why.push(`시가 대비 +${((q.price / q.open - 1) * 100).toFixed(1)}%`);
  return why;
}

const fmt = v => Math.round(v).toLocaleString('ko-KR');
function planText(r) {
  const s = r.plan.steps.length ? `익절 ${r.plan.steps.map(x => fmt(x.p)).join(' / ')}` : '익절 없음(목표가를 못 정함 — 매매 화면에서 직접 설정)';
  return `손절 ${fmt(r.plan.stop)}원(−${r.plan.stopPct}%) · ${s}`;
}

/* deps: paper{place,modify,cancel,state} · getQuote(code) · loadChart(code)→rows · mutateRun(date, fn(run)→void) · readRun(date) · sendTelegram · now · perStock()→원 · opt()→설정 */
function createExec(deps) {
  const D = deps, now = D.now || Date.now;
  const stateOf = o => (o && o.status) || null;

  async function placeOne(date, code, notice, perStock, opt) {
    try { if (D.paper.heldCodes && D.paper.heldCodes().includes(code)) return { st: 'skipped', why: '이미 보유·주문 중(다른 전략 또는 직접 매매)' }; } catch (_) {}   // 같은 종목은 한 포지션으로 합쳐지므로 겹쳐 사지 않음
    let q; try { q = await D.getQuote(code); } catch (e) { return { st: 'skipped', why: '시세 조회 실패: ' + e.message }; }
    const why = recheck(q, notice, opt);
    if (why.length) return { st: 'skipped', why: why.join(', ') };
    let rows; try { rows = await D.loadChart(code); } catch (e) { rows = []; }
    if (!rows || !rows.length) return { st: 'skipped', why: '일봉 자료 없음' };
    const ord = makeOrder({ q, rows, perStockKrw: perStock, opt });
    if (ord.skip) return { st: 'skipped', why: ord.skip };
    // 1) 의도 먼저 저장(재시작 중복 방지)
    const at = now();
    await D.mutateRun(date, run => { run.payload.orders = run.payload.orders || {}; run.payload.orders[code] = { st: 'intent', at, buy: ord.buy, qty: ord.qty, plan: ord.plan, mode: ord.mode, pick: ord.pick }; });
    // 2) 주문
    const r = await D.paper.place({ code, name: notice.name, side: 'buy', type: 'limit', price: ord.buy, qty: ord.qty, plan: ord.plan, cid: `auto${date.replace(/-/g, '')}${code}` });
    if (!r || !r.ok) {
      await D.mutateRun(date, run => { run.payload.orders[code] = { ...run.payload.orders[code], st: 'failed', why: (r && r.error) || '주문 거부' }; });
      return { st: 'failed', why: (r && r.error) || '주문 거부', ord };
    }
    const o = r.order, filled = o.filled || 0;
    const st = stateOf(o) === 'filled' ? 'filled' : 'open';
    await D.mutateRun(date, run => { run.payload.orders[code] = { ...run.payload.orders[code], st, orderId: o.id, placedAt: at, filled, avg: o.avg || null }; });
    return { st, ord, order: o };
  }

  /* 승인 처리: 승인한 종목을 차례로 주문. 반환 = 텔레그램 답장 */
  async function approve(date, payload) {
    const ps0 = D.perStock ? await D.perStock() : null, perStock = ps0 > 0 ? ps0 : 1000000;
    const opt = D.opt ? await D.opt() : {};
    const lines = [`🛒 가상 매수 · 종목당 ${fmt(perStock)}원`];
    for (const code of payload.approved || []) {
      const notice = (payload.picks || []).find(p => p.code === code) || { code, name: code };
      const cur = payload.orders && payload.orders[code];
      if (cur && cur.st) { lines.push(`· ${notice.name}: 이미 처리됨(${cur.st})`); continue; }
      let r;
      if (opt && opt.totalCapKrw > 0 && D.exposure) {   // 총액 상한: 새 주문이 상한을 넘으면 이 종목만 사지 않음(기존 보유는 그대로)
        const ck = capCheck(opt.totalCapKrw, await D.exposure().catch(() => null), perStock);
        if (!ck.ok) { await D.mutateRun(date, run => { run.payload.orders = run.payload.orders || {}; run.payload.orders[code] = { st: 'skipped', why: ck.why, at: now() }; }); lines.push(`· ${notice.name}: 매수 안 함 — ${ck.why}`); continue; }
      }
      try { r = await placeOne(date, code, notice, perStock, opt); } catch (e) { r = { st: 'failed', why: e.message }; }
      if (r.st === 'skipped') {
        await D.mutateRun(date, run => { run.payload.orders = run.payload.orders || {}; run.payload.orders[code] = { st: 'skipped', why: r.why, at: now() }; });
        lines.push(`· ${notice.name}: 매수 안 함 — ${r.why}`);
      } else if (r.st === 'failed') lines.push(`· ${notice.name}: 주문 실패 — ${r.why}`);
      else {
        const o = r.order, ord = r.ord;
        lines.push(`· ${notice.name}: ${o.status === 'filled' ? `체결 ${fmt(o.filled)}주 평균 ${fmt(o.avg)}원` : `${fmt(ord.buy)}원 ${fmt(ord.qty)}주 지정가 대기${o.filled ? ` (일부 ${fmt(o.filled)}주 체결)` : ''}`}`);
        lines.push(`  ${planText(ord)}`);
      }
    }
    const wm = Math.round(((opt && opt.fillWaitMs) || DEF.fillWaitMs) / 60e3);
    lines.push('', `미체결은 ${wm}분 뒤 매수 1호가로 한 번 정정, 다시 ${wm}분 뒤 남으면 취소해요.`);
    return lines.join('\n');
  }

  /* 주기 관리: 미체결 정정·취소, 체결 알림, 주문 결과를 모르는 의도 정리 */
  async function follow(date) {
    const run = await D.readRun(date);
    const ords = run && run.payload && run.payload.orders;
    if (!ords) return { ok: true, n: 0 };
    const o2 = { ...DEF, ...(D.opt ? await D.opt().catch(() => ({})) : {}) }, wm = Math.round(o2.fillWaitMs / 60e3);
    const active = Object.entries(ords).filter(([, v]) => v.st === 'intent' || v.st === 'open' || v.st === 'modified');
    if (!active.length) return { ok: true, n: 0 };
    const S = await D.paper.state();
    if (!S || !S.ok) return { ok: false, why: 'paper state' };
    const byId = new Map((S.orders || []).map(o => [o.id, o]));
    const msgs = [];
    for (const [code, v] of active) {
      const name = ((run.payload.picks || []).find(p => p.code === code) || {}).name || code;
      if (v.st === 'intent') {   // 재시작 등으로 결과 모름 → 의도 시각 이후 같은 종목 매수 주문을 찾아 이어받기
        const found = (S.orders || []).filter(o => o.code === code && o.side === 'buy' && o.ts >= v.at - 2000).sort((a, b) => a.ts - b.ts)[0];
        if (found) await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: found.status === 'filled' ? 'filled' : 'open', orderId: found.id, placedAt: found.ts, filled: found.filled }; });
        else if (now() - v.at > DEF.intentLostMs) {
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'lost' }; });
          msgs.push(`⚠ ${name}: 주문 결과를 확인하지 못했어요(서버 재시작 추정). 중복을 막으려고 다시 내지 않았어요 — 매매 화면에서 확인하세요.`);
        }
        continue;
      }
      const o = byId.get(v.orderId);
      if (!o) continue;
      if (o.status === 'filled') {
        await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'filled', filled: o.filled, avg: o.avg }; });
        msgs.push(`✅ ${name}: 가상 매수 체결 ${fmt(o.filled)}주 평균 ${fmt(o.avg)}원 — 손절·익절 자동 관리 시작`);
        continue;
      }
      if (o.status !== 'open' && o.status !== 'partial') {   // 엔진이 취소·소멸시킨 경우
        await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: o.filled ? 'partial_done' : 'cancelled', filled: o.filled, avg: o.avg }; });
        continue;
      }
      const since = v.st === 'modified' ? v.modifiedAt : v.placedAt;
      if (now() - since < o2.fillWaitMs) continue;
      if (v.st === 'open') {   // 3분 미체결 → 매수 1호가로 한 번 정정
        let q; try { q = await D.getQuote(code); } catch (_) { continue; }
        const bid1 = ((q.bids || []).find(b => b.p > 0) || {}).p;
        if (!(bid1 > 0) || bid1 === o.price) {   // 이미 1호가면 정정할 게 없음 → 정정한 것으로 보고 3분 더 기다림
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'modified', modifiedAt: now() }; });
          continue;
        }
        const m = await D.paper.modify({ id: o.id, price: bid1 });
        if (m && m.ok) {
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: m.order.status === 'filled' ? 'filled' : 'modified', orderId: m.order.id, modifiedAt: now(), from: o.id, buy2: bid1 }; });
          msgs.push(`↪ ${name}: ${wm}분 미체결 → ${fmt(bid1)}원으로 정정${m.order.status === 'filled' ? ' · 체결' : ''}`);
        } else {
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'cancelled', why: '정정 실패: ' + ((m && m.error) || '') }; });
          msgs.push(`⚠ ${name}: 정정 실패 — ${(m && m.error) || '알 수 없음'}`);
        }
      } else {                 // 정정 후 3분도 미체결 → 취소
        const c = await D.paper.cancel(o.id);
        await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: o.filled ? 'partial_done' : 'cancelled', filled: o.filled, avg: o.avg, why: c && c.ok ? '미체결 취소' : '취소 실패' }; });
        msgs.push(`✖ ${name}: 정정 후에도 미체결 → 취소${o.filled ? ` (일부 ${fmt(o.filled)}주는 보유·계획대로 관리)` : ''}`);
      }
    }
    if (msgs.length) await D.sendTelegram(msgs.join('\n'));
    return { ok: true, n: active.length, msgs };
  }

  return { approve, follow };
}

module.exports = { DEF, tickOf, floorTick, recBids, buildProfile, calcTarget, splitPlan, stopPrice, makeOrder, recheck, createExec };
