'use strict';
/* 8단계 NXT·시간외 — 실전 엔진(모의 KIS 거래소, 실제 KIS 는 부르지 않음) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const at = hm => Date.parse(`2027-01-13T${hm}:00+09:00`);
const PLAN = { stopPct: 2, steps: [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 3 }] };
const posts = (kx, tr) => kx.posts.filter(p => p.tr === tr);
const rows = db => [...db.t.live_orders.values()];
function move(c, price, { vol = 1000, step = 5000 } = {}) {
  const st = c.st; st.clock += step; st.price = price; st.vol += vol;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
}
async function setup(clock, env = REAL) {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: env, kx, clock }); await c.login();
  const L = (p, b) => c.call('POST', '/trade/live/' + p, { body: b });
  return { db, kx, c, L };
}
async function hold(x, code, qty = 5) {
  const r = await x.L('order', { code, name: code, side: 'buy', type: 'market', qty, plan: PLAN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  move(x.c, 10000); await x.c.t.live.tick();
  move(x.c, 10000); await x.c.t.live.tick();
}

test('프리마켓(NXT 종목): 지정가는 NXT 로, 시장가는 KIS 를 부르지 않고 거부', async () => {
  const x = await setup(at('08:10'));
  const m = await x.L('order', { code: '000660', side: 'buy', type: 'market', qty: 1 });
  assert.equal(m.status, 409); assert.match(m.body.error, /시장가/); assert.equal(x.kx.posts.length, 0);
  const k = await x.L('order', { code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(k.status, 409); assert.equal(x.kx.posts.length, 0);                // KRX 전용 종목은 09:00 부터
  const l = await x.L('order', { code: '000660', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(posts(x.kx, 'TTTC0012U')[0].body.EXCG_ID_DVSN_CD, 'NXT');
  assert.equal(rows(x.db)[0].excg, 'NXT');
  await x.c.close();
});

test('정규장: NXT 종목 매수는 SOR, 익절은 NXT · KRX 종목은 KRX · 취소는 주문과 같은 거래소', async () => {
  const x = await setup(at('10:00'));
  await hold(x, '000660'); await hold(x, '005930');
  const buys = posts(x.kx, 'TTTC0012U').map(p => [p.body.PDNO, p.body.EXCG_ID_DVSN_CD]);
  assert.deepEqual(buys, [['000660', 'SOR'], ['005930', 'KRX']]);
  const tp = code => posts(x.kx, 'TTTC0011U').filter(p => p.body.PDNO === code).map(p => p.body.EXCG_ID_DVSN_CD);
  assert.deepEqual(tp('000660'), ['NXT', 'NXT']);
  assert.deepEqual(tp('005930'), ['KRX', 'KRX']);
  const r = await x.L('order', { code: '000660', side: 'buy', type: 'limit', price: 9000, qty: 1 });
  assert.equal(r.status, 200);
  const c = await x.L('cancel', { id: r.body.order.id });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(posts(x.kx, 'TTTC0013U').at(-1).body.EXCG_ID_DVSN_CD, 'SOR');
  await x.c.close();
});

test('TRADE_NO_SOR=1 이면 정규장 NXT 종목도 KRX 로 직접', async () => {
  const x = await setup(at('10:00'), { ...REAL, TRADE_NO_SOR: '1' });
  const r = await x.L('order', { code: '000660', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(r.status, 200);
  assert.equal(posts(x.kx, 'TTTC0012U')[0].body.EXCG_ID_DVSN_CD, 'KRX');
  await x.c.close();
});

test('19:58 남은 미체결 모두 취소 요청 · 새 주문 거부 · 20:05 이후 소멸 정리와 마감 알림', async () => {
  const x = await setup(at('19:50'));
  const b = await x.L('order', { code: '000660', name: 'SK하이닉스', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN });   // 애프터마켓은 지정가만
  assert.equal(b.status, 200, JSON.stringify(b.body));
  x.kx.fill([...x.kx.orders.keys()][0], 5, 10010);
  move(x.c, 10000); await x.c.t.live.tick();
  move(x.c, 10000); await x.c.t.live.tick();
  const open = () => rows(x.db).filter(o => ['open', 'partial'].includes(o.status));
  assert.equal(open().length, 2);                                                  // 애프터마켓 익절 2단계(NXT)
  x.c.st.clock = at('19:58'); await x.c.login();
  const n = await x.L('order', { code: '000660', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(n.status, 409); assert.match(n.body.error, /19:58/);
  await x.c.t.live.tick();
  assert.equal(posts(x.kx, 'TTTC0013U').length, 2);
  assert.ok(posts(x.kx, 'TTTC0013U').every(p => p.body.EXCG_ID_DVSN_CD === 'NXT'));
  x.c.st.clock += 5000; await x.c.t.live.tick();                                   // 취소 확인
  assert.equal(open().length, 0);
  assert.equal(posts(x.kx, 'TTTC0011U').length, 2);                                // 다시 걸지 않음
  x.c.st.clock = at('20:06'); await x.c.t.live.tick();
  assert.ok(x.c.st.alerts.some(a => /마감\(20:00\)/.test(a)));
  await x.c.close();
});

test('애프터마켓 손절(NXT 종목): 지정가(매수1호가 5호가 아래) · 안 팔리면 취소 확인 후 다시 냄', async () => {
  const x = await setup(at('16:10'));
  const b = await x.L('order', { code: '000660', name: 'SK하이닉스', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  x.kx.fill([...x.kx.orders.keys()][0], 5, 10010);                                 // 지정가 매수 체결
  move(x.c, 10000); await x.c.t.live.tick();                                      // 체결 대조 + 잔고
  move(x.c, 10000); await x.c.t.live.tick();                                      // 익절(NXT)
  assert.equal(posts(x.kx, 'TTTC0011U').length, 2);
  move(x.c, 9750); await x.c.t.live.tick();                                       // 손절가 9800 아래
  const sells = () => posts(x.kx, 'TTTC0011U');
  const st1 = sells().at(-1).body;
  assert.deepEqual([st1.ORD_DVSN, st1.ORD_UNPR, st1.ORD_QTY, st1.EXCG_ID_DVSN_CD], ['00', '9700', '5', 'SOR']);   // 9750 - 10원×5
  assert.ok(x.c.st.alerts.some(a => /손절 주문: .*지정가/.test(a)));
  const stopOdno = [...x.kx.orders.values()].find(o => o.side === 'sell' && o.price === 9700).odno;
  const stopCancels = () => posts(x.kx, 'TTTC0013U').filter(p => p.body.ORGN_ODNO === stopOdno);
  move(x.c, 9900); await x.c.t.live.tick();                                       // 가격이 돌아와도 손절 진행(20초 전이라 대기)
  assert.equal(stopCancels().length, 0);
  move(x.c, 9900, { step: 20000 }); await x.c.t.live.tick();                      // 20초 지남 → 취소 요청
  assert.equal(stopCancels().length, 1); assert.equal(stopCancels()[0].body.EXCG_ID_DVSN_CD, 'SOR');
  move(x.c, 9900); await x.c.t.live.tick();                                       // 취소 확인
  move(x.c, 9900); await x.c.t.live.tick();                                       // 다시 냄
  const last = sells().at(-1).body;
  assert.deepEqual([last.ORD_UNPR, last.ORD_QTY], ['9850', '5']);
  assert.equal(rows(x.db).filter(o => o.reason === 'stop').length, 2);
  await x.c.close();
});

test('KRX 전용 종목 익절: 15:30 거래소 소멸 → 15:40 정리 → 16:00 KRX 애프터마켓에 다시 냄', async () => {
  const x = await setup(at('10:00'));
  await hold(x, '005930');
  assert.equal(posts(x.kx, 'TTTC0011U').length, 2);
  for (const o of x.kx.orders.values()) if (o.side === 'sell' && o.excg === 'KRX') o.cancelled = true;   // 거래소: KRX 정규장 미체결 소멸
  x.c.st.clock = at('15:41'); await x.c.t.live.tick();
  const tps = () => rows(x.db).filter(o => /^tp/.test(o.reason));
  assert.ok(tps().every(o => o.status === 'cancelled'));
  x.c.st.clock = at('15:50'); move(x.c, 10000, { step: 0 }); await x.c.t.live.tick();
  assert.equal(posts(x.kx, 'TTTC0011U').length, 2);                                // 15:40~16:00 KRX 종목은 주문 불가
  x.c.st.clock = at('16:01'); move(x.c, 10000, { step: 0 }); await x.c.t.live.tick();
  const again = posts(x.kx, 'TTTC0011U').slice(2).map(p => [p.body.EXCG_ID_DVSN_CD, p.body.ORD_UNPR, p.body.ORD_QTY]);
  assert.deepEqual(again, [['KRX', '10200', '2'], ['KRX', '10300', '3']]);
  assert.ok(tps().filter(o => o.status === 'open').every(o => o.note === 'reopen'));
  await x.c.close();
});
