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
const LOG = require('./auto-log');
const SZ = require('./auto-size');
const TICKS = [[2000, 1], [5000, 5], [20000, 10], [50000, 50], [200000, 100], [500000, 500]];
const EOK = 1e8;
const tickOf = p => { for (const [lim, t] of TICKS) if (p < lim) return t; return 1000; };
const floorTick = p => { const t = tickOf(p); return Math.floor(p / t + 1e-9) * t; };
const ceilTick = p => { const t = tickOf(p); return Math.ceil(p / t - 1e-9) * t; };
const below = p => { let f = floorTick(p); if (f >= p - 1e-9) f -= tickOf(f - 1); return f; };

const PROFILE_DOWN = 0.30, PROFILE_UP = 0.70;
const DEF = Object.freeze({ stopPct: 5, rr: 3, minRr: 0, tpStyle: 'even', runnerPct: 20, ratchet: false, trail: 2, split: 5, minPct: 3, coef: 1, recheckPct: 1.5, openRiseMax: 8, cttrMin: 100, fillWaitMs: 180e3, cancelWaitMs: 180e3, repriceTo: 'bid1', smartBuy: false, smartCttr: 120, smartRise: 2, q1GapPct: 0.8, chaseAsk: false, chasePct: 1, chaseWaitMs: 180e3, rrSlack: 10, unfilledEnd: 'cancel', intentLostMs: 60e3 });
const REPRICE_KO = { bid1: '최우선 매수 호가', ask1: '최우선 매도 호가(바로 체결)', none: '정정하지 않음' };

/* 주문 시점 스냅샷(F1): 호가·시가·재확인 수치 — 화면·일지에서 '왜 이 가격에 샀는지/못 샀는지' 복기용 */
function snapOf(q, notice, opt = {}) {
  const o = { ...DEF, ...opt }, lv = a => (a || []).filter(x => x && x.p > 0).slice(0, 10).map(x => ({ p: x.p, q: x.q }));
  if (!q) return null;
  const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
  return { price: q.price || null, open: q.open || null, high: q.high || null, low: q.low || null, upper: q.upper || null, lower: q.lower || null, prevClose: q.prevClose || null,
    bids: lv(q.bids), asks: lv(q.asks), notice: (notice && notice.price) || null,
    checks: { cttr: { v: q.strength == null ? null : r2(q.strength), min: o.cttrMin }, move: { v: notice && notice.price > 0 && q.price > 0 ? r2((q.price / notice.price - 1) * 100) : null, max: o.recheckPct },
      openRise: { v: q.open > 0 && q.price > 0 ? r2((q.price / q.open - 1) * 100) : null, max: o.openRiseMax }, vi: !!q.vi } };
}

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
  let target = null, mode, topLo = null, topV = null, rrT = null, clipped = false;
  if (rest.length) {
    const top = ri < 0 ? rest[0] : rest.reduce((m, b) => (b.v > m.v ? b : m), rest[0]);
    mode = ri < 0 ? 'blocked' : 'normal';
    target = below(top.lo); topLo = top.lo; topV = top.v;
  } else {
    mode = 'no-supply';
    rrT = cur > 0 && stopPct > 0 && rr > 0 ? floorTick(cur * (1 + stopPct / 100 * rr)) : null;
    target = Math.max(prevHigh > cur ? floorTick(prevHigh) : 0, rrT || 0) || null;
  }
  if (target != null && upper > 0 && target > upper) { target = floorTick(upper); clipped = true; }
  if (target != null && target <= cur) { target = null; mode += '-none'; }
  return { target, mode, cap, cum, topLo, topV, rrT, clipped, prevHigh: prevHigh > 0 ? prevHigh : null, nAbove: above.length };
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
/* 새 익절 단계(2026-11-16): 코어 = +1R(손절폭만큼, 기본 +5%) · 중간(최대 +2R) · 목표가를 25/25/50 비중으로, 러너 = runnerPct% 는 목표가에 닿은 뒤 스윙형 트레일링만으로.
   1단계에서 손절선이 본전으로 올라가므로(ratchet) 그 뒤로는 손실이 날 수 없다. 단계 q 는 비중(실제 수량은 매도 엔진이 나눔) */
function splitPlanR(buy, target, qty, { stopPct = 5, runnerPct = 20, weights = [25, 25, 50] } = {}) {
  qty = Math.floor(qty);
  if (!(buy > 0) || !(target > buy) || qty < 1) return { steps: [] };
  const p1 = Math.min(ceilTick(buy * (1 + stopPct / 100)), target);
  let p2 = floorTick(Math.min((p1 + target) / 2, buy * (1 + 2 * stopPct / 100)));
  const prices = [p1]; if (p2 > p1 && p2 < target) prices.push(p2); if (target > p1) prices.push(target);
  const runQ = qty >= 5 ? Math.floor(qty * Math.min(50, Math.max(0, runnerPct)) / 100) : 0, coreQ = qty - runQ;
  let w = prices.length === 3 ? weights.slice(0, 3) : prices.length === 2 ? [weights[0] + weights[1], weights[2]] : [100];
  const W = w.reduce((a, x) => a + x, 0), quota = w.map(x => coreQ * x / W), q = quota.map(Math.floor);
  let left = coreQ - q.reduce((a, x) => a + x, 0);
  quota.map((x, i) => i).sort((a, b) => (quota[b] - q[b]) - (quota[a] - q[a]) || a - b).forEach(i => { if (left > 0) { q[i]++; left--; } });
  const steps = []; prices.forEach((p, i) => { if (q[i] > 0) steps.push({ n: 0, p, q: q[i] }); });
  if (runQ > 0) steps.push({ n: 0, p: target, q: runQ, runner: true });
  steps.forEach((x, i) => { x.n = i + 1; });
  return { steps };
}


