'use strict';
/* 8단계 NXT·시간외(08:00~20:00) — 가상매매 시나리오 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot } = require('./paper-harness');

const at = hm => Date.parse(`2027-01-13T${hm}:00+09:00`);
const STEPS = [{ n: 1, p: 10200, q: 5 }, { n: 2, p: 10300, q: 5 }];
const PLAN = { stopPct: 2, steps: STEPS };
const open = db => [...db.t.paper_orders.values()].filter(o => ['open', 'partial'].includes(o.status));
function move(c, price, { vol = 1000, step = 5000 } = {}) {
  const st = c.st; st.clock += step; st.price = price; st.vol += vol;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
}

test('NXT 종목 프리마켓: 지정가 주문은 접수(NXT), 시장가는 거부, 시세는 NXT(NX)로 조회', async () => {
  const db = fakeDb(), c = await boot(db, { clock: at('08:10') }); await c.login();
  const q = await c.call('GET', '/trade/quote?code=000660');
  assert.equal(q.body.session.name, 'pre'); assert.equal(q.body.mkt, 'NX');
  const m = await c.order({ code: '000660', side: 'buy', type: 'market', qty: 1 });
  assert.equal(m.status, 409); assert.match(m.body.error, /시장가/);
  const l = await c.order({ code: '000660', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal([...db.t.paper_orders.values()][0].venue, 'NXT');
  await c.close();
});

test('KRX 전용 종목은 프리마켓·빈 시간에 거부, 정규장 SOR/KRX 거래소 기록', async () => {
  const db = fakeDb(), c = await boot(db, { clock: at('08:10') }); await c.login();
  let r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(r.status, 409); assert.match(r.body.error, /09:00/);
  c.st.clock = at('08:55'); await c.login(); r = await c.order({ code: '000660', side: 'buy', type: 'limit', price: 9990, qty: 1 });
  assert.equal(r.status, 409); assert.match(r.body.error, /08:50~09:00/);
  c.st.clock = at('10:00'); await c.login();
  r = await c.order({ code: '000660', side: 'buy', type: 'limit', price: 9990, qty: 1 }); assert.equal(r.status, 200);
  r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 1 }); assert.equal(r.status, 200);
  const v = Object.fromEntries([...db.t.paper_orders.values()].map(o => [o.code, o.venue]));
  assert.deepEqual(v, { '000660': 'SOR', '005930': 'KRX' });
  assert.equal(c.st.mkts.includes('UN'), true);
  await c.close();
});

test('익절: NXT 종목은 NXT 로 걸려 15:30 이후에도 유지, KRX 종목은 15:30 소멸 → 16:00 KRX 애프터마켓에 재접수', async () => {
  const db = fakeDb(), c = await boot(db, { clock: at('10:00') }); await c.login();
  for (const code of ['000660', '005930']) { const r = await c.order({ code, side: 'buy', type: 'market', qty: 10, plan: PLAN }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  move(c, 10000); await c.t.paper.tick();
  const venues = code => open(db).filter(o => o.code === code && /^tp/.test(o.reason)).map(o => o.venue);
  assert.deepEqual(venues('000660'), ['NXT', 'NXT']);
  assert.deepEqual(venues('005930'), ['KRX', 'KRX']);
  c.st.clock = at('15:31'); await c.t.paper.tick();
  assert.deepEqual(venues('000660'), ['NXT', 'NXT']);
  assert.deepEqual(venues('005930'), []);
  c.st.clock = at('15:45'); move(c, 10000, { step: 0 }); await c.t.paper.tick();
  assert.deepEqual(venues('005930'), []);                // 15:40~16:00 은 KRX 종목 주문 불가
  c.st.clock = at('16:01'); move(c, 10000, { step: 0 }); await c.t.paper.tick();
  assert.deepEqual(venues('005930'), ['KRX', 'KRX']);
  assert.ok(open(db).filter(o => o.code === '005930').every(o => o.note === 'reopen'));
  c.st.clock = at('20:00'); await c.t.paper.tick();
  assert.equal(open(db).length, 0);                       // 20:00 에 모두 소멸
  await c.close();
});

test('애프터마켓 손절: 시장가 대신 매수 1호가 5호가 아래 지정가, 안 팔리면 20초 뒤 취소 후 다시 냄', async () => {
  const db = fakeDb(), c = await boot(db, { clock: at('16:10') }); await c.login();
  const b = await c.order({ code: '000660', side: 'buy', type: 'limit', price: 10010, qty: 10, plan: PLAN });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(db.t.paper_positions.get('000660').qty, 10);
  // 손절가 = 10010 × 0.98 → 9800 (호가 단위 내림). 얇은 매수호가(호가마다 1주)
  const thin = top => Array.from({ length: 10 }, (_, i) => [top - 10 * i, 1]);
  move(c, 9750); c.st.bids = thin(9700); c.st.asks = [[9760, 100]];
  await c.t.paper.tick();
  const stops = () => [...db.t.paper_orders.values()].filter(o => o.reason === 'stop');
  assert.equal(stops().length, 1);
  assert.equal(stops()[0].type, 'limit'); assert.equal(stops()[0].price, 9650);   // 9700 에서 10원 × 5호가 아래
  assert.equal(stops()[0].filled_qty, 6);                 // 9700~9650 의 6주만 즉시 체결, 4주 대기
  assert.equal(open(db).filter(o => /^tp/.test(o.reason)).length, 0);
  move(c, 9800, { vol: 0 }); c.st.bids = thin(9600).map(([p]) => [p, 0]); await c.t.paper.tick();   // 20초 전: 그대로 대기(가격이 돌아와도 손절은 계속)
  assert.equal(stops().length, 1);
  move(c, 9800, { vol: 0, step: 20000 }); c.st.bids = thin(9600); await c.t.paper.tick();
  const s = stops().sort((a, b) => a.created_at.localeCompare(b.created_at));
  assert.equal(s.length, 2); assert.equal(s[0].status, 'cancelled'); assert.equal(s[1].note, 'retry'); assert.equal(s[1].price, 9550);
  assert.equal(db.t.paper_positions.has('000660'), false);   // 남은 4주를 9600~9570 에 모두 매도
  assert.ok(c.st.alerts.some(a => /손절 지정가 대기/.test(a)));
  await c.close();
});

test('시세 출처가 바뀌면(15:45 NX → 16:05 UN) 대기 주문의 거래량 기준을 새로 잡음', async () => {
  const db = fakeDb(), c = await boot(db, { clock: at('15:45') }); await c.login();
  const r = await c.order({ code: '000660', side: 'buy', type: 'limit', price: 9900, qty: 3 });
  assert.equal(r.status, 200);
  move(c, 10000, { step: 0 }); await c.t.paper.tick();
  c.st.clock = at('16:05'); c.st.price = 9900; c.st.vol += 1e6; c.st.low = 9800; await c.t.paper.tick();   // 출처 변경 직후: 큰 거래량 차이를 체결로 인정하지 않음
  assert.equal([...db.t.paper_orders.values()][0].filled_qty, 0);
  c.st.clock += 5000; c.st.vol += 1e6; await c.t.paper.tick();   // 다음 주기부터는 정상 추적
  assert.equal([...db.t.paper_orders.values()][0].filled_qty, 3);
  await c.close();
});
