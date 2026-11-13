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

test('트레일링 익절: 주문을 미리 걸지 않음 → 익절가 도달 시 감시 시작 → 고점 대비 2% 하락 시 도달한 단계 수량만 시장가 매도', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  assert.equal(tps(db).length, 0);                                      // 미리 걸어 두지 않음
  move(c, 10250); await c.t.paper.tick();                                // 1단계(10200) 도달 → 감시
  let st = db.t.paper_positions.get('005930').plan.steps;
  assert.deepEqual(st.map(s => !!s.armed), [true, false, false, false, false]);
  assert.ok(c.st.alerts.some(a => /익절 1단계 감시 시작/.test(a)));
  move(c, 10450); await c.t.paper.tick();                                // 2·3단계도 도달, 고점 10450
  move(c, 10260); await c.t.paper.tick();                                // 10450×0.98=10241 위 → 아직 안 팜
  assert.equal(db.t.paper_positions.get('005930').qty, 10);
  move(c, 10240); await c.t.paper.tick();                                // 고점 대비 -2% → 1~3단계 2주씩 매도
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.qty, 4);
  assert.deepEqual(pos.plan.steps.map(s => s.sold), [2, 2, 2, 0, 0]);
  assert.ok([...db.t.paper_orders.values()].filter(o => /^tp/.test(o.reason)).every(o => o.type === 'market' && o.note === 'trail'));
  assert.ok(c.st.alerts.some(a => /익절 1단계\(트레일링\)/.test(a)));
  move(c, 10100); await c.t.paper.tick();                                // 4·5단계는 도달 안 했으니 유지
  assert.equal(db.t.paper_positions.get('005930').qty, 4);
  await c.close();
});

test('시나리오: 매수가 일부만 체결 → 체결된 수량만 계획 대상, 미리 걸리는 익절 주문 없음', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 10, plan: PLAN });   // 9990 에 앞 대기 400
  c.st.clock += 5000; c.st.price = 9990; c.st.vol += 404; await c.t.paper.tick();   // 4주 체결
  assert.equal(db.t.paper_positions.get('005930').qty, 4);
  assert.equal(tps(db).length, 0);
  c.st.clock += 5000; c.st.vol += 6; await c.t.paper.tick();                        // 나머지 6주
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'filled');
  assert.equal(db.t.paper_positions.get('005930').qty, 10); assert.equal(tps(db).length, 0);
  await c.close();
});

test('시나리오: 1~2단계 트레일링 익절 후 손절가에 닿음 → 남은 수량 전부 시장가 매도', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  move(c, 10350); await c.t.paper.tick();                        // 1·2단계 감시
  move(c, 10140); await c.t.paper.tick();                        // 10350×0.98=10143 아래 → 1·2단계 매도
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.qty, 6);
  assert.deepEqual(pos.plan.steps.map(s => s.sold), [2, 2, 0, 0, 0]);
  move(c, 9790); await c.t.paper.tick();                           // 손절가 9800 이하
  assert.equal(db.t.paper_positions.has('005930'), false);
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

test('시나리오: relay 가 장중에 재시작 → 감시 상태(감시 시작·고점)를 이어받고 재개 알림', async () => {
  const db = fakeDb(); const c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  move(c, 10250); await c.t.paper.tick();                           // 1단계 감시 시작
  await c.close();
  const c2 = await boot(db, { clock: c.st.clock + 60000 });
  move(c2, 10250); await c2.t.paper.tick();
  assert.ok(c2.st.alerts.some(a => /재시작/.test(a)));
  assert.equal(db.t.paper_positions.get('005930').plan.steps[0].armed, true);
  move(c2, 10040); await c2.t.paper.tick();                         // 10250×0.98=10045 아래 → 1단계 매도
  assert.equal(db.t.paper_positions.get('005930').qty, 8);
  move(c2, 9790); await c2.t.paper.tick();                          // 재시작 후에도 손절 동작
  assert.equal(db.t.paper_positions.has('005930'), false);
  await c2.close();
});

test('시나리오: 장 마감에 당일 주문 소멸 → 다음 날 갭 하락 시가에 즉시 손절', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-13T15:31:00+09:00'); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-13T20:01:00+09:00'); await c.t.paper.tick();
  assert.ok(c.st.alerts.some(a => /장 마감/.test(a)));                       // 마감 요약은 20:00 이후
  c.st.clock = Date.parse('2027-01-14T09:00:05+09:00') - 5000; move(c, 9600, { low: 9600, high: 9600 });
  await c.t.paper.tick();
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.ok(c.st.alerts.some(a => /감시 시작/.test(a)));
  await c.close();
});

