'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../paper-engine');

const book = (asks, bids) => ({
  asks: asks.map(([p, q]) => ({ p, q })), bids: bids.map(([p, q]) => ({ p, q })),
  price: bids[0][0], vol: 1000, low: 9000, high: 11000, upper: 13000, lower: 7000,
});
// 매도호가 10050/10100/10150, 매수호가 10000/9950/9900
const Q = () => book([[10050, 100], [10100, 200], [10150, 300]], [[10000, 500], [9950, 400], [9900, 300]]);

test('호가단위·검증', () => {
  assert.equal(E.tickOf(1999), 1); assert.equal(E.tickOf(2000), 5); assert.equal(E.tickOf(50000), 100); assert.equal(E.tickOf(500000), 1000);
  assert.equal(E.floorTick(10333), 10330); assert.ok(E.validTick(10330)); assert.ok(!E.validTick(10333)); assert.ok(!E.validTick(0));
});

test('매수 지정가: 매도호가 이하만 낮은 호가부터 소진, 남으면 대기', () => {
  const r = E.submit({ side: 'buy', type: 'limit', price: 10100, qty: 400 }, Q());
  assert.deepEqual(r.fills, [{ p: 10050, q: 100 }, { p: 10100, q: 200 }]);
  assert.equal(r.rest, 100);
  assert.equal(r.state.queueAhead, 0);        // 10100 은 매수호가(10000) 위 = 내가 최우선
});

test('매수 지정가가 호가 아래면 전부 대기 + 같은 가격 잔량이 앞 대기', () => {
  const r = E.submit({ side: 'buy', type: 'limit', price: 9950, qty: 50 }, Q());
  assert.deepEqual(r.fills, []); assert.equal(r.rest, 50); assert.equal(r.state.queueAhead, 400);
  const r2 = E.submit({ side: 'buy', type: 'limit', price: 9850, qty: 50 }, Q());   // 호가창 밖 → 끝 잔량 300 근사
  assert.equal(r2.state.queueAhead, 300);
  const r3 = E.submit({ side: 'buy', type: 'limit', price: 9990, qty: 50 }, Q());   // 호가 사이(10000 아래·9950 위) → 앞 잔량 없음(같은 가격에 대기 없음)
  assert.equal(r3.state.queueAhead, 0);
});

test('시장가 매수: 호가 소진 후 부족분은 마지막 호가보다 2호가 불리하게', () => {
  const r = E.submit({ side: 'buy', type: 'market', qty: 700 }, Q());
  assert.deepEqual(r.fills, [{ p: 10050, q: 100 }, { p: 10100, q: 200 }, { p: 10150, q: 300 }, { p: 10170, q: 100 }]);
  assert.equal(r.rest, 0);
});

test('시장가 매도: 매수호가를 높은 것부터, 부족분은 2호가 아래', () => {
  const r = E.submit({ side: 'sell', type: 'market', qty: 1300 }, Q());
  assert.deepEqual(r.fills, [{ p: 10000, q: 500 }, { p: 9950, q: 400 }, { p: 9900, q: 300 }, { p: 9880, q: 100 }]);
});

test('상·하한가 안에서만 불리 체결', () => {
  const q = Q(); q.upper = 10160;
  const r = E.submit({ side: 'buy', type: 'market', qty: 700 }, q);
  assert.equal(r.fills.at(-1).p, 10160);
});

test('시장가인데 호가가 아예 없으면 거부', () => {
  const q = Q(); q.asks = [{ p: 0, q: 0 }];
  assert.ok(E.submit({ side: 'buy', type: 'market', qty: 10 }, q).reject);
  const l = E.submit({ side: 'buy', type: 'limit', price: 10500, qty: 10 }, q);   // 지정가는 대기
  assert.equal(l.rest, 10); assert.deepEqual(l.fills, []);
});

test('지정가 매수가 보이는 호가를 다 쓰고도 남으면 지정가 이내 불리 체결', () => {
  const r = E.submit({ side: 'buy', type: 'limit', price: 10160, qty: 700 }, Q());
  assert.equal(r.rest, 0); assert.equal(r.fills.at(-1).p, 10160);   // 불리 체결가(10170)가 지정가 10160 을 넘지 못함
});

test('대기 주문: 같은 가격 체결은 앞 잔량을 먼저 소진', () => {
  const o = { side: 'buy', price: 9950, qty: 100, filled: 0, queueAhead: 400, lastVol: 1000, lowSeen: 9000 };
  let q = Q(); q.price = 9950; q.vol = 1300;                 // 거래량 300 < 앞 잔량 400
  assert.deepEqual(E.restFill(o, q), []); assert.equal(o.queueAhead, 100);
  q = Q(); q.price = 9950; q.vol = 1500;                      // +200 → 앞 100 소진 후 100 체결
  const f = E.restFill(o, q);
  assert.deepEqual(f, [{ p: 9950, q: 100 }]); assert.equal(o.queueAhead, 0);
});