/* 이미 들고 있는 종목의 매도 계획을 평균 매수가 기준으로 새로 계산(종가베팅 저녁 매수 종목을 장중 전략으로 전환할 때) */
function planFromAvg({ q, rows, avg, qty, opt = {} }) {
  const o = { ...DEF, ...opt };
  const last5 = (rows || []).slice(-5), avg5 = last5.length ? last5.reduce((a, r) => a + (+r.trade_amount || 0), 0) / last5.length : 0;
  const capEok = Math.max(avg5, (q && q.amt) || 0) / EOK;
  const prevHigh = rows && rows.length ? Math.max(...rows.map(r => (+r.high > 0 ? +r.high : +r.close))) : 0;
  const tgt = calcTarget({ cur: avg, prof: buildProfile(rows || []), capEok, coef: o.coef, prevHigh, upper: q && q.upper, stopPct: o.stopPct, rr: o.rr });
  const steps = tgt.target ? (o.tpStyle === 'r' ? splitPlanR(avg, tgt.target, qty, { stopPct: o.stopPct, runnerPct: o.runnerPct }) : splitPlan(avg, tgt.target, qty, o.split, o.minPct)).steps.filter(s => s.q > 0) : [];
  return { stopPct: o.stopPct, target: tgt.target || null, steps: steps.map(s => ({ n: s.n, p: s.p, q: s.q, ...(s.runner ? { runner: true } : {}) })), ratchet: o.ratchet ? { floorPct: 0.35 } : null };
}

/* 매수 주문 내용 계산: 시세(q) + 일봉(rows) → 가격·수량·계획 */
function makeOrder({ q, rows, perStockKrw, opt = {}, force = null }) {   // force = {buy, qty}: 사용자가 가격·수량을 직접 정한 경우 계획만 다시 계산
  const o = { ...DEF, ...opt };
  const cur = q.price > 0 ? q.price : +(rows[rows.length - 1] || {}).close;
  const rec = recBids(q.bids, cur);
  const bid1 = (q.bids || []).filter(b => b.p > 0 && b.q > 0).reduce((m, b) => (!m || b.p > m.p ? b : m), null);   // 최우선 매수 호가
  let pick = (o.buyPick === 'low' ? rec.find(r => r.k === 'low') : o.buyPick === 'bid1' ? (bid1 && { k: 'bid1', p: bid1.p }) : rec[0]) || null;
  /* 강세 종목 보정(smartBuy): 잔량 최다 호가(q1)는 현재가보다 아래라 오르는 종목은 안 와서 체결이 안 됨 → 강세이거나 q1이 현재가보다 q1GapPct 넘게 낮으면 최우선 매수 호가부터 */
  let smartWhy = null;
  if (o.buyPick !== 'low' && o.buyPick !== 'bid1' && o.smartBuy && !force && rec[0] && bid1 && bid1.p > rec[0].p && cur > 0) {
    const gap = (cur - rec[0].p) / cur * 100, rise = q.open > 0 ? (cur / q.open - 1) * 100 : null;
    const strongC = q.strength != null && q.strength >= o.smartCttr, strongR = rise != null && rise >= o.smartRise;
    if (strongC || strongR) smartWhy = `강세(${[strongC ? `체결강도 ${Math.round(q.strength)}%` : '', strongR ? `시가 대비 +${rise.toFixed(1)}%` : ''].filter(Boolean).join(' · ')})`;
    else if (gap > o.q1GapPct) smartWhy = `잔량 최다 호가가 현재가보다 ${gap.toFixed(1)}% 낮음`;
    if (smartWhy) pick = { k: 'bid1', p: bid1.p };
  }
  const buy = force && force.buy > 0 ? force.buy : pick ? pick.p : floorTick(cur);
  const qty = force && force.qty > 0 ? force.qty : Math.floor(perStockKrw / buy);
  if (qty < 1) return { skip: `금액 ${perStockKrw.toLocaleString('ko-KR')}원으로 1주도 못 삼(${buy.toLocaleString('ko-KR')}원)` };
  const last5 = rows.slice(-5), avg5 = last5.length ? last5.reduce((a, r) => a + (+r.trade_amount || 0), 0) / last5.length : 0;
  const capEok = Math.max(avg5, q.amt || 0) / EOK;
  const prevHigh = rows.length ? Math.max(...rows.map(r => (+r.high > 0 ? +r.high : +r.close))) : 0;
  const prof = buildProfile(rows);
  /* 정정·직접 수정으로 매수가가 현재가보다 높아지면 목표(손익비 기준 목표 포함)도 그 매수가 기준으로 잡음 — 현재가 기준으로 두면 손절은 새 매수가, 목표는 옛 현재가라 손익비가 1:3 아래로 어긋남 */
  const base = force && force.buy > cur ? force.buy : cur;
  const tgt = calcTarget({ cur: base, prof, capEok, coef: o.coef, prevHigh, upper: q.upper, stopPct: o.stopPct, rr: o.rr });
  /* 하루 소화 근거(억원): 어제 거래대금 · 최근 5거래일 평균 · 오늘 지금까지 — 화면에서 매물대 소화 일수 계산에 씀 */
  const todayKst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const prevRow = [...rows].reverse().find(r => String(r.trade_date) < todayKst && +r.trade_amount > 0);
  const done5 = rows.filter(r => String(r.trade_date) < todayKst && +r.trade_amount > 0).slice(-5), dayEok = done5.map(r => [String(r.trade_date).slice(5), Math.round(+r.trade_amount / EOK * 10) / 10]);   // 끝난 최근 5거래일(월-일, 억원)
  const ydEok = prevRow ? Math.round(+prevRow.trade_amount / EOK * 10) / 10 : null, avg5Eok = done5.length ? Math.round(done5.reduce((a, r) => a + +r.trade_amount, 0) / done5.length / EOK * 10) / 10 : Math.round(avg5 / EOK * 10) / 10, todEok = q.amt > 0 ? Math.round(q.amt / EOK * 10) / 10 : null;
  const steps = tgt.target && !o.noTp ? (o.tpStyle === 'r' ? splitPlanR(buy, tgt.target, qty, { stopPct: o.stopPct, runnerPct: o.runnerPct }) : splitPlan(buy, tgt.target, qty, o.split, o.minPct)).steps.filter(s => s.q > 0) : [];   // noTp(종가베팅 저녁 매수): 익절 없이 손절만 걸고 다음 날 아침 분할 매도
  const plan = { stopPct: o.stopPct, stop: stopPrice(buy, o.stopPct), target: tgt.target, trail: o.trail, steps: steps.map(s => ({ n: s.n, p: s.p, q: s.q, ...(s.runner ? { runner: true } : {}) })), ...(o.ratchet && !o.noTp ? { ratchet: { floorPct: 0.35 } } : {}) };
  const tinfo = { cap: tgt.cap, cum: tgt.cum, topLo: tgt.topLo, topV: tgt.topV, rrT: tgt.rrT, clipped: tgt.clipped, prevHigh: tgt.prevHigh, upper: q.upper || null, capEok, ydEok, avg5Eok, todEok, dayEok, coef: o.coef, stopPct: o.stopPct, rr: o.rr, minRr: o.minRr, tpStyle: o.tpStyle, split: o.split, minPct: o.minPct, runnerPct: o.runnerPct, ratchet: !!(o.ratchet && !o.noTp), ref: cur, prof: prof.map(b => [Math.round(b.lo), Math.round(b.hi), Math.round(b.v * 10) / 10]) };   // prof = 개인 순매수 매물대 [하한, 상한, 억원] — 목표가 그림용
  return { buy, qty, plan, target: tgt.target, mode: tgt.mode, pick: pick ? pick.k : 'cur', smartWhy, tinfo };
}

