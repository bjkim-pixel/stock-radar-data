'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { fakeDb, boot, T0 } = require('./paper-harness');

test('세션 없이는 가상매매 API 거부', async () => {
  const db = fakeDb(), c = await boot(db);
  assert.equal((await c.call('GET', '/trade/paper/state')).status, 401);
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 401);
  await c.close();
});

test('시장가 매수: 호가 소진 체결 · 보유·체결·감사 기록 · 주문 전 DB 저장', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 250, plan: { stopPct: 5, stop: 9500, target: 10500, steps: [{ n: 1, p: 10300, q: 50 }] } });
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'filled'); assert.equal(r.body.order.filled, 250);
  assert.deepEqual(r.body.fills.map(f => [f.price, f.qty]), [[10010, 100], [10020, 150]]);
  assert.equal(db.t.paper_orders.size, 1);
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.qty, 250); assert.ok(Math.abs(pos.avg_price - (10010 * 100 + 10020 * 150) / 250) < 1e-6);
  assert.equal(pos.plan.stop, 9500); assert.equal(pos.plan.steps.length, 1);
  assert.equal(db.t.paper_fills.size, 2);
  assert.ok(db.t.paper_book_snaps.some(s => s.kind === 'fill' && s.code === '005930' && s.asks.length === 10 && s.bids.length === 10));
  assert.ok(db.t.trade_audit.some(a => a.event === 'paper_order' && a.ok && a.mode === 'VIRTUAL'));
  const s = await c.call('GET', '/trade/paper/state');
  assert.equal(s.body.positions[0].qty, 250); assert.equal(s.body.fills.length, 2);
  assert.equal(s.body.dayBuyKrw, Math.round(10010 * 100 + 10020 * 150));
  await c.close();
});

test('입력 검증: 종목·호가단위·상하한·수량', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const bad = async (b) => (await c.order({ code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 1, ...b })).status;
  assert.equal(await bad({ code: '12' }), 400);
  assert.equal(await bad({ side: 'short' }), 400);
  assert.equal(await bad({ qty: 0 }), 400);
  assert.equal(await bad({ qty: 1.5 }), 400);
  assert.equal(await bad({ price: 10005 }), 400);     // 호가단위(10원) 위반
  assert.equal(await bad({ price: 13010 }), 400);     // 상한가 초과
  assert.equal(await bad({ price: 6990 }), 400);      // 하한가 미만
  assert.equal(db.t.paper_orders.size, 0);
  await c.close();
});

test('한도: 1회 주문 한도 초과 거부', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: { VIRTUAL_MAX_ORDER_KRW: '1000000' } }); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 101 });
  assert.equal(r.status, 403); assert.match(r.body.error, /한도/);
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 100 })).status, 200);
  await c.close();
});

test('긴급 정지: 매수 거부 · 매도는 허용', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  await c.call('POST', '/trade/kill');
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 403);
  assert.equal((await c.order({ code: '005930', side: 'sell', type: 'market', qty: 10 })).status, 200);
  await c.close();
});

test('TRADING_ENABLED=0 이면 전부 거부', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: { TRADING_ENABLED: '0' } }); await c.login();
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 403);
  await c.close();
});

test('매도: 보유 수량·미체결 매도 예약분을 넘으면 거부, 실현손익 기록', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  assert.equal((await c.order({ code: '005930', side: 'sell', type: 'market', qty: 1 })).status, 400);   // 보유 없음
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 100 });                               // 10010 x100
  const lim = await c.order({ code: '005930', side: 'sell', type: 'limit', price: 10200, qty: 60 });
  assert.equal(lim.body.order.status, 'open');
  assert.equal((await c.order({ code: '005930', side: 'sell', type: 'limit', price: 10300, qty: 50 })).status, 400);   // 100-60=40 만 가능
  const s = await c.order({ code: '005930', side: 'sell', type: 'market', qty: 40 });                     // 매수호가 10000 x40
  assert.equal(s.status, 200);
  const sold = [...db.t.paper_fills.values()].filter(f => f.side === 'sell');
  assert.equal(sold.length, 1); assert.equal(sold[0].realized, (10000 - 10010) * 40);
  await c.close();
});

test('대기 주문: 거래량이 앞 잔량을 넘어야 체결되고 평균단가·보유 반영', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 100 });   // 9990 에 이미 400주 대기
  assert.equal(r.body.order.status, 'open'); assert.equal(r.body.order.queueAhead, 400);
  c.st.clock += 5000; c.st.price = 9990; c.st.vol += 300;                 // 300주 거래 → 앞 잔량 100 남음
  await c.t.paper.tick();
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'open');
  c.st.clock += 5000; c.st.vol += 250;                                      // 250 → 앞 100 소진 후 100 체결(전량)
  await c.t.paper.tick();
  const o = db.t.paper_orders.get(r.body.order.id);
  assert.equal(o.status, 'filled'); assert.equal(o.filled_qty, 100); assert.equal(+o.avg_price, 9990);
  assert.equal(db.t.paper_positions.get('005930').qty, 100);
  await c.close();
});

