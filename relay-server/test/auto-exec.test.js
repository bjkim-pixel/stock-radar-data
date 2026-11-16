'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const X = require('../auto-exec');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

/* ── 매매 화면 함수와 같은 결과인지: web/index.html 에서 함수 원문을 그대로 꺼내 비교 ── */
function webFns() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const grab = name => { const i = html.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let d = 0, j = html.indexOf('){', i) + 1; for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}') { d--; if (!d) break; } } return html.slice(i, j + 1); };
  const line = re => { const m = html.match(re); assert.ok(m, String(re)); return m[0]; };
  const src = [line(/const TRD_TICKS=\[[^\n]*\];/), line(/const PRICE_PROFILE_DOWN_PCT=[^;]*;/), line(/const PRICE_PROFILE_UP_PCT=[^;]*;/), 'const EOK=1e8;const N=(v)=>String(v);',
    ...['trdTick', 'trdFloor', 'trdCeil', 'trdBelow', 'trdRecBids', 'trdTarget', 'trdPlan', 'buildPriceProfile'].map(grab), line(/const trdStopPrice=[^;]*;/),
    'this.W={trdRecBids,trdTarget,trdPlan,buildPriceProfile,trdStopPrice,trdFloor};'].join('\n');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
  const J = v => JSON.parse(JSON.stringify(v));   // vm 쪽 배열·객체를 이 쪽 것으로(깊은 비교용)
  return Object.fromEntries(Object.entries(ctx.W).map(([k, f]) => [k, (...a) => J(f(...a))]));
}
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function fakeRows(r, cur, n = 220) {
  const rows = []; let p = cur * (0.6 + r() * 0.6);
  for (let i = 0; i < n; i++) { p = Math.max(100, p * (1 + (r() - 0.48) * 0.06)); rows.push({ close: Math.round(p), high: Math.round(p * 1.02), low: Math.round(p * 0.98), trade_amount: Math.round(1e9 + r() * 5e11), individual_net: Math.round((r() - 0.5) * 2e11) }); }
  rows[rows.length - 1].close = cur; return rows;
}

