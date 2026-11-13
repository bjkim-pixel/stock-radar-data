'use strict';
/* ════════════════════════════════════════════════════════════════════════
   실전매매 엔진 (매매 6단계) — KIS 실제 계좌로 주문(kis-order.js)
   켜지는 조건: TRADING_ENABLED=1 · REAL_TRADING_ENABLED=1 · KIS_ACCOUNT_NO/KIS_ACCOUNT_PRDT 설정 · 로그인 · 거래 PIN 세션 · 실전 한도
   원칙
   · 계좌의 진실은 KIS: 보유 수량·평균가는 잔고 조회, 체결은 일별 주문체결 조회로 맞춤(5초마다, 주문이 있을 때)
   · 주문 전 DB 에 먼저 기록(실패하면 주문 안 냄). 주문 요청은 자동 재시도 안 함. 응답을 못 받으면 '확인 필요' 로 두고
     체결조회에서 같은 종목·방향·수량·시각의 주문을 찾아 대조(60초 안에 못 찾으면 '접수 안 됨' 처리 + 알림)
   · 손절: 걸린 매도 주문을 취소 → 잔고를 다시 읽어 실제 매도 가능 수량만큼 시장가 매도. 취소에 실패한 주문 수량은 빼고 팜(초과 매도 방지)
   · 익절: 계획 비중대로 지정가 매도. 바꿔야 하면 먼저 취소하고, 취소가 체결조회로 확인된 다음 주기에 새로 냄(두 번 걸리지 않게)
   · 확인 중(pending/unknown) 주문이 있는 종목은 자동 매도가 새 주문을 내지 않음
   · 계획이 없는 보유 종목(HTS 에서 산 종목 등)은 자동 매도하지 않음 — 화면의 계획 수정으로 계획을 넣으면 그때부터 감시
   · 모든 실전 주문에 같은 순간 호가로 계산한 가상 체결가(sim_avg)를 함께 저장 → 리포트에서 가상 대비 차이 비교
   · 8단계(NXT·시간외): 08:00~20:00 동안 종목별 세션(session.js)에 따라 주문. 주문마다 거래소(excg: KRX·NXT·SOR)를 저장하고 취소에 같은 값을 씀.
     익절은 NXT 종목이면 NXT(20:00까지 유지), KRX 종목이면 KRX(정규장분은 15:30 소멸 → 15:40 체결조회 정리 후 16:00 애프터마켓에 다시 냄).
     프리·애프터마켓 손절은 시장가 대신 매수 1호가 n호가 아래 지정가 — 정해진 시간 안에 다 안 팔리면 취소 확인 후 다시 냄.
     19:58 에 남은 미체결을 모두 취소 요청, 20:05 까지 체결조회로 정리한 뒤 남은 주문은 소멸 처리
   ════════════════════════════════════════════════════════════════════════ */
const E = require('./paper-engine');
const SES = require('./session');
const { allocSteps } = require('./paper');
const TR = require('./trail');
const { computeReport } = require('./paper-report');

const MISSING = /42P01|PGRST205|does not exist/;
const { T } = SES;
const DAY_CANCEL = 19 * 60 + 58;   // 이때 남은 미체결을 모두 취소 요청(20:00 마감 전)
const GRACE = 10;                  // 거래소에서 주문이 소멸한 뒤 체결조회로 마지막 체결을 받아 둘 시간(분) — KRX 정규장 15:30 → 15:40 정리
const rnd = () => Math.random().toString(36).slice(2, 6);
const isTp = o => /^tp[1-5]$/.test(String(o.reason || ''));
const LIVE = new Set(['pending', 'unknown', 'open', 'partial']);           // 아직 끝나지 않은 주문
const UNSURE = new Set(['pending', 'unknown']);                             // KIS 접수 여부를 아직 모름