/* 손익비 = (목표가 − 매수가) ÷ (매수가 − 손절가). 목표가가 없으면 null */
function rrOf(ord) {
  if (!ord || !(ord.target > 0) || !(ord.buy > 0) || !ord.plan || !(ord.plan.stop > 0) || ord.buy <= ord.plan.stop) return null;
  return (ord.target - ord.buy) / (ord.buy - ord.plan.stop);
}

/* 승인 직후 재확인 — 실패 사유 배열(빈 배열이면 통과) */
function recheck(q, notice, opt = {}) {
  const o = { ...DEF, ...opt }, why = [];
  if (!q || !(q.price > 0)) return ['시세 없음'];
  if (q.vi) why.push('VI 발동 중');
  if ((q.warnings || []).some(w => /거래정지|정리매매|관리종목|투자위험|투자경고/.test(w))) why.push(`경고 종목(${q.warnings.join(',')})`);
  if (!o.closing) { if (q.strength == null) why.push('체결강도 없음'); else if (q.strength < o.cttrMin) why.push(`체결강도 ${Math.round(q.strength)}%`); }   // 종가베팅 저녁 매수는 애프터마켓이라 체결강도·시가 대비는 보지 않음
  if (notice && notice.price > 0) {
    const d = (q.price / notice.price - 1) * 100;
    if (d > o.recheckPct) why.push(`알림 후 +${d.toFixed(1)}% 더 오름`);
    if (d < -o.recheckPct) why.push(`알림 후 ${d.toFixed(1)}% 밀림`);
  }
  if (!o.closing && q.open > 0 && Math.round((q.price / q.open - 1) * 1e4) / 100 > o.openRiseMax) why.push(`시가 대비 +${((q.price / q.open - 1) * 100).toFixed(1)}%`);
  return why;
}

const fmt = v => Math.round(v).toLocaleString('ko-KR');
function unfilledText(o) {
  const wm = Math.round(o.fillWaitMs / 60e3), cm = Math.round(o.cancelWaitMs / 60e3);
  const a = o.repriceTo === 'none' ? `미체결은 ${wm}분 뒤 정정하지 않고` : `미체결은 ${wm}분 뒤 ${REPRICE_KO[o.repriceTo] || '매수 1호가'}로 한 번 정정,`;
  const ch = o.chaseAsk ? `못 사면 최우선 매도 호가로 한 번 더 올려(알림 시점 가격 +${o.chasePct}% 이내·손익비 재확인) ${Math.round(o.chaseWaitMs / 60e3)}분 기다리고, ` : '';
  return `${a} ${ch}다시 ${cm}분 뒤 남으면 ${o.unfilledEnd === 'keep' ? '장 마감까지 그대로 둬요' : '취소해요'}.`;
}
function planText(r, closing) {
  const s = closing ? '익절 없음(다음 날 아침 분할 매도)' : r.plan.steps.length ? `익절 ${r.plan.steps.map(x => x.runner ? '러너(목표 도달 후 트레일링)' : fmt(x.p)).join(' / ')}${r.plan.ratchet ? ' · 1단계 체결 시 손절이 본전으로 상승' : ''}` : '익절 없음(목표가를 못 정함 — 매매 화면에서 직접 설정)';
  return `손절 ${fmt(r.plan.stop)}원(−${r.plan.stopPct}%) · ${s}`;
}

/* deps: paper{place,modify,cancel,state} · getQuote(code) · loadChart(code)→rows · mutateRun(date, fn(run)→void) · readRun(date) · sendTelegram · now · perStock()→원 · opt()→설정 */
/* 다시 시도(2026-11-16): 못 산 주문은 기록(orders[code])에 이력(tries)으로 접어 두고 새 주문을 낸다 */
const tryNo = o => ((o && o.tries) || []).length + 1;
const keepTries = (prev, o) => (prev && prev.tries && prev.tries.length ? { ...o, tries: prev.tries } : o);

