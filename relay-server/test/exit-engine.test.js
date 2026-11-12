'use strict';
/* 4단계 자동 매도 엔진 — 기획안 "4단계에서 통과해야 할 시나리오" 를 그대로 시험 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot, T0 } = require('./paper-harness');
const { allocSteps } = require('../paper');

const STEPS = [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 2 }, { n: 3, p: 10400, q: 2 }, { n: 4, p: 10500, q: 2 }, { n: 5, p: 10600, q: 2 }];
const PLAN = { stopPct: 2, steps: STEPS };   // 평균 10010 → 손절가 9800
const tps = db => [...db.t.paper_orders.values()].filter(o => /^tp/.test(o.reason) && ['open', 'partial'].includes(o.status));
const tpMap = db => Object.fromEntries(tps(db).map(o => [o.reason, o.qty - o.filled_qty]));
/* 가격 이동: 매수·매도호가를 가격 주변으로 다시 만들고 거래량을 더함 */
function move(c, price, { vol = 1000, low, high } = {}) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += vol;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  if (low != null) st.low = low; else st.low = Math.min(st.low, price);
  if (high != null) st.high = high; else st.high = Math.max(st.high, price);
}
async function holding(c, qty = 10, plan = PLAN) {
  const r = await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty, plan });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

test('익절 수량 배분: 비중대로, 남는 주식은 앞 단계부터, 이미 판 만큼 제외', () => {
  assert.deepEqual(allocSteps(STEPS, 10), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 });
  assert.deepEqual(allocSteps(STEPS, 4), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 0 });
  const w = [{ n: 1, p: 1, q: 2 }, { n: 2, p: 1, q: 2 }, { n: 3, p: 1, q: 2 }, { n: 4, p: 1, q: 2 }, { n: 5, p: 1, q: 4 }];
  assert.deepEqual(allocSteps(w, 12), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 4 });
  const sold = STEPS.map(s => ({ ...s, sold: s.n <= 2 ? 2 : 0 }));
  assert.deepEqual(allocSteps(sold, 6), { 1: 0, 2: 0, 3: 2, 4: 2, 5: 2 });
  const over = STEPS.map(s => ({ ...s, sold: s.n === 1 ? 2 : 0 }));   // 수동 매도로 base 가 줄어든 경우에도 합계 = avail
  const a = allocSteps(over, 5); assert.equal(Object.values(a).reduce((x, y) => x + y, 0), 5);
});

test('매수 체결 → 다음 주기에 익절 5단계 주문 접수, 대기 주문은 그대로 유지(다시 걸지 않음)', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  assert.deepEqual(tpMap(db), { tp1: 2, tp2: 2, tp3: 2, tp4: 2, tp5: 2 });
  const ids = tps(db).map(o => o.id).sort();
  move(c, 10010); await c.t.paper.tick();
  assert.deepEqual(tps(db).map(o => o.id).sort(), ids);
  await c.close();
});

test('시나리오: 매수가 일부만 체결 → 체결된 수량만큼만 익절, 추가 체결 시 다시 배분', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 10, plan: PLAN });   // 9990 에 앞 대기 400
  c.st.clock += 5000; c.st.price = 9990; c.st.vol += 404; await c.t.paper.tick();   // 4주 체결
  assert.equal(db.t.paper_positions.get('005930').qty, 4);
  assert.deepEqual(tpMap(db), { tp1: 1, tp2: 1, tp3: 1, tp4: 1 });
  c.st.clock += 5000; c.st.vol += 6; await c.t.paper.tick();                        // 나머지 6주
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'filled');
  assert.deepEqual(tpMap(db), { tp1: 2, tp2: 2, tp3: 2, tp4: 2, tp5: 2 });
  await c.close();
});

test('시나리오: 1~2단계 익절 후 손절가에 닿음 → 남은 익절 취소 후 남은 수량 전부 시장가 매도', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  move(c, 10350, { vol: 5000 }); await c.t.paper.tick();         // 10200·10300 익절 체결
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.qty, 6);
  assert.deepEqual(pos.plan.steps.map(s => s.sold), [2, 2, 0, 0, 0]);
  assert.deepEqual(tpMap(db), { tp3: 2, tp4: 2, tp5: 2 });
  assert.ok(c.st.alerts.some(a => /익절 1단계/.test(a)));
  move(c, 9790); await c.t.paper.tick();                           // 손절가 9800 이하
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.equal(tps(db).length, 0);
  assert.ok([...db.t.paper_orders.values()].filter(o => /^tp/.test(o.reason) && o.status === 'cancelled').every(o => o.note === 'stop' || o.status === 'filled'));
  const stopFills = [...db.t.paper_fills.values()].filter(f => f.reason === 'stop');
  assert.equal(stopFills.reduce((a, f) => a + f.qty, 0), 6);
  assert.ok(db.t.paper_events.some(e => e.kind === 'stop'));
  assert.ok(c.st.alerts.some(a => /^손절/.test(a)));
  await c.close();
});

test('시나리오: 손절 매도가 체결되지 못하면(매수호가 없음) 알림 후 다음 주기에 다시 시도', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  move(c, 9700); c.st.bids = [[0, 0]]; await c.t.paper.tick();     // 하한가 근처처럼 매수호가가 없음
  assert.equal(db.t.paper_positions.get('005930').qty, 10);
  assert.equal(tps(db).length, 0);                                  // 익절 주문은 이미 취소
  assert.ok(c.st.alerts.some(a => /손절 매도 실패/.test(a)));
  move(c, 9700); await c.t.paper.tick();
  assert.equal(db.t.paper_positions.has('005930'), false);
  await c.close();
});