test('익절가 위로 갭 상승 출발 → 그 단계들 감시 시작(바로 팔지 않음)', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-14T09:00:05+09:00') - 5000; move(c, 10450);
  await c.t.paper.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 10);
  assert.deepEqual(db.t.paper_positions.get('005930').plan.steps.map(s => !!s.armed), [true, true, true, false, false]);
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

test('시나리오: 보유 중 계획 수정 → 새 가격으로 감시', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const plan = b => c.call('POST', '/trade/paper/plan', { body: { code: '005930', ...b } });
  assert.equal((await plan({ steps: [{ n: 1, p: 4000, q: 10 }] })).status, 400);                  // 평균가 절반 이하 익절가
  assert.equal((await plan({ code: '000660', stopPct: 3, steps: [] })).status, 404);
  const ok = await plan({ stop: 9500, steps: [{ n: 1, p: 10500, q: 4 }, { n: 2, p: 10800, q: 6 }] });
  assert.equal(ok.status, 200); assert.equal(ok.body.position.stop, 9500);
  move(c, 10000); await c.t.paper.tick();
  assert.equal(tps(db).length, 0);
  move(c, 9790); await c.t.paper.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 10);                                          // 새 손절가 9500 위라 유지
  assert.ok(db.t.trade_audit.some(a => a.event === 'paper_plan' && a.ok));
  await c.close();
});

test('보유 계획: 손절만 · 익절만 · 단계 삭제(남은 단계가 수량을 나눠 가짐) · 모두 지우면 계획 해제', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const plan = b => c.call('POST', '/trade/paper/plan', { body: { code: '005930', ...b } });
  let r = await plan({ steps: [{ n: 1, p: 10500, q: 5 }, { n: 2, p: 10800, q: 5 }] });          // 익절만
  assert.equal(r.status, 200, 'call1 '+JSON.stringify(r.body)); assert.equal(r.body.position.stop, null);
  move(c, 9000); await c.t.paper.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 10);                                          // 손절 없으니 유지
  r = await plan({ steps: [{ n: 1, p: 10500, q: 5 }] });                                             // 2단계 삭제 → 1단계가 10주 전부
  assert.equal(r.status, 200, 'call2 '+JSON.stringify(r.body));
  assert.equal(db.t.paper_positions.get('005930').plan.steps.length, 1);
  r = await plan({ stopPct: 3, steps: [] });                                                         // 손절만
  assert.equal(r.status, 200, 'call3 '+JSON.stringify(r.body)); assert.ok(r.body.position.stop > 0);
  move(c, 9800); await c.t.paper.tick();                                                             // 손절가(9,700) 위
  assert.equal(tps(db).length, 0);
  r = await plan({ steps: [] });                                                                     // 모두 삭제
  assert.equal(r.status, 200, 'call4 '+JSON.stringify(r.body)); assert.equal(r.body.position.plan, null);
  await c.close();
});

test('수동 매도 후 남은 수량이 익절 단계에 다시 배분, 전량 매도면 계획 종료', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  const r = await c.order({ code: '005930', side: 'sell', type: 'market', qty: 3 });
  assert.equal(r.status, 200);
  assert.equal(db.t.paper_positions.get('005930').qty, 7);
  move(c, 10650); await c.t.paper.tick(); move(c, 10430); await c.t.paper.tick();   // 5단계 모두 감시 → 10650×0.98=10437 아래 전부 매도
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.equal([...db.t.paper_fills.values()].filter(f => /^tp/.test(f.reason)).reduce((a, f) => a + f.qty, 0), 7);
  await c.close();
});

test('자동 매도 주문(시간외 손절 지정가 대기)은 화면의 취소 버튼으로 취소할 수 없음', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await holding(c);
  move(c, 10000); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-13T16:10:00+09:00'); move(c, 9750); c.st.bids = Array.from({ length: 10 }, (_, i) => [9700 - 10 * i, 1]); c.st.asks = [[9760, 100]];
  await c.t.paper.tick();
  const stop = [...db.t.paper_orders.values()].find(o => o.reason === 'stop' && ['open', 'partial'].includes(o.status));
  assert.ok(stop, JSON.stringify([...db.t.paper_orders.values()].map(o=>[o.reason,o.type,o.status,o.price,o.qty,o.filled_qty]))+JSON.stringify(c.st.alerts.slice(-3)));
  await c.login();
  const r = await c.call('POST', '/trade/paper/cancel', { body: { id: stop.id } });
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
  assert.ok(Array.isArray(s.body.positions[0].plan.steps));
  await c.close();
});