test('매매 화면과 같은 계산: 추천 호가·매물대 목표가·5분할·손절가 (무작위 300회)', () => {
  const W = webFns(), r = rng(7);
  for (let k = 0; k < 300; k++) {
    const cur = W.trdFloor(1000 + Math.floor(r() * 400000));
    const rows = fakeRows(r, cur);
    const bids = Array.from({ length: 10 }, (_, i) => ({ p: W.trdFloor(cur * (1 - i * 0.002)), q: Math.floor(r() * 5000) }));
    assert.deepEqual(X.recBids(bids, cur).map(x => [x.k, x.p]), W.trdRecBids(bids, cur).map(x => [x.k, x.p]));
    const profW = W.buildPriceProfile(rows, 24, x => +x.individual_net || 0), profS = X.buildProfile(rows);
    assert.deepEqual(profS.map(b => [b.lo, b.hi, b.v]), profW.map(b => [b.lo, b.hi, b.v]));
    const capEok = r() * 3000, prevHigh = Math.max(...rows.map(x => x.high)), upper = r() < 0.3 ? W.trdFloor(cur * 1.3) : 0;
    const tw = W.trdTarget({ cur, prof: profW, capEok, coef: 1, prevHigh, upper, stopPct: 5 });
    const ts = X.calcTarget({ cur, prof: profS, capEok, coef: 1, prevHigh, upper, stopPct: 5, rr: 3 });
    assert.equal(ts.target, tw.target); assert.equal(ts.mode, tw.mode);
    const buy = W.trdFloor(cur * (1 - r() * 0.01)), qty = 1 + Math.floor(r() * 300);
    if (tw.target) assert.deepEqual(X.splitPlan(buy, tw.target, qty, 5, 3).steps, W.trdPlan(buy, tw.target, qty, 5, 3).steps);
    assert.equal(X.stopPrice(buy, 5), W.trdStopPrice(buy, 5));
  }
});
test('위쪽 매물대가 없으면(신고가) 손익비 1:3 → +15% 목표', () => {
  const rows = [{ close: 9000, high: 9100, individual_net: 5e9 }, { close: 10000, high: 10000, individual_net: 1e9 }];
  const t = X.calcTarget({ cur: 10000, prof: X.buildProfile(rows), capEok: 100, prevHigh: 10000, upper: 13000, stopPct: 5, rr: 3 });
  assert.equal(t.mode, 'no-supply'); assert.equal(t.target, 11500);
});
test('주문 내용: 잔량 최다 매수 호가, 100만원 → 수량, 손절 −5%, 5단계(1단계 최소 +3%)', () => {
  const rows = [{ close: 9000, high: 9100, trade_amount: 5e10, individual_net: 5e9 }, { close: 10000, high: 10000, trade_amount: 5e10, individual_net: 1e9 }];
  const q = { price: 10000, amt: 3e10, upper: 13000, bids: [{ p: 10000, q: 100 }, { p: 9990, q: 900 }, { p: 9980, q: 50 }] };
  const o = X.makeOrder({ q, rows, perStockKrw: 1000000 });
  assert.equal(o.buy, 9990); assert.equal(o.qty, 100); assert.equal(o.plan.stop, 9490); assert.equal(o.plan.stopPct, 5); assert.equal(o.plan.trail, 2);
  assert.equal(o.plan.steps.length, 5); assert.equal(o.plan.steps.reduce((a, s) => a + s.q, 0), 100);
  assert.ok(o.plan.steps[0].p >= Math.ceil(9990 * 1.03 / 10) * 10, o.plan.steps[0].p);
  assert.equal(o.plan.steps[4].p, o.target);
  assert.equal(X.makeOrder({ q: { ...q, bids: [{ p: 2000000, q: 5 }] }, rows, perStockKrw: 1000000 }).skip.includes('1주도'), true);
  assert.equal(X.makeOrder({ q, rows, perStockKrw: 1000000, opt: { buyPick: 'low' } }).buy, 9980);
});
test('재확인: 체결강도·알림 후 ±1.5%·시가 대비 +8%·VI·경고', () => {
  const q = { price: 10000, open: 9800, strength: 120, warnings: [], vi: false };
  assert.deepEqual(X.recheck(q, { price: 9950 }), []);
  assert.match(X.recheck({ ...q, strength: 95 }, { price: 10000 }).join(), /체결강도/);
  assert.match(X.recheck(q, { price: 9800 }).join(), /더 오름/);
  assert.match(X.recheck(q, { price: 10200 }).join(), /밀림/);
  assert.match(X.recheck({ ...q, open: 9200 }, { price: 10000 }).join(), /시가 대비/);
  assert.match(X.recheck({ ...q, vi: true }, { price: 10000 }).join(), /VI/);
  assert.match(X.recheck({ ...q, warnings: ['투자경고'] }, { price: 10000 }).join(), /경고/);
});