test('시나리오: 손절은 시세 사이에 잠깐 찍은 저가도 잡음 · 긴급 정지 중에도 동작', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000, { low: 9900 }); await c.t.paper.tick();
  await c.call('POST', '/trade/kill');
  move(c, 9950, { low: 9790 }); await c.t.paper.tick();            // 현재가는 손절가 위지만 새 저가가 9790
  assert.equal(db.t.paper_positions.has('005930'), false);
  await c.close();
});

test('시나리오: relay 가 장중에 재시작 → 익절 주문을 중복으로 걸지 않고 감시 재개 알림', async () => {
  const db = fakeDb(); const c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const ids = tps(db).map(o => o.id).sort();
  await c.close();
  const c2 = await boot(db, { clock: c.st.clock + 60000 });
  move(c2, 10000); await c2.t.paper.tick();
  assert.deepEqual(tps(db).map(o => o.id).sort(), ids);
  assert.ok(c2.st.alerts.some(a => /재시작/.test(a)));
  move(c2, 9790); await c2.t.paper.tick();                          // 재시작 후에도 손절 동작
  assert.equal(db.t.paper_positions.has('005930'), false);
  await c2.close();
});

test('시나리오: 장 마감에 당일 주문 소멸 → 다음 날 갭 하락 시가에 즉시 손절', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-13T15:31:00+09:00'); await c.t.paper.tick();
  assert.equal(tps(db).length, 0);
  assert.ok([...db.t.paper_orders.values()].some(o => o.note === 'expired'));
  assert.ok(c.st.alerts.some(a => /장 마감/.test(a)));
  c.st.clock = Date.parse('2027-01-14T09:00:05+09:00') - 5000; move(c, 9600, { low: 9600, high: 9600 });
  await c.t.paper.tick();
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.ok(c.st.alerts.some(a => /감시 시작/.test(a)));
  await c.close();
});

test('다음 날 갭 하락이 아니면 익절 주문을 다시 접수', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-13T15:31:00+09:00'); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-14T09:00:05+09:00') - 5000; move(c, 10050);
  await c.t.paper.tick();
  assert.deepEqual(tpMap(db), { tp1: 2, tp2: 2, tp3: 2, tp4: 2, tp5: 2 });
  await c.close();
});

test('시나리오: 같은 주문 버튼을 연달아 눌러도(같은 cid) 주문은 한 번', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const b = { code: '005930', side: 'buy', type: 'market', qty: 5, cid: 'click-abc-123' };
  const [r1, r2] = await Promise.all([c.order(b), c.order(b)]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(db.t.paper_orders.size, 1);
  const r3 = await c.order(b); assert.equal(r3.body.duplicate, true);
  assert.equal(db.t.paper_positions.get('005930').qty, 5);
  await c.close();
});

test('시나리오: 보유 중 계획 수정 → 검증 후 익절 주문을 새 가격으로 다시 접수', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const plan = b => c.call('POST', '/trade/paper/plan', { body: { code: '005930', ...b } });
  assert.equal((await plan({ stopPct: 3, steps: [{ n: 1, p: 10500, q: 9 }] })).status, 400);      // 합계 9 ≠ 10
  assert.equal((await plan({ steps: [{ n: 1, p: 10500, q: 10 }] })).status, 400);                 // 손절 없음
  assert.equal((await plan({ code: '000660', stopPct: 3, steps: [] })).status, 404);
  const ok = await plan({ stop: 9500, steps: [{ n: 1, p: 10500, q: 4 }, { n: 2, p: 10800, q: 6 }] });
  assert.equal(ok.status, 200); assert.equal(ok.body.position.stop, 9500);
  assert.equal(tps(db).length, 0);                                                                   // 기존 익절 취소
  move(c, 10000); await c.t.paper.tick();
  assert.deepEqual(tpMap(db), { tp1: 4, tp2: 6 });
  assert.ok(tps(db).every(o => (o.reason === 'tp1' ? 10500 : 10800) === +o.price));
  move(c, 9790); await c.t.paper.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 10);                                          // 새 손절가 9500 위라 유지
  assert.ok(db.t.trade_audit.some(a => a.event === 'paper_plan' && a.ok));
  await c.close();
});

test('수동 매도: 익절 주문을 먼저 취소하고 남은 수량으로 다시 배분, 전량 매도면 계획 종료', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const r = await c.order({ code: '005930', side: 'sell', type: 'market', qty: 3 });
  assert.equal(r.status, 200);
  assert.equal(db.t.paper_positions.get('005930').qty, 7);
  move(c, 10000); await c.t.paper.tick();
  assert.equal(Object.values(tpMap(db)).reduce((a, x) => a + x, 0), 7);
  await c.order({ code: '005930', side: 'sell', type: 'market', qty: 7 });
  move(c, 10000); await c.t.paper.tick();
  assert.equal(tps(db).length, 0); assert.equal(db.t.paper_positions.has('005930'), false);
  await c.close();
});

test('자동 매도 주문은 화면의 취소 버튼으로 취소할 수 없음', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const r = await c.call('POST', '/trade/paper/cancel', { body: { id: tps(db)[0].id } });
  assert.equal(r.status, 409);
  await c.close();
});

test('상태 조회에 손절가·매도 가능 수량·감시 상태 포함', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const s = await c.call('GET', '/trade/paper/state');
  assert.equal(s.body.positions[0].stop, 9800); assert.equal(s.body.positions[0].avail, 10);
  assert.ok(s.body.engine.lastTick > 0);
  assert.ok(s.body.orders.some(o => o.reason === 'tp1'));
  await c.close();
});
