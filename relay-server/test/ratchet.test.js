'use strict';
/* 손절 올리기(래칫) · 러너 · 새 익절 단계(splitPlanR) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot } = require('./paper-harness');
const RT = require('../ratchet');
const E = require('../paper-engine');
const X = require('../auto-exec');

const mkPlan = (extra = {}) => ({ stopPct: 5, ratchet: { floorPct: 0.35 }, steps: [{ n: 1, p: 10500, q: 20 }, { n: 2, p: 11000, q: 20 }, { n: 3, p: 11500, q: 40 }, { n: 4, p: 11500, q: 20, runner: true }], ...extra });

test('손절선: 최고수익 2.5%까지는 −5%, 2.5→5%에서 본전(+0.35%)까지 선형, 이후 본전 · 내려가지 않음', () => {
  const sp = pk => RT.ratchetStop(mkPlan(), 10000, pk, E.floorTick);
  assert.equal(sp(0), 9500); assert.equal(sp(10200), 9500); assert.equal(sp(10250), 9500);
  assert.ok(sp(10375) > 9500 && sp(10375) < 10035);
  assert.equal(sp(10500), 10040); assert.equal(sp(13000), 10040);
  let prev = 0; for (let pk = 10000; pk <= 12000; pk += 25) { const v = sp(pk); assert.ok(v >= prev); prev = v; }
  assert.equal(RT.ratchetStop({ stopPct: 5, steps: [] }, 10000, 13000, E.floorTick), 9500);   // ratchet 없으면 예전 그대로
});

test('손절선: 단계 체결 규칙 — 1단계 → 본전, 2단계 → 1단계 가, 3단계 → 2단계 가 (러너는 세지 않음)', () => {
  const pl = mkPlan(); pl.steps[0].fired = true;
  assert.equal(RT.ratchetStop(pl, 10000, 10500, E.floorTick), 10040);
  pl.steps[1].fired = true;
  assert.equal(RT.ratchetStop(pl, 10000, 11000, E.floorTick), 10500);
  pl.steps[2].sold = 40; pl.steps[2].q = 40;
  assert.equal(RT.ratchetStop(pl, 10000, 11500, E.floorTick), 11000);
  pl.steps[3].fired = true;   // 러너가 팔려도 코어 규칙은 그대로
  assert.equal(RT.ratchetStop(pl, 10000, 11500, E.floorTick), 11000);
});

test('러너 트레일링 폭: 고점수익 15% 미만 −5% · 15~30% −4% · 30%↑ −3%', () => {
  assert.deepEqual([0, 14.9, 15, 29.9, 30, 80].map(RT.swingWidth), [5, 5, 4, 4, 3, 3]);
});

test('새 익절 단계: 10,000원 100주·목표 11,500원 → 10,500/11,000/11,500 = 20/20/40 + 러너 20(목표가), 합 100', () => {
  const { steps } = X.splitPlanR(10000, 11500, 100, { stopPct: 5, runnerPct: 20 });
  assert.deepEqual(steps.map(s => [s.n, s.p, s.q, !!s.runner]), [[1, 10500, 20, false], [2, 11000, 20, false], [3, 11500, 40, false], [4, 11500, 20, true]]);
  const far = X.splitPlanR(10000, 19680, 100, { stopPct: 5, runnerPct: 20 }).steps;   // 삼현처럼 목표가 아주 멀어도 2단계는 최대 +10%
  assert.deepEqual(far.map(s => s.p), [10500, 11000, 19680, 19680]);
  const few = X.splitPlanR(10000, 11500, 3, { stopPct: 5, runnerPct: 20 }).steps;        // 수량이 적으면 러너 없이 코어만, 합 = 수량
  assert.equal(few.reduce((a, s) => a + s.q, 0), 3); assert.ok(!few.some(s => s.runner));
  const low = X.splitPlanR(10000, 10400, 100, { stopPct: 5, runnerPct: 20 }).steps;      // 목표가 1R 안쪽이면 목표에서 한 번
  assert.equal(low.reduce((a, s) => a + s.q, 0), 100); assert.equal(low[0].p, 10400);
});

test('주문 만들기: tpStyle r → 새 단계 + ratchet 표시, 예전 방식이면 균등 5분할·ratchet 없음, 종가베팅 저녁 매수(noTp)는 익절·ratchet 없음', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10 }));
  const q = { price: 10000, upper: 13000, bids: [{ p: 9990, q: 500 }], asks: [{ p: 10010, q: 500 }], amt: 5e10 };
  const a = X.makeOrder({ q, rows, perStockKrw: 1e6, opt: { tpStyle: 'r', ratchet: true, runnerPct: 20 } });
  assert.ok(a.plan.ratchet && a.plan.steps.some(s => s.runner));
  const b = X.makeOrder({ q, rows, perStockKrw: 1e6, opt: { tpStyle: 'even' } });
  assert.ok(!b.plan.ratchet && b.plan.steps.length === 5 && !b.plan.steps.some(s => s.runner));
  const c = X.makeOrder({ q, rows, perStockKrw: 1e6, opt: { tpStyle: 'r', ratchet: true, noTp: true } });
  assert.deepEqual(c.plan.steps, []); assert.ok(!c.plan.ratchet);
});

const move = (c, price, { vol = 1000 } = {}) => {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += vol;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
};
const PLAN = { stopPct: 5, ratchet: { floorPct: 0.35 }, steps: [{ n: 1, p: 10500, q: 2 }, { n: 2, p: 11000, q: 2 }, { n: 3, p: 11500, q: 4 }, { n: 4, p: 11500, q: 2, runner: true }] };

test('엔진: 1단계 익절 뒤 하락하면 남은 수량은 본전 근처에서 손절(손실 없음)', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: PLAN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pos0 = () => db.t.paper_positions.get('005930');
  const avg = (await c.t.paper.state()).positions.find(p => p.code === '005930').avg;
  assert.ok(pos0().plan.ratchet && pos0().plan.steps[3].runner);
  move(c, 10000); await c.t.paper.tick();
  move(c, 10520); await c.t.paper.tick();                                   // 1단계 감시 시작 · 고점 10520 → 손절선은 본전으로
  const sp1 = (await c.t.paper.state()).positions.find(p => p.code === '005930').stop;
  assert.ok(sp1 >= avg * 1.0035 - 1, `${sp1} ${avg}`);
  move(c, 10300); await c.t.paper.tick();                                   // 고점 −2% 아래 → 1단계 2주 매도
  assert.equal(pos0().qty, 8);
  move(c, sp1 - 20); await c.t.paper.tick();                                // 올라간 손절선 아래 → 나머지 전량
  assert.ok(!pos0() || pos0().qty === 0, '남은 수량이 손절돼야 함');
  const sells = [...db.t.paper_orders.values()].filter(o => o.side === 'sell');
  assert.ok(sells.some(o => o.reason === 'stop'));
  await c.close();
});

test('엔진: 러너는 목표가 도달 전엔 안 팔리고, 도달 후 고점 대비 −5%에서 팔림 · 계획 수정해도 러너·ratchet 이어받음', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: PLAN });
  const pos0 = () => db.t.paper_positions.get('005930');
  move(c, 10000); await c.t.paper.tick();
  move(c, 11600); await c.t.paper.tick();                                   // 전 단계 감시 시작 · 고점 11600
  const run = () => pos0().plan.steps.find(s => s.runner);
  assert.ok(run().armed);
  move(c, 11200); await c.t.paper.tick();                                   // 고점 −3.4%: 코어(−2%)는 팔리고 러너(−5% 폭)는 유지
  assert.equal(pos0().qty, 2);
  assert.equal(pos0().plan.steps.filter(s => !s.runner).every(s => s.sold === s.q || s.fired), true);
  move(c, 11000); await c.t.paper.tick();                                   // 11600×0.95=11020 아래 → 러너 매도
  assert.ok(!pos0() || pos0().qty === 0);
  await c.close();
  const db2 = fakeDb(), c2 = await boot(db2); await c2.login();
  await c2.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: PLAN });
  const e = await c2.t.paper.editPlan({ code: '005930', stop: 9600, steps: [{ n: 1, p: 10600, q: 3 }, { n: 2, p: 11000, q: 2 }, { n: 3, p: 11600, q: 3 }, { n: 4, p: 11600, q: 2 }] });
  assert.equal(e.ok, true, JSON.stringify(e));
  const pl = db2.t.paper_positions.get('005930').plan;
  assert.ok(pl.ratchet); assert.equal(pl.steps.filter(s => s.runner).length, 1);
  await c2.t.paper.editPlan({ code: '005930', stopPct: 5, steps: [], ratchet: null });   // 이월 전환: 해제
  assert.equal(db2.t.paper_positions.get('005930').plan.ratchet, null);
  await c2.close();
});