/* 다시 시도 대상: 한 주도 못 산 종료 상태(미체결 취소·재확인 탈락·주문 거부), 시도 횟수가 남았고 영구 사유(다른 곳에서 보유 중)가 아닐 때 */
function retryable(o, maxTries) {
  if (!o || (o.filled || 0) > 0) return false;
  if (!['cancelled', 'skipped', 'failed'].includes(o.st)) return false;
  if (/이미 보유|손익비/.test(o.why || '')) return false;   // 영구 사유: 다른 곳 보유·목표가가 낮아 손익비 미달
  return tryNo(o) < (+maxTries || 3);
}
/* 지난 시도를 이력(tries)으로 접고 'retry'(다시 승인·주문 대기) 상태로 바꾼 새 기록 */
function foldTry(o, nowMs) {
  return { st: 'retry', tries: [...((o && o.tries) || []), { n: tryNo(o), st: o.st, why: o.why || null, buy: o.buy2 || o.buy || null, qty: o.qty || null, at: o.at || null, placedAt: o.placedAt || null, price: (o.snap && o.snap.price) || null, endedAt: nowMs }] };
}
function createExec(deps) {
  const D = deps, now = D.now || Date.now;
  const stateOf = o => (o && o.status) || null;
  /* 매매 엔진: broker.of(전략)(실거래 전환 1단계). 예전 방식(paper 직접)도 받는다(시험용 가짜 엔진) */
  const B = D.broker || D.paper;
  const label = () => (B && B.label) || '가상';
  /* 이미 보유·주문 중인 종목. 실전은 잔고를 새로 읽은 값이고, 확인하지 못하면 예외(= 사지 않음) */
  const heldNow = async () => (B.held ? B.held() : new Set((B.heldCodes && B.heldCodes()) || []));
  /* 이상 동작 차단(2단계): 실전·드라이런 전략만. 기록은 그날 실행 기록(run.payload.gate)에 — 재시작해도 이어짐 */
  const gated = () => !!(B && (B.real || B.dry));
  const LIM = o => ({ maxOrdersDay: +o.maxOrdersDay || 20, rejectStop: +o.rejectStop || 3, unsureStop: +o.unsureStop || 2 });
  function gateRec(run, ev, code, opt) {   // mutateRun 안에서 부름. 이번에 정지됐으면 사유
    if (!gated()) return null;
    const g = run.payload.gate = run.payload.gate || SZ.gate0();
    const why = SZ.gateAfter(g, ev, code, LIM(opt || {}), now());
    if (why) LOG.push(run.payload, 'halt', `⛔ 이상 동작 차단: ${why} — 오늘 이 전략의 신규 매수를 멈춤(손절·익절은 계속)`, { code }, now());
    return why;
  }
  const haltMsg = why => `⛔ [${label()}] 이상 동작 차단: ${why} — 오늘 이 전략의 신규 매수를 멈췄어요. 손절·익절 감시는 계속됩니다. 원인을 확인한 뒤 내일 다시 시작해요.`;

  async function placeOne(date, code, notice, perStock, opt) {
    if (D.halt) { const h = await D.halt().catch(() => null); if (h) return { st: 'skipped', why: h }; }   // 정지 단계(신규 매수 정지·자동매매 전체 정지)
    if (gated()) { const r0 = await D.readRun(date).catch(() => null), w = SZ.gateCheck(r0 && r0.payload && r0.payload.gate, code, LIM(opt || {})); if (w) return { st: 'skipped', why: w }; }
    // 같은 종목은 한 포지션으로 합쳐지므로 겹쳐 사지 않음. 2026-11-18: 예전 코드는 Set 에 .includes 를 불러 늘 예외 → 무시되어 이 검사가 실제로는 돌지 않았음(수정)
    let held; try { held = await heldNow(); } catch (e) { return { st: 'skipped', why: '보유 종목 확인 실패 — ' + ((e && e.message) || '알 수 없음') }; }
    if (held && held.has(code)) return { st: 'skipped', why: '이미 보유·주문 중(다른 전략 또는 직접 매매)' };
    let q; try { q = await D.getQuote(code); } catch (e) { return { st: 'skipped', why: '시세 조회 실패: ' + e.message }; }
    const why = recheck(q, notice, opt), snap = snapOf(q, notice, opt);
    if (snap) snap.at = now();
    if (why.length) return { st: 'skipped', why: why.join(', '), snap };
    let size = null;   // 금액 자동 조정·주문 가능 금액 점검(2단계): 실전·드라이런은 실제 계좌의 미수 없는 매수 가능 금액 안에서만
    if (D.sizeOne) {
      try { size = await D.sizeOne(code, q, opt || {}, !!notice.cb); } catch (e) { return { st: 'skipped', why: '주문 가능 금액 확인 실패 — ' + ((e && e.message) || '알 수 없음'), snap }; }
      if (size && size.skip) return { st: 'skipped', why: size.skip, snap };
      if (size && size.krw > 0) perStock = size.krw;
    }
    let rows; try { rows = await D.loadChart(code); } catch (e) { rows = []; }
    if (!rows || !rows.length) return { st: 'skipped', why: '일봉 자료 없음', snap };
    const ord = makeOrder({ q, rows, perStockKrw: perStock, opt });
    if (ord.skip) return { st: 'skipped', why: ord.skip, snap };
    const rrv = rrOf(ord), minRr = +opt.minRr || 0;   // 손익비 하한: 목표가가 낮아 (이익÷손실)이 기준 미만이면 사지 않음(수수료까지 빼면 손해)
    if (snap) snap.checks.rr = { v: rrv == null ? null : Math.round(rrv * 100) / 100, min: minRr || null, target: ord.target || null };
    if (minRr > 0 && (rrv == null || rrv < minRr)) return { st: 'skipped', why: rrv == null ? `목표가를 정하지 못해 손익비 계산 불가(기준 1:${minRr})` : `손익비 1:${(Math.floor(rrv * 10) / 10).toFixed(1)} — 기준(1:${minRr}) 미달, 목표가 ${fmt(ord.target)}원(${((ord.target / ord.buy - 1) * 100).toFixed(1)}%) · 손절 −${ord.plan.stopPct}%`, snap };
    // 1) 의도 먼저 저장(재시작 중복 방지)
    const at = now();
    let tn = 1;
    await D.mutateRun(date, run => { run.payload.orders = run.payload.orders || {}; const prev = run.payload.orders[code]; tn = tryNo(prev); run.payload.orders[code] = keepTries(prev, { st: 'intent', at, buy: ord.buy, qty: ord.qty, plan: ord.plan, mode: ord.mode, pick: ord.pick, ...(ord.smartWhy ? { pickWhy: ord.smartWhy } : {}), target: ord.target, tinfo: ord.tinfo || null, snap }); });
    // 2) 주문
    const r = await B.place({ code, name: notice.name, side: 'buy', type: 'limit', price: ord.buy, qty: ord.qty, plan: ord.plan, cid: `auto${date.replace(/-/g, '')}${code}${tn > 1 ? 't' + tn : ''}` });
    if (!r || !r.ok) {
      let hw = null;
      await D.mutateRun(date, run => { hw = r && r.status === 503 ? null : gateRec(run, 'reject', code, opt); run.payload.orders[code] = { ...run.payload.orders[code], st: 'failed', why: (r && r.error) || '주문 거부' }; LOG.push(run.payload, 'order_fail', `${notice.name}: 주문 실패 — ${(r && r.error) || '주문 거부'}`, { code }, now()); });
      if (hw) await D.sendTelegram(haltMsg(hw)).catch(() => {});
      return { st: 'failed', why: (r && r.error) || '주문 거부', ord };
    }
    const o = r.order, filled = o.filled || 0;
    const st = stateOf(o) === 'filled' ? 'filled' : 'open';
    let hw2 = null;
    await D.mutateRun(date, run => {
      hw2 = gateRec(run, o.status === 'unsure' ? 'unsure' : 'order', code, opt);
      if (filled > 0) gateRec(run, 'filled', code, opt);
      if (size && (B.dry || size.mode === 'balance' || size.capBy)) LOG.push(run.payload, 'size', `${notice.name}: 종목당 금액 ${SZ.sizeText(size, size.mode)}`, { code }, now());
      if (B.dry) LOG.push(run.payload, 'dryrun', `🧪 드라이런 — 실전이었다면: ${notice.name} ${fmt(ord.buy)}원 ${fmt(ord.qty)}주 지정가 매수(주문 가능 금액 ${size && size.cash != null ? fmt(size.cash) + '원' : '확인 안 됨'}) · 실제 주문은 가상 엔진으로`, { code }, now());
      run.payload.orders[code] = { ...run.payload.orders[code], st, orderId: o.id, placedAt: at, filled, avg: o.avg || null, ...(B.real || B.dry ? { mode: B.mode } : {}), ...(size ? { krw: size.krw } : {}) };
      LOG.push(run.payload, 'order', `${notice.name}${tn > 1 ? ` (${tn}번째 시도)` : ''}: ${fmt(ord.buy)}원 ${fmt(ord.qty)}주 지정가 매수 주문(${LOG.PICK_KO[ord.pick] || ord.pick}${ord.smartWhy ? ' · ' + ord.smartWhy + '이라 최우선 매수 호가부터' : ''}) · 현재가 ${snap && snap.price ? fmt(snap.price) : '–'}원 · 손절 ${fmt(ord.plan.stop)} · 목표 ${ord.target ? fmt(ord.target) : '없음'}`, { code }, at);
      if (st === 'filled') LOG.push(run.payload, 'filled', `${notice.name}: 바로 체결 ${fmt(filled)}주 평균 ${fmt(o.avg)}원`, { code }, now());
    });
    if (B.dry && D.dryLog) await D.dryLog({ code, name: notice.name, side: 'buy', price: ord.buy, qty: ord.qty, krw: size ? size.krw : null, cash: size ? size.cash : null, capital: size ? size.capital : null, paperOrderId: o.id }).catch(() => {});
    if (hw2) await D.sendTelegram(haltMsg(hw2)).catch(() => {});
    return { st, ord, order: o };
  }

  /* 승인 처리: 승인한 종목을 차례로 주문. 반환 = 텔레그램 답장 */
  async function approve(date, payload) {
    const ps0 = D.perStock ? await D.perStock() : null, perStock = ps0 > 0 ? ps0 : 1000000;
    const opt0 = D.opt ? await D.opt() : {};
    const lines = [`🛒 ${label()} 매수 · 종목당 ${opt0 && opt0.sizeMode === 'balance' ? '계좌 잔고 기준 자동' : fmt(perStock) + '원'}`];
    for (const code of payload.approved || []) {
      const notice = (payload.picks || []).find(p => p.code === code) || { code, name: code };
      const cur = payload.orders && payload.orders[code];
      if (cur && cur.st && cur.st !== 'retry') { lines.push(`· ${notice.name}: 이미 처리됨(${cur.st})`); continue; }
      let r;
      const opt = notice.cb ? { ...opt0, ...(D.optCb ? await D.optCb() : { closing: true, noTp: true, minRr: 0 }) } : opt0;   // 종가베팅 저녁 매수 후보는 별도 조건(손절 −5%·익절 없음·체결강도 안 봄)
      if (opt && opt.totalCapKrw > 0 && D.exposure) {   // 총액 상한: 새 주문이 상한을 넘으면 이 종목만 사지 않음(기존 보유는 그대로)
        const ck = capCheck(opt.totalCapKrw, await D.exposure().catch(() => null), perStock);
        if (!ck.ok) { await D.mutateRun(date, run => { run.payload.orders = run.payload.orders || {}; run.payload.orders[code] = keepTries(run.payload.orders[code], { st: 'skipped', why: ck.why, at: now() }); LOG.push(run.payload, 'skip', `${notice.name}: 매수 안 함 — ${ck.why}`, { code }, now()); }); lines.push(`· ${notice.name}: 매수 안 함 — ${ck.why}`); continue; }
      }
      try { r = await placeOne(date, code, notice, perStock, opt); } catch (e) { r = { st: 'failed', why: e.message }; }
      if (r.st === 'skipped') {
        await D.mutateRun(date, run => { run.payload.orders = run.payload.orders || {}; run.payload.orders[code] = keepTries(run.payload.orders[code], { st: 'skipped', why: r.why, at: now(), snap: r.snap || null }); LOG.push(run.payload, 'skip', `${notice.name}: 승인 후 재확인에서 매수 안 함 — ${r.why}`, { code }, now()); });
        lines.push(`· ${notice.name}: 매수 안 함 — ${r.why}`);
      } else if (r.st === 'failed') lines.push(`· ${notice.name}: 주문 실패 — ${r.why}`);
      else {
        const o = r.order, ord = r.ord;
        lines.push(`· ${notice.name}: ${o.status === 'filled' ? `체결 ${fmt(o.filled)}주 평균 ${fmt(o.avg)}원` : `${fmt(ord.buy)}원 ${fmt(ord.qty)}주 지정가 대기${o.filled ? ` (일부 ${fmt(o.filled)}주 체결)` : ''}`}`);
        lines.push(`  ${planText(ord, !!notice.cb)}`);
      }
    }
    lines.push('', unfilledText({ ...DEF, ...(opt0 || {}) }));
    return lines.join('\n');
  }

  /* 주기 관리: 미체결 정정·취소, 체결 알림, 주문 결과를 모르는 의도 정리 */
  async function follow(date) {
    const run = await D.readRun(date);
    const ords = run && run.payload && run.payload.orders;
    if (!ords) return { ok: true, n: 0 };
    const o2 = { ...DEF, ...(D.opt ? await D.opt().catch(() => ({})) : {}) }, wm = Math.round(o2.fillWaitMs / 60e3), cm = Math.round(o2.cancelWaitMs / 60e3);
    const active = Object.entries(ords).filter(([, v]) => v.st === 'intent' || v.st === 'open' || v.st === 'modified');
    if (!active.length) return { ok: true, n: 0 };
    const S = await B.state();
    if (!S || !S.ok) return { ok: false, why: 'paper state' };
    const byId = new Map((S.orders || []).map(o => [o.id, o]));
    const msgs = [];
    /* 추격(chaseAsk): 정정(최우선 매수 호가)으로도 못 샀으면 한 번만 최우선 매도 호가로 올림 — 알림 시점 가격 +chasePct% 이내 · 재확인(체결강도·VI 등) 통과 · 올린 가격 기준 손익비 기준 통과일 때만.
       처리했으면 true(정정됨), 조건이 안 맞으면 false(호출한 쪽이 원래대로 계속) */
    async function chase(code, v, o, name) {
      if (!o2.chaseAsk || v.chased || v.userEdit || v.cb || o.filled) return false;
      const base = v.snap && v.snap.notice > 0 ? v.snap.notice : null;
      if (!base) return false;
      let q; try { q = await D.getQuote(code); } catch (_) { return false; }
      const ask = ((q && q.asks) || []).filter(a => a.p > 0).reduce((m, a) => (!m || a.p < m ? a.p : m), 0);
      const note = async why => { await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], chaseNo: why }; LOG.push(r.payload, 'wait', `${name}: 추격 안 함 — ${why}`, { code }, now()); }); return false; };
      if (!(ask > o.price)) return false;
      const lim = base * (1 + (+o2.chasePct || 1) / 100);
      if (ask > lim) return note(`최우선 매도 호가 ${fmt(ask)}원이 알림 시점 가격 ${fmt(base)}원 +${o2.chasePct}% (${fmt(lim)}원)를 넘음`);
      const bad = recheck(q, null, o2);
      if (bad.length) return note(bad.join(', '));
      let rows = []; try { rows = await D.loadChart(code); } catch (_) {}
      if (!rows || !rows.length) return false;
      const ord2 = makeOrder({ q, rows, perStockKrw: ask * o.qty, opt: o2, force: { buy: ask, qty: o.qty } });
      if (ord2.skip) return note(ord2.skip);
      const minRrC = +o2.minRr || 0;
      if (minRrC > 0) { const rr2 = rrOf(ord2); if (rr2 == null || rr2 < minRrC * (1 - (o2.rrSlack == null ? 10 : o2.rrSlack) / 100)) return note(`${fmt(ask)}원 기준 손익비 ${rr2 == null ? '계산 불가' : '1:' + (Math.floor(rr2 * 10) / 10).toFixed(1)} — 기준(1:${minRrC}) 미달`); }
      const m = await B.modify({ id: o.id, price: ask, plan: ord2.plan });
      if (!(m && m.ok)) return false;
      await D.mutateRun(date, r => { gateRec(r, 'modify', code, o2); if (m.order.status === 'filled') gateRec(r, 'filled', code, o2);
        r.payload.orders[code] = { ...r.payload.orders[code], st: m.order.status === 'filled' ? 'filled' : 'modified', orderId: m.order.id, modifiedAt: now(), from: o.id, buy2: ask, chased: true, plan: ord2.plan, target: ord2.target, tinfo: ord2.tinfo || null };
        LOG.push(r.payload, 'reprice', `${name}: 못 사서 ${fmt(o.price)}원 → 최우선 매도 호가 ${fmt(ask)}원으로 추격(알림 시점 ${fmt(base)}원 +${((ask / base - 1) * 100).toFixed(1)}%) · 손익비 재확인 통과${m.order.status === 'filled' ? ' · 바로 체결' : ''}`, { code }, now()); });
      msgs.push(`⏫ ${name}: 못 사서 ${fmt(ask)}원(최우선 매도 호가)으로 올림${m.order.status === 'filled' ? ' · 체결' : ''}`);
      return true;
    }
    for (const [code, v] of active) {
      const name = ((run.payload.picks || []).find(p => p.code === code) || {}).name || code;
      if (v.st === 'intent') {   // 재시작 등으로 결과 모름 → 의도 시각 이후 같은 종목 매수 주문을 찾아 이어받기
        const found = (S.orders || []).filter(o => o.code === code && o.side === 'buy' && o.ts >= v.at - 2000).sort((a, b) => a.ts - b.ts)[0];
        if (found) await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: found.status === 'filled' ? 'filled' : 'open', orderId: found.id, placedAt: found.ts, filled: found.filled }; LOG.push(r.payload, 'resume', `${name}: 재시작 뒤 주문을 찾아 이어받음`, { code }, now()); });
        else if (now() - v.at > (o2.intentLostMs || DEF.intentLostMs)) {
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'lost' }; LOG.push(r.payload, 'lost', `${name}: 주문 결과 확인 불가(서버 재시작 추정) — 다시 내지 않음`, { code }, now()); });
          msgs.push(`⚠ ${name}: 주문 결과를 확인하지 못했어요(서버 재시작 추정). 중복을 막으려고 다시 내지 않았어요 — 매매 화면에서 확인하세요.`);
        }
        continue;
      }
      const o = byId.get(v.orderId);
      if (!o) continue;
      if (o.status === 'filled') {
        await D.mutateRun(date, r => { gateRec(r, 'filled', code, o2); r.payload.orders[code] = { ...r.payload.orders[code], st: 'filled', filled: o.filled, avg: o.avg, filledAt: now() }; LOG.push(r.payload, 'filled', `${name}: 체결 ${fmt(o.filled)}주 평균 ${fmt(o.avg)}원 — 손절·익절 자동 관리 시작`, { code }, now()); });
        msgs.push(`✅ ${name}: ${label()} 매수 체결 ${fmt(o.filled)}주 평균 ${fmt(o.avg)}원 — 손절·익절 자동 관리 시작`);
        continue;
      }
      if (o.status === 'unsure') continue;   // 실전 "접수 확인 중"(KIS 응답 없음): 체결조회로 확인될 때까지 정정·취소·종료 판단을 하지 않음
      if (o.status !== 'open' && o.status !== 'partial') {   // 엔진이 취소·소멸시킨 경우
        await D.mutateRun(date, r => { if (o.filled > 0) gateRec(r, 'filled', code, o2); r.payload.orders[code] = { ...r.payload.orders[code], st: o.filled ? 'partial_done' : 'cancelled', filled: o.filled, avg: o.avg }; LOG.push(r.payload, 'cancel', `${name}: 엔진에서 주문 종료(${o.status})${o.filled ? ` · 일부 ${fmt(o.filled)}주 체결` : ''}`, { code }, now()); });
        continue;
      }
      const since = v.st === 'modified' ? v.modifiedAt : v.placedAt;
      if (now() - since < (v.st === 'modified' ? (v.chased ? o2.chaseWaitMs : o2.cancelWaitMs) : o2.fillWaitMs)) continue;
      if (v.st === 'open') {   // 미체결 → 설정한 가격으로 한 번 정정(정정 안 함이면 그대로 다음 대기로)
        if (o2.repriceTo === 'none') {
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'modified', modifiedAt: now(), noReprice: true }; LOG.push(r.payload, 'wait', `${name}: ${wm}분 미체결 — 정정하지 않고 ${cm}분 더 기다림`, { code }, now()); });
          continue;
        }
        let q; try { q = await D.getQuote(code); } catch (_) { continue; }
        const px = o2.repriceTo === 'ask1' ? ((q.asks || []).filter(a => a.p > 0).reduce((m, a) => (!m || a.p < m ? a.p : m), 0) || null) : ((q.bids || []).find(b => b.p > 0) || {}).p;
        if (!(px > 0) || px === o.price) {   // 이미 그 가격이면 정정할 게 없음 → 정정한 것으로 보고 더 기다림
          if (await chase(code, v, o, name)) continue;   // 처음부터 최우선 매수 호가였으면(강세 보정) 바로 추격 시도
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'modified', modifiedAt: now() }; LOG.push(r.payload, 'wait', `${name}: ${wm}분 미체결 — 이미 ${REPRICE_KO[o2.repriceTo]}(${fmt(o.price)}원)라 정정 없이 ${cm}분 더 기다림 · 현재가 ${q.price ? fmt(q.price) : '–'}원`, { code }, now()); });
          continue;
        }
        // 정정 가격이 바뀌면 손절·익절 계획도 새 매수가 기준으로 다시 계산(전엔 주문가 기준 계획이 그대로 남아 보유 뒤 손절·익절 금액이 평균가와 어긋났음). 일부 체결된 주문은 건드리지 않음
        let plan = null, ord2 = null;
        if (!o.filled) {
          try {
            const rows = await D.loadChart(code).catch(() => []);
            if (rows && rows.length && q) {
              const optC = v.cb ? { ...o2, ...(D.optCb ? await D.optCb() : { closing: true, noTp: true, minRr: 0 }) } : o2;
              ord2 = makeOrder({ q, rows, perStockKrw: px * o.qty, opt: optC, force: { buy: px, qty: o.qty } });
              if (!ord2.skip) plan = ord2.plan;
            }
          } catch (_) { plan = null; }
        }
        /* 정정가로 사면 손익비가 기준(minRr) 아래로 떨어지는 경우: 올려 사지 않고 취소 — 처음 주문 때만 손익비를 봐서 정정 뒤 1:2.x 로 체결되던 문제 */
        const minRrC = ord2 && !ord2.skip ? (+((v.cb ? { ...o2, ...(D.optCb ? await D.optCb() : {}) } : o2).minRr) || 0) : 0;
        if (minRrC > 0) {
          const rr2 = rrOf(ord2);
          if (rr2 == null || rr2 < minRrC * (1 - (o2.rrSlack == null ? 10 : o2.rrSlack) / 100)) {   // 호가 단위 내림으로 1:3 이 1:2.9 쯤 나오는 것까지는 통과(처음 주문 가격은 기준을 그대로 적용)
            const c = await B.cancel(o.id);
            const why = `정정가 ${fmt(px)}원 기준 손익비 ${rr2 == null ? '계산 불가' : '1:' + (Math.floor(rr2 * 10) / 10).toFixed(1)} — 기준(1:${minRrC}) 미달이라 올려 사지 않고 취소`;
            await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'cancelled', why, cancelledAt: now(), lowSeen: null }; LOG.push(r.payload, 'cancel', `${name}: ${why}${c && c.ok ? '' : ' (취소 실패)'}`, { code }, now()); });
            msgs.push(`✖ ${name}: ${why}`);
            continue;
          }
        }
        const m = await B.modify({ id: o.id, price: px, ...(plan ? { plan } : {}) });
        if (m && m.ok) {
          await D.mutateRun(date, r => { gateRec(r, 'modify', code, o2); if (m.order.status === 'filled') gateRec(r, 'filled', code, o2); r.payload.orders[code] = { ...r.payload.orders[code], st: m.order.status === 'filled' ? 'filled' : 'modified', orderId: m.order.id, modifiedAt: now(), from: o.id, buy2: px, ...(plan ? { plan, target: ord2.target, tinfo: ord2.tinfo || null, ...(r.payload.orders[code] && r.payload.orders[code].snap ? { snap: { ...r.payload.orders[code].snap, checks: { ...(r.payload.orders[code].snap.checks || {}), rr: { v: rrOf(ord2) == null ? null : Math.round(rrOf(ord2) * 100) / 100, min: (+o2.minRr || null), target: ord2.target || null, at: 'reprice' } } } } : {}) } : {}), ...(m.order.status === 'filled' ? { filledAt: now(), filled: m.order.filled, avg: m.order.avg } : {}) };
            LOG.push(r.payload, 'reprice', `${name}: ${wm}분 미체결 → ${fmt(o.price)}원에서 ${fmt(px)}원(${REPRICE_KO[o2.repriceTo]})으로 정정 · 현재가 ${q.price ? fmt(q.price) : '–'}원${m.order.status === 'filled' ? ' · 바로 체결' : ''}`, { code }, now()); });
          msgs.push(`↪ ${name}: ${wm}분 미체결 → ${fmt(px)}원으로 정정${m.order.status === 'filled' ? ' · 체결' : ''}`);
        } else {
          await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: 'cancelled', why: '정정 실패: ' + ((m && m.error) || '') }; LOG.push(r.payload, 'cancel', `${name}: 정정 실패 — ${(m && m.error) || '알 수 없음'}`, { code }, now()); });
          msgs.push(`⚠ ${name}: 정정 실패 — ${(m && m.error) || '알 수 없음'}`);
        }
      } else {                 // 정정 후에도 미체결
        if (await chase(code, v, o, name)) continue;
        if (o2.unfilledEnd === 'keep' || v.userEdit) continue;   // 설정: 장 마감까지 유지 · 사용자가 주문 화면에서 직접 정정한 주문은 자동으로 취소하지 않음(직접 취소 전까지)
        let lo = null; try { const q = await D.getQuote(code); lo = q && q.low > 0 ? q.low : null; } catch (_) {}
        const c = await B.cancel(o.id);
        const missTx = lo != null ? ` · 주문가 ${fmt(o.price)}원, 그동안 최저가 ${fmt(lo)}원${lo > o.price ? '(주문가까지 내려오지 않음)' : ''}` : '';
        await D.mutateRun(date, r => { if (o.filled > 0) gateRec(r, 'filled', code, o2); r.payload.orders[code] = { ...r.payload.orders[code], st: o.filled ? 'partial_done' : 'cancelled', filled: o.filled, avg: o.avg, why: c && c.ok ? '미체결 취소' : '취소 실패', cancelledAt: now(), lowSeen: lo };
          LOG.push(r.payload, 'cancel', `${name}: 정정 후 ${cm}분 미체결 → 취소${o.filled ? ` (일부 ${fmt(o.filled)}주 보유)` : ''}${missTx}`, { code }, now()); });
        msgs.push(`✖ ${name}: 정정 후에도 미체결 → 취소${o.filled ? ` (일부 ${fmt(o.filled)}주는 보유·계획대로 관리)` : ''}`);
      }
    }
    if (msgs.length) await D.sendTelegram(msgs.join('\n'));
    return { ok: true, n: active.length, msgs };
  }

  /* 사용자가 사이트 주문 화면에서 체결 대기 중인 자동 매수를 직접 정정·취소 — 별도 주문이 아니라 같은 주문을 고침.
     정정: 가격(·수량, 아직 체결 전일 때만)을 바꾸고 손절·익절 계획을 새 매수가 기준으로 다시 계산. 이후 자동 관리(체결 확인·익절 걸기)는 그대로 이어짐 */
  async function userEdit(date, code, body) {
    const run = await D.readRun(date), v = run && run.payload && run.payload.orders && run.payload.orders[code];
    if (!v || !['open', 'modified'].includes(v.st) || !v.orderId) return { ok: false, status: 409, error: '체결 대기 중인 자동 매수 주문이 아닙니다' };
    const S = await B.state();
    const o = S && S.ok ? (S.orders || []).find(x => x.id === v.orderId) : null;
    if (o && o.status === 'unsure') return { ok: false, status: 409, error: '접수 확인 중인 주문입니다. 잠시 뒤 다시 시도하세요' };
    if (!o || (o.status !== 'open' && o.status !== 'partial')) return { ok: false, status: 409, error: '이미 체결되었거나 끝난 주문입니다' };
    const name = o.name || code;
    if (body.action === 'cancel') {
      const c = await B.cancel(o.id);
      if (!c || !c.ok) return { ok: false, status: (c && c.status) || 400, error: (c && c.error) || '취소 실패' };
      await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: o.filled ? 'partial_done' : 'cancelled', filled: o.filled, avg: o.avg, why: '직접 취소', cancelledAt: now() };
        LOG.push(r.payload, 'cancel', `${name}: 사용자가 주문 화면에서 직접 취소${o.filled ? ` (일부 ${fmt(o.filled)}주는 보유·계획대로 관리)` : ''}`, { code }, now()); });
      return { ok: true, action: 'cancel' };
    }
    const price = Number(body.price), left = o.qty - o.filled;
    const qty = o.filled > 0 || body.qty == null || body.qty === '' ? left : Number(body.qty);   // 일부 체결됐으면 남은 수량만(수량 변경 불가)
    if (!(price > 0)) return { ok: false, status: 400, error: '가격을 입력하세요' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 1e7) return { ok: false, status: 400, error: '수량이 올바르지 않습니다' };
    if (price === o.price && qty === o.qty) return { ok: false, status: 400, error: '바뀐 내용이 없습니다' };
    if (B.real && qty < left) return { ok: false, status: 400, error: '실전 자동 주문은 수량을 줄여 정정할 수 없습니다(남은 수량이 옛 가격으로 따로 남음) — 가격만 바꾸거나 취소 후 다시 내세요' };   // 검토 #13
    let plan, ord = null;
    if (o.filled === 0) {
      const [q, rows] = await Promise.all([D.getQuote(code).catch(() => null), D.loadChart(code).catch(() => [])]);
      if (q && rows && rows.length) {
        const opt0 = D.opt ? await D.opt() : {};
        const opt = v.cb ? { ...opt0, ...(D.optCb ? await D.optCb() : { closing: true, noTp: true, minRr: 0 }) } : opt0;
        ord = makeOrder({ q, rows, perStockKrw: price * qty, opt, force: { buy: price, qty } });
        if (!ord.skip) plan = ord.plan;
      }
    }
    const m = await B.modify({ id: o.id, price, qty, resize: true, ...(plan ? { plan } : {}) });
    if (!m || !m.ok) return { ok: false, status: (m && m.status) || 400, error: (m && m.error) || '정정 실패' };
    const no = m.order, filledNow = no.status === 'filled';
    await D.mutateRun(date, r => { r.payload.orders[code] = { ...r.payload.orders[code], st: filledNow ? 'filled' : 'modified', orderId: no.id, modifiedAt: now(), from: o.id, userEdit: true, buy: price, qty: o.filled > 0 ? r.payload.orders[code].qty : qty,
        ...(plan ? { plan, target: ord.target, tinfo: ord.tinfo || null } : {}), ...(filledNow ? { filledAt: now(), filled: no.filled, avg: no.avg } : {}) };
      LOG.push(r.payload, 'reprice', `${name}: 사용자가 주문 화면에서 직접 정정 — ${fmt(o.price)}원 ${fmt(o.qty - o.filled)}주 → ${fmt(price)}원 ${fmt(qty)}주${plan ? ` · 손절 ${fmt(plan.stop)}원·익절 계획을 새 매수가 기준으로 다시 계산` : ''}${filledNow ? ' · 바로 체결' : ''}`, { code }, now()); });
    return { ok: true, action: 'modify', order: no, planned: !!plan };
  }

  return { approve, follow, userEdit };
}

module.exports = { planFromAvg, tryNo, keepTries, retryable, foldTry, DEF, REPRICE_KO, snapOf, unfilledText, tickOf, floorTick, recBids, buildProfile, calcTarget, splitPlan, stopPrice, makeOrder, recheck, rrOf, splitPlanR, createExec };