test('대기 주문 취소', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9900, qty: 10 });
  const x = await c.call('POST', '/trade/paper/cancel', { body: { id: r.body.order.id } });
  assert.equal(x.status, 200); assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'cancelled');
  assert.equal((await c.call('POST', '/trade/paper/cancel', { body: { id: r.body.order.id } })).status, 409);
  assert.equal((await c.call('POST', '/trade/paper/cancel', { body: { id: 'nope' } })).status, 404);
  await c.close();
});

test('장 밖·휴장일·오래된 시세·VI·거래정지는 주문 거부', async () => {
  let db = fakeDb(), c = await boot(db, { clock: Date.parse('2027-01-13T08:30:00+09:00') }); await c.login();
  const ord = { code: '005930', side: 'buy', type: 'market', qty: 1 };
  assert.equal((await c.order(ord)).status, 409);
  await c.close();
  db = fakeDb(); c = await boot(db, { clock: Date.parse('2027-01-16T10:00:00+09:00') }); await c.login();   // 토요일
  assert.equal((await c.order(ord)).status, 409); await c.close();
  db = fakeDb(); c = await boot(db); await c.login();
  c.st.closedDay = true; assert.match((await c.order(ord)).body.error, /휴장/);
  await c.close(); db = fakeDb(); c = await boot(db); await c.login();   // 휴장일 조회 결과는 하루 동안 캐시되므로 새로 시작
  c.st.hourOverride = '093000'; assert.match((await c.order(ord)).body.error, /갱신/); c.st.hourOverride = null; c.st.clock += 2000;   // 시세 캐시(1.5초) 지나게
  c.st.vi = true; assert.match((await c.order(ord)).body.error, /VI/); c.st.vi = false; c.st.clock += 2000;
  c.st.warnings = ['거래정지'];
  assert.match((await c.order(ord)).body.error, /거래정지/);
  assert.equal(db.t.paper_orders.size, 0);
  await c.close();
});

test('서버 재시작: 보유·미체결 복구, 재시작 사이 거래량은 체결로 인정하지 않음', async () => {
  const db = fakeDb(); let c = await boot(db); await c.login();
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 50 });
  await c.close();
  const c2 = await boot(db, { clock: T0 + 60000 }); await c2.login();
  const s = await c2.call('GET', '/trade/paper/state');
  assert.equal(s.body.positions[0].qty, 10); assert.ok(s.body.orders.some(o => o.id === r.body.order.id && o.status === 'open'));
  c2.st.price = 9980; c2.st.vol += 100000; c2.st.low = 9000; c2.st.clock += 5000;   // 재시작 사이 크게 거래됨
  await c2.t.paper.tick();
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'open');            // 첫 시세는 기준만 잡음
  c2.st.vol += 2000; c2.st.clock += 5000; await c2.t.paper.tick();                 // 이후 거래량은 인정(가격이 내 가격 아래)
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'filled');
  await c2.close();
});

test('호가 스냅: 09:00·12:00·15:10 은 보유·미체결 종목만, 슬롯당 한 번, 14일 지난 스냅 삭제', async () => {
  const db = fakeDb(), c = await boot(db, { clock: Date.parse('2027-01-13T09:00:10+09:00') }); await c.login();
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  const base = db.t.paper_book_snaps.length;                                       // 체결 시점 스냅 1건 포함
  await c.t.paper.tick(); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.filter(s => s.kind === 'open').length, 1);
  assert.ok(db.t.deleted.some(d => d.startsWith('paper_book_snaps?ts=lt.')));
  c.st.clock = Date.parse('2027-01-13T12:00:20+09:00'); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.filter(s => s.kind === 'noon').length, 1);
  c.st.clock = Date.parse('2027-01-13T15:10:05+09:00'); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.filter(s => s.kind === 'close').length, 1);
  c.st.clock = Date.parse('2027-01-13T11:00:00+09:00'); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.length, base + 3);                            // 다른 시각엔 안 쌓임
  await c.close();
});

test('테이블이 없으면 503(설정 안내), 주문 저장 실패 시 주문 안 만듦', async () => {
  let db = fakeDb(); db.setFail({ get: '42P01 relation does not exist' });
  let c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 503); assert.match(r.body.error, /missing/);
  await c.close();
  db = fakeDb(); c = await boot(db); await c.login();
  db.setFail({ write: 'paper_orders' });
  const r2 = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r2.status, 503); assert.equal((await c.call('GET', '/trade/paper/state')).body.orders.length, 0);
  await c.close();
});

test('체결 기록 저장이 실패하면 다음 주기에 다시 저장', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  db.setFail({ write: 'paper_fills' });
  const r = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  assert.equal(r.status, 200); assert.equal(db.t.paper_fills.size, 0);
  db.setFail(null); c.st.clock += 5000; await c.t.paper.tick();
  assert.equal(db.t.paper_fills.size, 1);
  await c.close();
});