test('대기 주문: 가격이 내 가격 아래로 지나가면 거래량 한도 안에서 체결', () => {
  const o = { side: 'buy', price: 9950, qty: 300, filled: 0, queueAhead: 100, lastVol: 1000, lowSeen: 9000 };
  const q = Q(); q.price = 9900; q.vol = 1250; q.asks = [{ p: 9950, q: 500 }];   // 거래량 +250
  q.asks = [{ p: 10000, q: 50 }];   // 매도호가가 내 가격 위 → 즉시 체결 아님
  const f = E.restFill(o, q);
  assert.deepEqual(f, [{ p: 9950, q: 150 }]);   // 250 - 앞 100
});

test('대기 주문: 거래량이 안 늘면 지나가도 체결 안 함', () => {
  const o = { side: 'buy', price: 9950, qty: 300, filled: 0, queueAhead: 0, lastVol: 1000, lowSeen: 9000 };
  const q = Q(); q.price = 9900; q.vol = 1000;
  assert.deepEqual(E.restFill(o, q), []);
});

test('대기 주문: 새 저가가 내 가격 아래로 찍히면(순간 하락) 체결', () => {
  const o = { side: 'buy', price: 9950, qty: 100, filled: 0, queueAhead: 0, lastVol: 1000, lowSeen: 9500 };
  const q = Q(); q.price = 10000; q.low = 9400; q.vol = 1060;
  assert.deepEqual(E.restFill(o, q), [{ p: 9950, q: 60 }]);
});

test('대기 주문: 이미 있던 저가는 새 체결로 보지 않음', () => {
  const o = { side: 'buy', price: 9950, qty: 100, filled: 0, queueAhead: 0, lastVol: 1000, lowSeen: 9000 };
  const q = Q(); q.price = 10000; q.low = 9000; q.vol = 1500;
  assert.deepEqual(E.restFill(o, q), []);
});

test('대기 주문: 호가가 내 가격을 넘어오면 그 호가 가격으로 체결(내 가격보다 유리)', () => {
  const o = { side: 'buy', price: 10100, qty: 150, filled: 0, queueAhead: 0, lastVol: 1000, lowSeen: 9000 };
  const q = Q();
  const f = E.restFill(o, q);
  assert.deepEqual(f, [{ p: 10050, q: 100 }, { p: 10100, q: 50 }]);
});

test('대기 매도(대칭): 가격이 위로 지나가면 체결', () => {
  const o = { side: 'sell', price: 10100, qty: 100, filled: 0, queueAhead: 0, lastVol: 1000, highSeen: 10500 };
  const q = Q(); q.price = 10200; q.vol = 1080; q.asks = [{ p: 10250, q: 10 }]; q.bids = [{ p: 10150, q: 10 }];
  const f = E.restFill(o, q);
  assert.ok(f.length >= 1);
  assert.ok(f.reduce((a, x) => a + x.q, 0) <= 100);
});

test('같은 시세 안에서 호가 잔량을 두 번 쓰지 않음(sharedBook)', () => {
  const q = Q(), shared = E.cloneBook(q);
  const a = { side: 'buy', price: 10100, qty: 250, filled: 0, queueAhead: 0, lastVol: q.vol };
  const b = { side: 'buy', price: 10100, qty: 250, filled: 0, queueAhead: 0, lastVol: q.vol };
  const fa = E.summarize(E.restFill(a, q, shared)), fb = E.summarize(E.restFill(b, q, shared));
  assert.equal(fa.qty + fb.qty, 300);   // 10050(100)+10100(200)만 존재
});

test('포지션 반영: 평균단가·실현손익', () => {
  let r = E.applyFill(null, 'buy', 10000, 10); assert.deepEqual(r.pos, { qty: 10, avg: 10000 });
  r = E.applyFill(r.pos, 'buy', 11000, 10); assert.equal(r.pos.avg, 10500);
  r = E.applyFill(r.pos, 'sell', 11500, 5); assert.equal(r.realized, 5000); assert.equal(r.pos.qty, 15);
  r = E.applyFill(r.pos, 'sell', 10000, 15); assert.equal(r.pos, null); assert.equal(r.realized, -7500);
});

test('재시작 직후(lastVol 없음)에는 거래량 차이를 몰라 체결 인정 안 함', () => {
  const o = { side: 'buy', price: 9950, qty: 100, filled: 0, queueAhead: 0, lastVol: null, lowSeen: null };
  const q = Q(); q.price = 9900; q.low = 9000; q.vol = 5000000;
  assert.deepEqual(E.restFill(o, q), []);
  assert.equal(o.lastVol, 5000000);
});