/* ── 실제 가상매매 엔진(paper.js)과 붙인 흐름 ── */
async function setup(over) {
  const db = fakeDb(), c = await boot(db);
  const runs = {}; const sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: (i % 3 - 1) * 1e9 }));
  rows.push({ close: 10000, high: 10100, low: 9900, trade_amount: 5e10, individual_net: 1e9 });
  const A = createAuto({
    sbGet: async p => { if (over && p.startsWith('auto_strategies?')) return [{ id: 'intraday-default', name: '기본', kind: 'intraday', builtin: true, enabled: true, archived: false, version: 1, params: { ...require('../auto-strategy').defaults('intraday'), ...over } }, { id: 'closing-default', name: '종가', kind: 'closing', builtin: true, enabled: true, archived: false, version: 1, params: require('../auto-strategy').defaults('closing') }]; if (p.startsWith('auto_config')) return [{ value: { on: true, perStockKrw: 1000000 } }]; if (p.startsWith('auto_runs')) { const d = (p.match(/eq\.([\d-]+)/) || [])[1]; return runs[d] ? [JSON.parse(JSON.stringify(runs[d]))] : []; } return []; },
    sbWrite: async (p, m, b) => { b.forEach(x => { runs[x.trade_date] = JSON.parse(JSON.stringify(x)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => rows,
    livePool: async () => [], fetchFlow: async () => ({}), fetchPower: async () => ({}), fetchCttr: async () => ({}), marketState: async () => null,
  });
  const { date } = kst();
  runs[date] = { trade_date: date, status: 'noticed', payload: { picks: [{ code: '005930', name: '삼성전자', price: 10000, score: 80 }], noticeSent: true, approved: [], decision: null } };
  c.st.clock += 16 * 60e3;   // 10:16
  return { db, c, A, runs, sent, date };
}

test('승인 → 가상 지정가 매수(잔량 최다 호가) + 손절·5분할 계획이 주문에 붙음', async () => {
  const { db, c, A, runs, date } = await setup({ tpStyle: 'even' });
  const msg = await A.handleApproval('/매수 1');
  assert.match(msg, /가상 매수/); assert.match(msg, /손절 9,500원/);
  const o = [...db.t.paper_orders.values()][0];
  assert.equal(o.side, 'buy'); assert.equal(+o.price, 10000); assert.equal(o.qty, 100);
  assert.equal(o.plan.stopPct, 5); assert.equal(o.plan.steps.length, 5);
  assert.equal(runs[date].payload.orders['005930'].st, 'open');
  assert.match(await A.handleApproval('/매수 1'), /이미 처리/);           // 같은 승인 두 번 → 주문 1건
  assert.equal(db.t.paper_orders.size, 1);
  await c.close();
});
test('체결되면 알림, 보유에 손절·익절 계획 적용', async () => {
  const { db, c, A, runs, sent, date } = await setup();
  await A.handleApproval('/매수 1');
  c.st.clock += 5000; c.st.vol += 700; await c.t.paper.tick();         // 앞 잔량 500 + 100 체결
  await A.tick();
  assert.equal(runs[date].payload.orders['005930'].st, 'filled');
  assert.ok(sent.some(t => /가상 매수 체결 100주/.test(t)), sent.join('|'));
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.qty, 100); assert.equal(pos.plan.stopPct, 5);
  await c.close();
});
test('3분 미체결 → 매수 1호가로 정정, 다시 3분 미체결 → 취소', async () => {
  const { db, c, A, runs, sent, date } = await setup();
  await A.handleApproval('/매수 1');
  c.st.bids = [[10020, 50], ...c.st.bids.slice(0, 9)]; c.st.asks = c.st.asks.map(([p, q]) => [p + 20, q]);   // 매수 1호가가 10020 으로 올라감
  c.st.clock += 181e3; await A.tick();
  const o1 = runs[date].payload.orders['005930'];
  assert.equal(o1.st, 'modified'); assert.equal(o1.buy2, 10020);
  assert.ok(sent.some(t => /10,020원으로 정정/.test(t)));
  const nw = db.t.paper_orders.get(o1.orderId); assert.equal(+nw.price, 10020); assert.equal(nw.plan.stopPct, 5);   // 계획 유지
  c.st.clock += 181e3; await A.tick();
  assert.equal(runs[date].payload.orders['005930'].st, 'cancelled');
  assert.equal(db.t.paper_orders.get(o1.orderId).status, 'cancelled');
  assert.ok(sent.some(t => /취소/.test(t)));
  await c.close();
});
test('재시작으로 주문 결과를 모를 때: 엔진 주문을 찾아 이어받고, 없으면 다시 내지 않음', async () => {
  const { db, c, A, runs, date } = await setup();
  const t0 = c.st.clock;
  const r = await c.t.paper.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10000, qty: 100, plan: null });
  runs[date].payload.decision = { kind: 'buy', nums: [1] }; runs[date].payload.approved = ['005930']; runs[date].status = 'approved';
  runs[date].payload.orders = { '005930': { st: 'intent', at: t0 } };
  await A.tick();
  assert.equal(runs[date].payload.orders['005930'].st, 'open'); assert.equal(runs[date].payload.orders['005930'].orderId, r.order.id);
  // 엔진에 주문이 없는 경우
  const s2 = await setup();
  s2.runs[s2.date].payload.orders = { '005930': { st: 'intent', at: s2.c.st.clock } };
  s2.c.st.clock += 61e3; await s2.A.tick();
  assert.equal(s2.runs[s2.date].payload.orders['005930'].st, 'lost');
  assert.equal(s2.db.t.paper_orders.size, 0);
  assert.ok(s2.sent.some(t => /다시 내지 않았어요/.test(t)));
  await c.close(); await s2.c.close();
});
test('재확인 실패(알림 후 +1.5% 넘게 오름) → 매수 안 함', async () => {
  const { db, c, A, runs, date } = await setup();
  runs[date].payload.picks[0].price = 9800;          // 현재가 10000 = 알림 대비 +2%
  const msg = await A.handleApproval('/매수 1');
  assert.match(msg, /매수 안 함 — 알림 후 \+2\.0% 더 오름/);
  assert.equal(db.t.paper_orders.size, 0); assert.equal(runs[date].payload.orders['005930'].st, 'skipped');
  await c.close();
});
test('긴급 정지(/kill) 중에는 승인해도 주문 거부', async () => {
  const { db, c, A } = await setup();
  await c.t.adminKill('test');
  const msg = await A.handleApproval('/매수 1');
  assert.match(msg, /주문 실패 — halted/);
  assert.equal(db.t.paper_orders.size, 0);
  await c.close();
});
test('10:30 지나 답이 없으면 만료 기록·알림', async () => {
  const { c, A, runs, sent, date } = await setup();
  c.st.clock += 15 * 60e3;   // 10:31
  await A.tick(); await A.tick();
  assert.equal(runs[date].status, 'expired');
  assert.equal(sent.filter(t => /승인 마감/.test(t)).length, 1);
  await c.close();
});