function createLive(deps) {
  const now = deps.now || Date.now;
  const kis = deps.kis;
  const STOP_TICKS = deps.stopTicks || 5, STOP_RETRY_MS = (deps.stopRetrySec || 20) * 1000;
  const TRAIL_PCT = deps.tpTrail || 2;
  const route = (ses) => (ses.venue === 'SOR' && deps.noSor) ? (ses.name === 'regular' ? 'KRX' : 'NXT') : ses.venue;
  const orders = new Map(), plans = new Map(), lastPx = new Map(), cids = new Map(), warned = new Map(), lowSeen = new Map(), highSeen = new Map(), reopen = new Set();
  let fills = [];
  const bal = { positions: new Map(), cash: null, at: 0, keys: null };
  const dirty = { orders: new Map(), fills: new Map(), plans: new Map() };
  const hb = { day: '', open: false, close: false, lastTick: 0, lastSync: 0, dayCancel: false };
  let loaded = false, missing = false, ticking = false, needBal = true;

  /* ── 시간 ── */
  const kstOf = ms => { const d = new Date(ms + 9 * 3600e3); return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(), dow: d.getUTCDay() }; };
  const kst = () => kstOf(now());
  const dayStart = () => Date.parse(kst().day + 'T00:00:00+09:00');
  const fresh = q => { const h = /^(\d\d)(\d\d)(\d\d)$/.exec(String(q.hour || '')); if (!h) return false; const d = kst().sec - (+h[1] * 3600 + +h[2] * 60 + +h[3]); return d >= -5 && d <= 120; };
  async function closedReason(q) {
    const t = kst();
    if (t.dow === 0 || t.dow === 6) return '주말입니다';
    if (t.min < T.START || t.min >= T.END) return '거래 시간이 아닙니다(08:00~20:00)';
    if (deps.isOpenDay) { let o = null; try { o = await deps.isOpenDay(t.day); } catch (_) {} if (o === false) return '휴장일입니다'; }
    if (q) { const s = SES.sessionOf(t.min, q.info); if (!s.open) return s.reason; }
    if (q && !fresh(q)) return '시세가 갱신되지 않고 있습니다(휴장·지연)';
    return null;
  }
  const hhmmssToMs = (hms, base) => { const m = /^(\d\d)(\d\d)(\d\d)/.exec(String(hms || '')); return m ? Date.parse(kstOf(base).day + `T${m[1]}:${m[2]}:${m[3]}+09:00`) : null; };

  function notify(text, key) {
    if (key) { const t = warned.get(key); if (t && now() - t < 600000) return; warned.set(key, now()); }
    try { deps.alert && deps.alert(text, '실전매매'); } catch (_) {}
  }
  const W = (path, method, body) => deps.sbWrite(path, method, body);
  function event(kind, code, detail) { W('live_events', 'POST', [{ ts: new Date(now()).toISOString(), kind, code: code || null, detail: detail || null }]).catch(() => {}); }

  /* ── 행 변환 ── */
  const orderRow = o => ({
    id: o.id, created_at: new Date(o.createdAt).toISOString(), updated_at: new Date(o.updatedAt).toISOString(), code: o.code, name: o.name || null, side: o.side, type: o.type,
    price: o.price == null ? null : o.price, qty: o.qty, filled_qty: o.filled, filled_amt: o.amt || 0, avg_price: o.filled ? o.avg : null, status: o.status,
    reason: o.reason || 'manual', plan: o.plan || null, note: o.note || null, odno: o.odno || null, orgno: o.orgno || null, ref_price: o.refPrice || null,
    sim_avg: o.simAvg || null, sim_qty: o.simQty == null ? null : o.simQty, sent_at: o.sentAt ? new Date(o.sentAt).toISOString() : null, msg: o.msg || null, cancel_req: !!o.cancelReq, excg: o.excg || null,
  });
  const fromOrder = r => ({
    id: r.id, createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at), code: r.code, name: r.name, side: r.side, type: r.type, price: r.price == null ? null : +r.price,
    qty: +r.qty, filled: +r.filled_qty || 0, amt: +r.filled_amt || 0, avg: r.avg_price == null ? 0 : +r.avg_price, status: r.status, reason: r.reason, plan: r.plan, note: r.note,
    odno: r.odno, orgno: r.orgno, refPrice: r.ref_price == null ? null : +r.ref_price, simAvg: r.sim_avg == null ? null : +r.sim_avg, simQty: r.sim_qty == null ? null : +r.sim_qty,
    sentAt: r.sent_at ? Date.parse(r.sent_at) : null, msg: r.msg, cancelReq: !!r.cancel_req, excg: r.excg || null,
  });
  const fillRow = f => ({ id: f.id, ts: new Date(f.ts).toISOString(), order_id: f.orderId, code: f.code, side: f.side, price: f.price, qty: f.qty, amount: f.amount, fee: 0, realized: f.realized, reason: f.reason });
  const fromFill = r => ({ id: r.id, ts: Date.parse(r.ts), orderId: r.order_id, code: r.code, side: r.side, price: +r.price, qty: +r.qty, amount: +r.amount, fee: +r.fee || 0, realized: r.realized == null ? null : +r.realized, reason: r.reason });

  async function flush() {
    let err = null;
    for (const [id, o] of [...dirty.orders]) { try { await W('live_orders', 'POST', [orderRow(o)]); dirty.orders.delete(id); } catch (e) { err = e; } }
    if (dirty.fills.size) { const rows = [...dirty.fills.values()]; try { await W('live_fills', 'POST', rows.map(fillRow)); rows.forEach(f => dirty.fills.delete(f.id)); } catch (e) { err = e; } }
    for (const [code, p] of [...dirty.plans]) {
      try { if (p) await W('live_plans', 'POST', [{ code, name: p.name || null, plan: p.plan, updated_at: new Date(now()).toISOString() }]); else await W(`live_plans?code=eq.${code}`, 'DELETE'); dirty.plans.delete(code); } catch (e) { err = e; }
    }
    if (err) { console.warn('[live] 저장 실패(다시 시도 예정):', err.message); notify('실전매매 기록 저장에 실패했습니다. 다음 주기에 다시 시도합니다.', 'persist'); }
    return !err;
  }

  async function init() {
    if (loaded || !deps.sbGet) return loaded;
    try {
      const since = encodeURIComponent(new Date(dayStart()).toISOString());
      const [open, today, pl, fl] = await Promise.all([
        deps.sbGet('live_orders?select=*&status=in.(pending,unknown,open,partial)&limit=500'),
        deps.sbGet(`live_orders?select=*&created_at=gte.${since}&order=created_at.asc&limit=1000`),
        deps.sbGet('live_plans?select=*&limit=200'),
        deps.sbGet(`live_fills?select=*&ts=gte.${since}&order=ts.desc&limit=500`),
      ]);
      orders.clear(); plans.clear();
      for (const r of [...open, ...today]) orders.set(r.id, fromOrder(r));
      for (const r of pl) plans.set(r.code, { name: r.name, plan: r.plan });
      fills = fl.map(fromFill);
      loaded = true; missing = false; needBal = true;
      const unsure = [...orders.values()].filter(o => UNSURE.has(o.status)).length;
      console.log(`[live] 복구: 진행 중 주문 ${open.length}건(확인 필요 ${unsure}) · 계획 ${pl.length}종목 · 오늘 체결 ${fl.length}건`);
      if (unsure) notify(`relay 재시작 — 접수 확인이 필요한 실전 주문 ${unsure}건을 체결조회로 대조합니다`);
    } catch (e) { if (MISSING.test(String(e.message))) missing = true; else console.warn('[live] 불러오기 실패:', e.message); loaded = false; }
    return loaded;
  }
  let chain = Promise.resolve();
  const lock = fn => { const p = chain.then(() => fn(), () => fn()); chain = p.catch(() => {}); return p; };
  const bad = (status, error) => ({ ok: false, status, error });

  /* ── 집계 ── */
  const mine = (code, pred) => [...orders.values()].filter(o => LIVE.has(o.status) && o.code === code && (!pred || pred(o)));
  const remain = list => list.reduce((a, o) => a + (o.qty - o.filled), 0);
  const posOf = code => bal.positions.get(code) || null;
  const stopOf = (p, pl) => !pl ? null : (pl.stopPct > 0 ? E.floorTick(p.avg * (1 - pl.stopPct / 100)) : (pl.stop > 0 ? pl.stop : null));
  function dayBuyKrw() {
    const since = dayStart(); let s = 0;
    for (const o of orders.values()) if (o.side === 'buy' && o.createdAt >= since && o.status !== 'rejected') s += LIVE.has(o.status) ? (o.price || o.refPrice || 0) * (o.qty - o.filled) + o.amt : o.amt;
    return s;
  }
  const heldCodes = () => { const s = new Set(bal.positions.keys()); for (const o of orders.values()) if (LIVE.has(o.status) && o.side === 'buy') s.add(o.code); return s; };

  async function refreshBalance() {
    const b = await kis.balance();
    bal.positions = new Map(b.positions.map(p => [p.code, p])); bal.cash = b.cash; bal.at = now(); bal.keys = { row: (b.positions[0] || {})._keys || null, sum: b._keys2 };
    needBal = false;
    for (const [code, p] of plans) if (!bal.positions.has(code) && !mine(code, o => o.side === 'buy').length) { plans.delete(code); dirty.plans.set(code, null); event('plan_end', code, { why: 'no_position' }); }
  }

  /* ── 주문 내기(잠금 안). DB 먼저 → KIS → 결과 기록 ── */
  async function send({ code, name, side, type, price, qty, reason, plan, q, ref, note, venue }) {
    const sim = E.submit({ side, type, price, qty }, q), s = E.summarize(sim.fills || []);
    const t = now();
    const o = { id: `L${t.toString(36)}${rnd()}`, createdAt: t, updatedAt: t, code, name: name || null, side, type, price: type === 'limit' ? price : null, qty, filled: 0, amt: 0, avg: 0, status: 'pending',
      reason: reason || 'manual', plan: plan || null, note: note || null, odno: null, orgno: null,
      refPrice: ref || (type === 'limit' ? price : ((side === 'buy' ? q.asks : q.bids).find(l => l.p > 0) || {}).p || q.price),
      simAvg: s.qty ? s.avg : null, simQty: s.qty, sentAt: null, msg: null, cancelReq: false, excg: venue || 'KRX' };
    try { await W('live_orders', 'POST', [orderRow(o)]); } catch (e) { console.warn('[live] 주문 기록 실패 — 주문 안 냄:', e.message); return bad(503, '주문 기록을 저장하지 못해 주문을 내지 않았습니다'); }
    orders.set(o.id, o);
    o.sentAt = now();
    try {
      const r = await kis.order({ side, code, type, price, qty, venue: o.excg });
      o.odno = r.odno; o.orgno = r.orgno; o.status = 'open';
    } catch (e) {
      if (e.code === 'REJECT' || e.code === 'NOACCT') { o.status = 'rejected'; o.msg = String(e.message).slice(0, 200); }
      else { o.status = 'unknown'; o.msg = String(e.message).slice(0, 200); notify(`실전 주문 응답을 받지 못했습니다 — 체결조회로 확인합니다: ${name || code} ${side === 'buy' ? '매수' : '매도'} ${qty}주`); }
    }
    o.updatedAt = now(); dirty.orders.set(o.id, o); needBal = true;
    lastPx.set(code, { price: q.price, ts: now() });
    await flush();
    event('order', code, { id: o.id, side, type, price, qty, reason: o.reason, status: o.status, msg: o.msg });
    if (o.status === 'rejected') return { ok: false, status: 409, error: 'KIS 거부: ' + o.msg, order: pubOrder(o) };
    return { ok: true, order: o };
  }
  /* 취소 요청(잠금 안). 성공하면 cancelReq — 실제 종료는 체결조회로 확인 */
  async function cancelKis(o, note) {
    if (o.cancelReq) return true;
    if (UNSURE.has(o.status) || !o.odno) return false;
    try { await kis.cancel({ odno: o.odno, orgno: o.orgno, venue: o.excg || 'KRX' }); o.cancelReq = true; o.note = note || o.note; o.updatedAt = now(); dirty.orders.set(o.id, o); needBal = true; return true; }
    catch (e) { o.msg = String(e.message).slice(0, 200); dirty.orders.set(o.id, o); notify(`실전 주문 취소 실패(${o.msg}): ${o.name || o.code} ${o.qty}주`, 'cancelfail|' + o.id); return false; }
  }

  /* ── KIS 체결조회와 맞추기 ── */
  function applyRow(o, r) {
    if (r.filled > o.filled) {
      const dq = r.filled - o.filled, amt = r.amt > 0 ? r.amt : r.avg * r.filled, da = amt - (o.amt || 0), px = da > 0 ? da / dq : (r.avg || o.price || 0);
      const p = posOf(o.code), realized = o.side === 'sell' && p ? (px - p.avg) * dq : null;
      const f = { id: `lf${now().toString(36)}${rnd()}`, ts: now(), orderId: o.id, code: o.code, side: o.side, price: Math.round(px * 100) / 100, qty: dq, amount: da > 0 ? da : px * dq, realized, reason: o.reason || 'manual' };
      fills.unshift(f); dirty.fills.set(f.id, f);
      o.filled = r.filled; o.amt = amt; o.avg = amt / r.filled;
      const pl = plans.get(o.code);
      if (o.side === 'buy' && o.plan && !(pl && pl.plan && pl.plan.orderId === o.id)) {
        const np = { name: o.name, plan: { ...JSON.parse(JSON.stringify(o.plan)), orderId: o.id, stopped: false, steps: (o.plan.steps || []).map(s => ({ ...s, sold: 0 })) } };
        plans.set(o.code, np); dirty.plans.set(o.code, np);
      }
      if (o.side === 'sell' && isTp(o) && pl && pl.plan) { const st = (pl.plan.steps || []).find(s => 'tp' + s.n === o.reason); if (st) { st.sold = (st.sold || 0) + dq; dirty.plans.set(o.code, pl); } }
      if (isTp(o)) { notify(`[실전] 익절 ${o.reason.slice(2)}단계: ${o.name || o.code} ${dq}주 ${Math.round(px).toLocaleString('ko-KR')}원`); event('tp', o.code, { step: +o.reason.slice(2), qty: dq, price: px }); }
      else if (o.reason === 'stop') { notify(`[실전] 손절 체결: ${o.name || o.code} ${dq}주 ${Math.round(px).toLocaleString('ko-KR')}원`); event('stop_fill', o.code, { qty: dq, price: px }); }
      else notify(`[실전] ${o.side === 'buy' ? '매수' : '매도'} 체결: ${o.name || o.code} ${dq}주 ${Math.round(px).toLocaleString('ko-KR')}원`);
      needBal = true;
    }
    const prev = o.status;
    if (o.filled >= o.qty) o.status = 'filled';
    else if (r.cancelled || (r.rmn === 0 && r.qty > 0)) o.status = r.rejected > 0 && o.filled === 0 ? 'rejected' : 'cancelled';
    else o.status = o.filled > 0 ? 'partial' : 'open';
    if (o.status !== prev) needBal = true;                                                   // 취소·체결로 매도 가능 수량이 바뀜
    if (o.status !== prev || r.filled) { o.updatedAt = now(); dirty.orders.set(o.id, o); }
  }
  async function syncOrders() {
    const t = kst(), rows = await kis.dailyOrders(t.day.replace(/-/g, ''));
    hb.lastSync = now();
    const byOdno = new Map(rows.map(r => [r.odno, r])), known = new Set([...orders.values()].map(o => o.odno).filter(Boolean));
    for (const o of orders.values()) {
      if (o.status === 'unknown' || (o.status === 'pending' && o.sentAt && now() - o.sentAt > 15000)) {
        // 응답을 못 받은 주문: 같은 종목·방향·수량, 보낸 시각 이후 접수된 주문 중 아직 우리 것이 아닌 것을 찾아 대조
        const sentMs = o.sentAt || o.createdAt;
        const cand = rows.find(r => !known.has(r.odno) && r.code === o.code && r.side === o.side && r.qty === o.qty && (hhmmssToMs(r.tmd, sentMs) || 0) >= sentMs - 5000);
        if (cand) { o.odno = cand.odno; known.add(cand.odno); o.status = 'open'; o.msg = (o.msg ? o.msg + ' · ' : '') + '체결조회로 접수 확인'; dirty.orders.set(o.id, o); event('reconcile', o.code, { id: o.id, found: true }); notify(`[실전] 응답 없던 주문이 접수된 것으로 확인됐습니다: ${o.name || o.code}`); }
        else if (now() - sentMs > 60000) { o.status = 'rejected'; o.note = 'not_found'; o.msg = (o.msg ? o.msg + ' · ' : '') + '60초 동안 체결조회에 없음 — 접수 안 된 것으로 처리'; dirty.orders.set(o.id, o); event('reconcile', o.code, { id: o.id, found: false }); notify(`[실전] 응답 없던 주문이 접수되지 않은 것으로 보입니다(60초 확인): ${o.name || o.code}. HTS 에서 한 번 확인해 주세요`); }
        continue;
      }
      if (!LIVE.has(o.status) || !o.odno) continue;
      const r = byOdno.get(o.odno);
      if (r) applyRow(o, r);
    }
  }
  /* 소멸 처리: 지난 날짜 주문 · 거래소 소멸 시각(KRX 정규장 15:30, 그 밖 20:00)에서 체결조회 정리 시간이 지난 주문 */
  function expireOld() {
    const t = kst(), d0 = dayStart();
    for (const o of orders.values()) {
      if (!(o.status === 'open' || o.status === 'partial')) continue;
      const e = SES.expiryOf(o.excg || 'KRX', kstOf(o.createdAt).min), until = e >= T.END ? T.SETTLE : e + GRACE;
      if (o.createdAt < d0 || t.min >= until) { o.status = 'cancelled'; o.note = 'expired'; o.updatedAt = now(); dirty.orders.set(o.id, o); needBal = true; if (isTp(o)) reopen.add(o.code); }
    }
  }

  /* ── 자동 매도(잠금 안, 종목별) ── */
  async function stopCheck(code, q) {
    const p = posOf(code), pl = plans.get(code);
    if (!p || !pl || !pl.plan) return false;
    const sp = stopOf(p, pl.plan), prevLow = lowSeen.get(code);
    const newLow = q.low > 0 && prevLow != null && q.low < prevLow;
    if (q.low > 0) lowSeen.set(code, prevLow == null ? q.low : Math.min(prevLow, q.low));
    const hit = !!sp && (q.price <= sp || (newLow && q.low <= sp));
    if (!hit && !pl.plan.stopped) return false;                                             // 손절이 시작되면 가격이 돌아와도 남은 수량을 끝까지 팜
    if (q.vi) { notify(`[실전] 손절 조건이지만 VI 발동 중이라 대기: ${p.name || code}`, 'vi|' + code); return true; }
    const ses = SES.sessionOf(kst().min, q.info);
    const stops = mine(code, o => o.reason === 'stop');
    if (stops.length) {                                                                      // 손절 주문이 이미 진행 중
      // 시간외 지정가 손절이 정해진 시간 안에 다 안 팔렸으면 취소 요청 → 취소가 체결조회로 확인된 다음 주기에 지금 호가로 다시 냄
      for (const o of stops) if (o.type === 'limit' && !o.cancelReq && !UNSURE.has(o.status) && now() - (o.sentAt || o.createdAt) >= STOP_RETRY_MS) await cancelKis(o, 'stop_retry');
      return true;
    }
    if (mine(code, o => UNSURE.has(o.status)).length) { notify(`[실전] 손절 조건 — 확인 중인 주문이 있어 대조 후 매도합니다: ${p.name || code}`, 'stopwait|' + code); return true; }
    const sells = mine(code, o => o.side === 'sell');
    let failed = 0;
    for (const o of sells) if (!(await cancelKis(o, 'stop'))) failed += o.qty - o.filled;
    let sellable = p.qty - failed;
    try { await refreshBalance(); const fp = posOf(code); sellable = fp ? Math.min(fp.sellable, fp.qty - failed) : 0; } catch (_) { /* 잔고를 못 읽으면 보수적으로 앞의 값 */ }
    if (sellable <= 0) { if (failed) notify(`[실전] 손절: 취소 실패한 매도 주문이 남아 추가 매도하지 않았습니다: ${p.name || code}`, 'stopblocked|' + code); return true; }
    const type = ses.market ? 'market' : 'limit', price = ses.market ? null : SES.stopLimitPrice(q, STOP_TICKS, E.tickOf, E.floorTick);
    const first = !pl.plan.stopped;
    const r = await send({ code, name: p.name, side: 'sell', type, price, qty: sellable, reason: 'stop', q, ref: sp || q.price, venue: route(ses), note: first ? null : 'retry' });
    if (!r.ok) notify(`[실전] 손절 매도 실패(${r.error}) — 다음 주기에 다시 시도: ${p.name || code}`, 'stopfail|' + code);
    else {
      pl.plan.stopped = true; dirty.plans.set(code, pl);
      notify(`[실전] 손절 주문: ${p.name || code} ${sellable}주 ${type === 'market' ? '시장가' : `${price.toLocaleString('ko-KR')}원 지정가(${ses.label})`} (손절가 ${(sp || 0).toLocaleString('ko-KR')}원)`, first ? null : 'stopretry|' + code);
      if (first) event('stop', code, { stop: sp, price: q.price, qty: sellable, type, limit: price, session: ses.name, venue: route(ses) });
    }
    return true;
  }
  /* 익절(트레일링, 2026-11-13): 주문을 미리 걸지 않고 감시 — 익절가 도달 후 고점 대비 trail% 내리면 그 단계 수량을 매도 */
  async function syncTp(code, q) {
    const p = posOf(code), pl = plans.get(code), tps = mine(code, o => o.side === 'sell' && isTp(o));
    if (mine(code, o => UNSURE.has(o.status) || o.cancelReq).length) return;            // 확인 중이거나 취소 확인 대기 중이면 다음 주기에
    if (!p || !pl || !pl.plan || pl.plan.stopped || !(pl.plan.steps || []).length) { for (const o of tps) await cancelKis(o, 'no_plan'); return; }
    const prevHi = highSeen.get(code), newHigh = q.high > 0 && prevHi != null && q.high > prevHi ? q.high : 0;
    if (q.high > 0) highSeen.set(code, prevHi == null ? q.high : Math.max(prevHi, q.high));
    let old = false;
    for (const o of tps) if (o.note !== 'trail') { await cancelKis(o, 'to_trail'); old = true; }   // 예전 방식(미리 걸어 둔 지정가) 익절 주문 정리
    if (old) return;
    const ses = SES.sessionOf(kst().min, q.info);
    if (!ses.open) return;
    const trail = pl.plan.trail > 0 ? pl.plan.trail : TRAIL_PCT;
    const avail = Math.min(p.qty - remain(mine(code, o => o.side === 'sell' && !isTp(o))), p.sellable + remain(tps));
    const want = allocSteps(pl.plan.steps, Math.max(0, avail));
    let changed = false;
    for (const st of pl.plan.steps.slice().sort((a, b) => a.n - b.n)) {
      const w = want[st.n] || 0;
      if (w <= 0) continue;
      const u = TR.trailUpdate(st, q.price, newHigh, trail);
      if (u.changed) changed = true;
      if (u.armedNow) { event('tp_arm', code, { step: st.n, price: q.price, tp: st.p, trail }); notify(`[실전] 익절 ${st.n}단계 감시 시작: ${p.name || code} 익절가 ${st.p.toLocaleString('ko-KR')}원 도달 — 고점 대비 -${trail}%에서 매도`, `tparm|${code}|${st.n}`); }
      if (!u.fire) continue;
      const my = tps.filter(o => o.reason === 'tp' + st.n);
      if (my.length) {                                                                      // 이미 매도 진행 중 — 시간외 지정가가 오래 안 팔리면 취소 → 확인 후 다음 주기에 다시 냄
        for (const o of my) if (o.type === 'limit' && !o.cancelReq && !UNSURE.has(o.status) && now() - (o.sentAt || o.createdAt) >= STOP_RETRY_MS) await cancelKis(o, 'tp_retry');
        continue;
      }
      if (q.vi) { notify(`[실전] 익절 조건이지만 VI 발동 중이라 대기: ${p.name || code}`, 'vi|' + code); continue; }
      const type = ses.market ? 'market' : 'limit', price = ses.market ? null : SES.stopLimitPrice(q, STOP_TICKS, E.tickOf, E.floorTick);
      const r = await send({ code, name: p.name, side: 'sell', type, price, qty: w, reason: 'tp' + st.n, q, ref: st.p, venue: route(ses), note: 'trail' });
      if (!r.ok) notify(`[실전] 익절 ${st.n}단계 매도 실패(${r.error}) — 다음 주기에 다시 시도: ${p.name || code}`, `tpfail|${code}|${st.n}`);
      else { notify(`[실전] 익절 ${st.n}단계(트레일링) 주문: ${p.name || code} ${w}주 ${type === 'market' ? '시장가' : `${price.toLocaleString('ko-KR')}원 지정가(${ses.label})`} · 고점 ${Math.round(st.peak).toLocaleString('ko-KR')}원`); event('tp_fire', code, { step: st.n, qty: w, peak: st.peak, trail, type, limit: price }); }
    }
    if (changed) dirty.plans.set(code, pl);
    reopen.delete(code);
  }

  /* ── 사람이 내는 주문 ── */
  function cleanPlan(p) {
    if (!p || typeof p !== 'object') return null;
    const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
    const steps = Array.isArray(p.steps) ? p.steps.slice(0, 5).map(s => ({ n: Math.floor(num(s && s.n, 1, 5) || 0), p: num(s && s.p, 1, 1e8), q: Math.floor(num(s && s.q, 1, 1e7) || 0) })).filter(s => s.n && s.p && s.q && E.validTick(s.p)) : [];
    const seen = new Set(), uniq = steps.filter(s => !seen.has(s.n) && seen.add(s.n));
    const stop = num(p.stop, 1, 1e8);
    return { stopPct: num(p.stopPct, 0.1, 50), stop: stop ? E.floorTick(stop) : null, target: num(p.target, 1, 1e8), trail: num(p.trail, 0.3, 20), steps: uniq };
  }
  const ready = async () => { if (!(await init())) return bad(503, missing ? 'live tables missing' : 'live store unavailable'); if (!kis.configured()) return bad(503, 'account not configured'); return null; };
  async function place(body) {
    const nr = await ready(); if (nr) return nr;
    const code = String(body.code || ''), side = body.side, type = body.type, qty = Number(body.qty);
    if (!/^\d{6}$/.test(code)) return bad(400, 'bad code');
    if (side !== 'buy' && side !== 'sell') return bad(400, 'bad side');
    if (type !== 'limit' && type !== 'market') return bad(400, 'bad type');
    if (!Number.isInteger(qty) || qty < 1 || qty > 1e6) return bad(400, 'bad qty');
    const price = type === 'limit' ? Number(body.price) : null;
    if (type === 'limit' && !E.validTick(price)) return bad(400, '호가 단위에 맞지 않는 가격입니다');
    const cid = /^[A-Za-z0-9_-]{8,40}$/.test(String(body.cid || '')) ? String(body.cid) : null;
    if (cid && cids.has(cid)) { const c = cids.get(cid); return c.p ? c.p : { ...c.r, duplicate: true }; }
    const g = deps.guard(side, 'REAL'); if (!g.ok) return bad(403, g.error);
    const run = (async () => {
      let q; try { q = await deps.getQuote(code); } catch (_) { return bad(502, '시세를 가져오지 못했습니다'); }
      const closed = await closedReason(q); if (closed) return bad(409, closed);
      const ses = SES.sessionOf(kst().min, q.info);
      if (type === 'market' && !ses.market) return bad(409, `${ses.label}에는 시장가 주문을 낼 수 없습니다(지정가만)`);
      if (kst().min >= DAY_CANCEL) return bad(409, '19:58 이후에는 새 주문을 받지 않습니다(20:00 마감 정리 중)');
      if (q.vi) return bad(409, 'VI 발동 중에는 주문할 수 없습니다');
      if ((q.warnings || []).includes('거래정지')) return bad(409, '거래정지 종목입니다');
      if (type === 'limit' && ((q.upper > 0 && price > q.upper) || (q.lower > 0 && price < q.lower))) return bad(400, '상·하한가 범위를 벗어났습니다');
      const name = String(body.name || '').slice(0, 40) || null;
      return lock(async () => {
        if (mine(code, o => UNSURE.has(o.status)).length) return bad(409, '이 종목에 접수 확인 중인 주문이 있습니다. 잠시 뒤 다시 시도하세요');
        if (side === 'sell') {
          try { await refreshBalance(); } catch (e) { return bad(502, '잔고를 확인하지 못했습니다'); }
          const p = posOf(code);
          for (const o of mine(code, o => o.side === 'sell' && isTp(o))) if (!(await cancelKis(o, 'manual_sell'))) return bad(409, '걸려 있는 익절 주문을 취소하지 못했습니다. 잠시 뒤 다시 시도하세요');
          const tpLeft = remain(mine(code, o => o.side === 'sell' && isTp(o)));            // 방금 취소 요청한 익절분(아직 확인 전)
          const avail = p ? Math.min(p.sellable + tpLeft, p.qty) - remain(mine(code, o => o.side === 'sell' && !isTp(o))) : 0;
          if (qty > avail) return bad(400, `매도 가능 수량 부족 (가능 ${Math.max(0, avail)}주)`);
        } else {
          const ref = type === 'limit' ? price : ((q.asks.find(l => l.p > 0) || {}).p || q.price);
          const lim = deps.checkLimits({ mode: 'REAL', orderKrw: ref * qty, dayKrw: dayBuyKrw(), positions: heldCodes().size, isNewPosition: !heldCodes().has(code) });
          if (!lim.ok) return bad(403, lim.error);
        }
        const r = await send({ code, name, side, type, price, qty, reason: 'manual', plan: side === 'buy' ? cleanPlan(body.plan) : null, q, venue: route(ses) });
        if (!r.ok) return r;
        return { ok: true, order: pubOrder(r.order), pending: r.order.status !== 'open' };
      });
    })();
    if (cid) { cids.set(cid, { p: run }); if (cids.size > 500) cids.delete(cids.keys().next().value); }
    const res = await run;
    if (cid) { if (res.ok) cids.set(cid, { r: res }); else cids.delete(cid); }
    return res;
  }
  function cancel(id) {
    return lock(async () => {
      const nr = await ready(); if (nr) return nr;
      const o = orders.get(String(id || ''));
      if (!o) return bad(404, '주문을 찾을 수 없습니다');
      if (!LIVE.has(o.status)) return bad(409, '이미 끝난 주문입니다');
      if (isTp(o) || o.reason === 'stop') return bad(409, '자동 매도 주문은 보유 종목의 계획 수정으로 바꾸세요');
      if (UNSURE.has(o.status)) return bad(409, '접수 확인 중인 주문입니다. 잠시 뒤 다시 시도하세요');
      if (!(await cancelKis(o, 'user'))) return bad(502, '취소 요청이 실패했습니다: ' + (o.msg || ''));
      await flush();
      return { ok: true, order: pubOrder(o) };
    });
  }
  /* 정정: KIS 정정(TTTC0013U·01) — 새 주문번호로 새 주문 기록을 만들고 원주문은 체결조회에서 잔량 0 으로 끝남 */
  function modify(body) {
    return lock(async () => {
      const nr = await ready(); if (nr) return nr;
      const o = orders.get(String(body.id || ''));
      if (!o) return bad(404, '주문을 찾을 수 없습니다');
      if (!LIVE.has(o.status) || o.cancelReq) return bad(409, '이미 끝났거나 취소 중인 주문입니다');
      if (isTp(o) || o.reason === 'stop') return bad(409, '자동 매도 주문은 매도 계획에서 바꾸세요');
      if (UNSURE.has(o.status) || !o.odno) return bad(409, '접수 확인 중인 주문입니다. 잠시 뒤 다시 시도하세요');
      const left = o.qty - o.filled, price = Number(body.price), qty = body.qty == null || body.qty === '' ? left : Number(body.qty);
      if (!E.validTick(price)) return bad(400, '호가 단위에 맞지 않는 가격입니다');
      if (!Number.isInteger(qty) || qty < 1 || qty > left) return bad(400, `정정 수량은 1~${left}주입니다`);
      const g = deps.guard(o.side, 'REAL'); if (!g.ok) return bad(403, g.error);
      let r;
      try { r = await kis.modify({ odno: o.odno, orgno: o.orgno, venue: o.excg || 'KRX', price, qty, all: qty === left }); }
      catch (e) { return bad(e.code === 'REJECT' ? 409 : 502, '정정 실패: ' + String(e.message).slice(0, 200)); }
      const t = now();
      if (qty === left) { o.cancelReq = true; o.note = 'modified'; }
      else { o.note = 'modified_part'; o.qty -= qty; }                                     // 일부 정정: 원주문엔 나머지 잔량만 남음
      o.updatedAt = t; dirty.orders.set(o.id, o);
      const n = { id: `L${t.toString(36)}${rnd()}`, createdAt: t, updatedAt: t, code: o.code, name: o.name, side: o.side, type: 'limit', price, qty, filled: 0, amt: 0, avg: 0, status: 'open',
        reason: o.reason || 'manual', plan: o.plan || null, note: 'modify:' + o.id, odno: r.odno, orgno: r.orgno, refPrice: price, simAvg: null, simQty: null, sentAt: t, msg: null, cancelReq: false, excg: o.excg || 'KRX' };
      orders.set(n.id, n); dirty.orders.set(n.id, n); needBal = true;
      await flush();
      event('modify', o.code, { from: o.id, id: n.id, price, qty });
      return { ok: true, order: pubOrder(n), from: o.id };
    });
  }
  function editPlan(body) {
    return lock(async () => {
      const nr = await ready(); if (nr) return nr;
      const code = String(body.code || '');
      try { await refreshBalance(); } catch (_) { return bad(502, '잔고를 확인하지 못했습니다'); }
      const p = posOf(code);
      if (!p) return bad(404, '보유하지 않은 종목입니다');
      const pl = cleanPlan(body);
      const noStop = !pl.stopPct && !pl.stop;   // 2026-11-13: 손절만·익절만 저장 허용, 둘 다 없으면 계획 해제
      const avail = p.qty - remain(mine(code, o => o.side === 'sell' && !isTp(o)));
      const sum = pl.steps.reduce((a, s) => a + s.q, 0);
      // 단계 수량은 비중 — 실제 걸 수량은 allocSteps 가 매도 가능 수량 전체를 이 비중대로 나눔(단계를 지우면 남은 단계가 그 수량을 나눠 가짐)
      if (pl.steps.some(s => s.p <= p.avg * 0.5)) return bad(400, '익절 가격이 너무 낮습니다');
      for (const o of mine(code, o => o.side === 'sell' && isTp(o))) if (!(await cancelKis(o, 'plan_edit'))) return bad(409, '걸려 있는 익절 주문을 취소하지 못했습니다');
      const prev = plans.get(code);
      const np = { name: p.name, plan: { ...pl, steps: TR.keepTrail(prev && prev.plan && prev.plan.steps, pl.steps.map(s => ({ ...s, sold: 0 }))), orderId: prev && prev.plan && prev.plan.orderId || null, stopped: false } };
      if (noStop && !pl.steps.length) { plans.delete(code); dirty.plans.set(code, null); } else { plans.set(code, np); dirty.plans.set(code, np); }
      await flush();
      event('plan_edit', code, { stop: stopOf(p, np.plan), steps: pl.steps.length });
      return { ok: true, position: pubPos(p) };
    });
  }

  /* ── 조회 ── */
  const pubOrder = o => ({ id: o.id, ts: o.createdAt, code: o.code, name: o.name, side: o.side, type: o.type, price: o.price, qty: o.qty, filled: o.filled, avg: o.filled ? o.avg : null,
    status: o.status, queueAhead: null, reason: o.reason, note: o.note, msg: o.msg, cancelReq: o.cancelReq, simAvg: o.simAvg, venue: o.excg || null });
  const pubFill = f => ({ id: f.id, ts: f.ts, orderId: f.orderId, code: f.code, side: f.side, price: f.price, qty: f.qty, amount: f.amount, fee: 0, realized: f.realized, reason: f.reason });
  const pubPos = p => { const pl = plans.get(p.code); return { code: p.code, name: p.name, qty: p.qty, avg: p.avg, plan: pl ? pl.plan : null, stop: stopOf(p, pl && pl.plan),
    last: (lastPx.get(p.code) || {}).price || p.price || null, avail: p.qty - remain(mine(p.code, o => o.side === 'sell' && !isTp(o))), sellable: p.sellable }; };
  async function state() {
    const nr = await ready();
    if (nr && nr.error !== 'account not configured') return nr;
    if (nr) return { ok: true, now: now(), account: false, market: { open: false, reason: 'account not configured' }, engine: { enabled: false }, positions: [], orders: [], fills: [], dayBuyKrw: 0, realizedToday: 0, limits: deps.limits };
    if (!bal.at || now() - bal.at > 30000) { try { await lock(refreshBalance); } catch (e) { return bad(502, '잔고를 조회하지 못했습니다: ' + e.message); } }
    const since = dayStart();
    const list = [...orders.values()].filter(o => LIVE.has(o.status) || o.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80);
    const tf = fills.filter(f => f.ts >= since), reason = await closedReason(null);
    return { ok: true, now: now(), account: true, real: true, cash: bal.cash, balanceAt: bal.at, market: { open: !reason, reason },
      engine: { lastTick: hb.lastTick || null, lastSync: hb.lastSync || null, enabled: !!deps.enabled(), running: !!timer },
      positions: [...bal.positions.values()].map(pubPos), orders: list.map(pubOrder), fills: tf.slice(0, 80).map(pubFill),
      dayBuyKrw: Math.round(dayBuyKrw()), realizedToday: Math.round(tf.reduce((a, f) => a + (f.realized || 0), 0)), limits: deps.limits };
  }
  /* 계좌 연결 점검: 잔고·체결조회 응답의 필드 이름과 건수만(값은 보내지 않음) */
  async function probe() {
    if (!kis.configured()) return { ok: true, configured: false };
    const out = { ok: true, configured: true };
    try { const b = await kis.balance(); out.balance = { ok: true, positions: b.positions.length, rowKeys: (b.positions[0] || {})._keys || null, sumKeys: b._keys2 }; } catch (e) { out.balance = { ok: false, error: e.message }; }
    try { const r = await kis.dailyOrders(kst().day.replace(/-/g, '')); out.daily = { ok: true, rows: r.length, rowKeys: (r[0] || {})._keys || null }; } catch (e) { out.daily = { ok: false, error: e.message }; }
    return out;
  }
  async function report(from, to) {
    const nr = await ready(); if (nr) return nr;
    const D = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !D.test(from)) || (to && !D.test(to))) return bad(400, 'bad date');
    try {
      const [fl, od] = await Promise.all([deps.sbGet('live_fills?select=*&order=ts.asc&limit=20000'), deps.sbGet('live_orders?select=*&order=created_at.desc&limit=5000')]);
      const all = od.map(fromOrder);
      const pos = [...bal.positions.values()].map(p => ({ code: p.code, name: p.name, qty: p.qty, avg: p.avg, last: (lastPx.get(p.code) || {}).price || p.price || null }));
      const r = computeReport({ fills: fl.map(fromFill), orders: all, positions: pos, from, to });
      // 가상 대비 차이: 같은 순간 호가로 계산한 가상 체결가(sim_avg)와 실제 평균 체결가
      const inR = ms => { const d = new Date(ms + 9 * 3600e3).toISOString().slice(0, 10); return (!from || d >= from) && (!to || d <= to); };
      const cmp = all.filter(o => inR(o.createdAt) && o.filled > 0 && o.simAvg > 0 && (o.type === 'market' || o.reason === 'stop'))
        .map(o => ({ id: o.id, code: o.code, side: o.side, real: o.avg, sim: o.simAvg, diffPct: Math.round((o.side === 'buy' ? (o.avg - o.simAvg) : (o.simAvg - o.avg)) / o.simAvg * 10000) / 100 }));
      r.shadow = { orders: cmp.length, avgDiffPct: cmp.length ? Math.round(cmp.reduce((a, x) => a + x.diffPct, 0) / cmp.length * 100) / 100 : null, rows: cmp.slice(0, 50) };
      return r;
    } catch (e) { return bad(502, '리포트를 만들지 못했습니다'); }
  }

  /* ── 루프 ── */
  async function tick() {
    if (ticking || !deps.enabled() || !kis.configured()) return;
    ticking = true;
    try {
      if (!(await init())) return;
      const t = kst();
      await lock(async () => { expireOld(); if (dirty.orders.size || dirty.fills.size || dirty.plans.size) await flush(); });
      if (hb.day !== t.day) { hb.day = t.day; hb.open = false; hb.close = false; hb.dayCancel = false; lowSeen.clear(); highSeen.clear(); }
      if (t.dow === 0 || t.dow === 6 || t.min < T.START) return;
      if (t.min >= T.END) {
        if (t.min < T.SETTLE && [...orders.values()].some(o => LIVE.has(o.status))) {
          await lock(async () => {   // 20:00 마감 직후: 마지막 체결을 받아 둠(자동 매도는 하지 않음). 20:05 에 남은 주문은 소멸 처리
            try { await syncOrders(); if (needBal) await refreshBalance(); } catch (e) { notify(`[실전] 마감 후 체결조회 실패: ${e.message}`, 'syncfail'); }
            await flush();
          });
        }
        if (t.min >= T.SETTLE && hb.open && !hb.close) { hb.close = true; const tf = fills.filter(f => f.ts >= dayStart()); notify(`[실전] 마감(20:00): 오늘 체결 ${tf.length}건 · 실현손익 ${Math.round(tf.reduce((a, f) => a + (f.realized || 0), 0)).toLocaleString('ko-KR')}원`); }
        return;
      }
      if (deps.isOpenDay) { let od = null; try { od = await deps.isOpenDay(t.day); } catch (_) {} if (od === false) return; }
      hb.lastTick = now();
      await lock(async () => {
        try { if ([...orders.values()].some(o => LIVE.has(o.status))) await syncOrders(); } catch (e) { notify(`[실전] 체결조회 실패: ${e.message}`, 'syncfail'); }
        try { if (needBal || now() - bal.at > 30000) await refreshBalance(); } catch (e) { notify(`[실전] 잔고 조회 실패: ${e.message}`, 'balfail'); }
        if (t.min >= DAY_CANCEL && !hb.dayCancel) {                                         // 19:58: 남은 미체결을 모두 취소 요청(자동·수동 모두)
          hb.dayCancel = true; let n = 0;
          for (const o of orders.values()) if ((o.status === 'open' || o.status === 'partial') && !o.cancelReq) { if (await cancelKis(o, 'day_end')) n++; }
          if (n) { notify(`[실전] 20:00 마감 전 미체결 ${n}건을 취소했습니다`); event('day_end_cancel', null, { n }); }
        }
        await flush();
      });
      if (t.min >= DAY_CANCEL) return;                                                       // 마감 정리 중에는 새 자동 매도 주문을 내지 않음
      const planned = [...plans.keys()].filter(c => bal.positions.has(c));
      if (!hb.open) { hb.open = true; if (planned.length) notify(`[실전] 자동 매도 감시 시작 — 보유 ${planned.length}종목`); }
      for (const code of planned) {
        let q; try { q = await deps.getQuote(code); } catch (_) { notify(`[실전] 시세 조회 실패로 감시가 멈춰 있습니다: ${code}`, 'quotefail|' + code); continue; }
        if (await closedReason(q)) continue;
        lastPx.set(code, { price: q.price, ts: now() });
        await lock(async () => { const stopped = await stopCheck(code, q); if (!stopped) await syncTp(code, q); await flush(); });
      }
    } catch (e) { console.warn('[live] 루프 오류:', e.message); }
    finally { ticking = false; }
  }
  let timer = null;
  function start(ms = 5000) { if (timer) return; timer = setInterval(() => { tick(); }, ms); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { place, cancel, modify, editPlan, state, report, probe, tick, start, stop, init, heldCodes: () => heldCodes(), _orders: orders, _plans: plans, _bal: bal };
}

module.exports = { createLive };