test('F1 진행 기록·스냅샷: 주문 시점 호가·재확인 수치 저장, 정정·취소가 기록에 남고 최저가로 미체결 이유 표시', async () => {
  const { c, A, runs, date } = await setup();
  await A.handleApproval('/매수 1');
  const o = runs[date].payload.orders['005930'];
  assert.ok(o.snap && o.snap.bids.length > 0 && o.snap.price > 0, '스냅샷');
  assert.equal(o.snap.checks.cttr.min, 100); assert.ok(o.target > 0 || o.target === null);
  c.st.bids = [[10020, 50], ...c.st.bids.slice(0, 9)]; c.st.asks = c.st.asks.map(([p, q]) => [p + 20, q]);
  c.st.clock += 181e3; await A.tick(); c.st.clock += 181e3; await A.tick();
  const L = runs[date].payload.log.map(x => x.k);
  assert.deepEqual(L.filter(k => ['approve', 'order', 'reprice', 'cancel'].includes(k)), ['approve', 'order', 'reprice', 'cancel']);
  assert.match(runs[date].payload.log.find(x => x.k === 'cancel').text, /최저가/);
  assert.match(runs[date].payload.log.find(x => x.k === 'approve').text, /텔레그램에서 매수 승인: 삼성전자/);
  await c.close();
});
test('미체결 설정: 정정하지 않음 + 장 마감까지 유지 → 정정·취소 없음', async () => {
  const { c, A, runs, date, sent } = await setup({ repriceTo: 'none', unfilledEnd: 'keep', fillWaitMin: 2, cancelWaitMin: 5 });
  const msg = await A.handleApproval('/매수 1');
  assert.match(msg, /2분 뒤 정정하지 않고 다시 5분 뒤 남으면 장 마감까지 그대로/);
  c.st.clock += 121e3; await A.tick();
  assert.equal(runs[date].payload.orders['005930'].st, 'modified'); assert.equal(runs[date].payload.orders['005930'].buy2, undefined);
  c.st.clock += 20 * 60e3; await A.tick();
  assert.equal(runs[date].payload.orders['005930'].st, 'modified');
  assert.ok(!sent.some(t => /취소/.test(t)));
  await c.close();
});
test('미체결 설정: 최우선 매도 호가로 정정', async () => {
  const { c, A, runs, date } = await setup({ repriceTo: 'ask1' });
  await A.handleApproval('/매수 1');
  const ask1 = Math.min(...c.st.asks.filter(([p]) => p > 0).map(([p]) => p));
  c.st.clock += 181e3; await A.tick();
  const o = runs[date].payload.orders['005930'];
  assert.equal(o.buy2, ask1);
  await c.close();
});
test('다시 시도: 이력(tries)을 접어 둔 기록에 승인하면 새 주문(번호 구분 cid)을 내고 이력을 보존한다', async () => {
  const X = require('../auto-exec');
  const { db, c, A, runs, date } = await setup();
  await A.handleApproval('/매수 1');
  c.st.clock += 181e3; await A.tick(); c.st.clock += 181e3; await A.tick();       // 정정 후 취소
  const P = runs[date].payload; assert.equal(P.orders['005930'].st, 'cancelled');
  // 다음 검토가 하는 일: 지난 시도를 접고 승인 상태를 되돌림
  P.orders['005930'] = X.foldTry(P.orders['005930'], c.st.clock); P.decision = null; P.picks[0].closed = false; runs[date].status = 'noticed';
  assert.equal(X.tryNo(P.orders['005930']), 2);
  const msg = await A.handleApproval('/매수 1');
  assert.match(msg, /가상 매수/);
  const o = runs[date].payload.orders['005930'];
  assert.equal(o.st, 'open'); assert.equal(o.tries.length, 1); assert.equal(o.tries[0].st, 'cancelled');
  assert.equal(db.t.paper_orders.size, 2);                                       // 새 주문이 실제로 나감(같은 cid 로 막히지 않음)
  assert.ok(runs[date].payload.log.some(l => l.k === 'order' && /2번째 시도/.test(l.text)));
  await c.close();
});
test('다시 시도 대상 판정: 한 주도 못 산 종료 상태만, 횟수 남았을 때만', () => {
  const X = require('../auto-exec');
  assert.equal(X.retryable({ st: 'cancelled', filled: 0 }, 3), true);
  assert.equal(X.retryable({ st: 'skipped', why: '체결강도' }, 3), true);
  assert.equal(X.retryable({ st: 'failed', why: '거부' }, 3), true);
  assert.equal(X.retryable({ st: 'partial_done', filled: 3 }, 3), false);
  assert.equal(X.retryable({ st: 'open' }, 3), false); assert.equal(X.retryable({ st: 'lost' }, 3), false);
  assert.equal(X.retryable({ st: 'skipped', why: '이미 보유·주문 중' }, 3), false);
  assert.equal(X.retryable({ st: 'cancelled', tries: [{}, {}] }, 3), false); assert.equal(X.retryable({ st: 'cancelled', tries: [{}] }, 3), true);
});
test('손익비 하한: 목표가가 낮아 이익÷손실이 기준 미만이면 매수 안 함(재시도도 안 함), 기준 이하면 통과', async () => {
  const X = require('../auto-exec');
  assert.equal(X.rrOf({ buy: 38150, target: 38650, plan: { stop: 36243 } }) < 0.3, true);   // 한국가스공사 사례: +1.3% 목표 ÷ −5% 손절
  assert.equal(X.rrOf({ buy: 100, target: 115, plan: { stop: 95 } }), 3);
  assert.equal(X.rrOf({ buy: 100, target: null, plan: { stop: 95 } }), null);
  assert.equal(X.retryable({ st: 'skipped', why: '손익비 1:0.2 — 기준(1:3) 미달' }, 3), false);
  const s = await setup({ minRr: 5 });
  const msg = await s.A.handleApproval('/매수 1');
  assert.match(msg, /매수 안 함 — 손익비 1:[\d.]+ — 기준\(1:5\) 미달/);
  const o = s.runs[s.date].payload.orders['005930'];
  assert.equal(o.st, 'skipped'); assert.equal(s.db.t.paper_orders.size, 0);
  assert.equal(o.snap.checks.rr.min, 5); assert.ok(o.snap.checks.rr.v < 5);
  await s.c.close();
  const s2 = await setup({ minRr: 0 });                 // 끔 → 기존처럼 주문
  assert.match(await s2.A.handleApproval('/매수 1'), /가상 매수/); assert.equal(s2.db.t.paper_orders.size, 1);
  await s2.c.close();
  const s3 = await setup({ minRr: 0.5 });
  const o3 = (await s3.A.handleApproval('/매수 1'), s3.runs[s3.date].payload.orders['005930']);
  assert.notEqual(o3.st, 'skipped'); assert.ok(o3.snap.checks.rr.v >= 0.5);
  await s3.c.close();
});
