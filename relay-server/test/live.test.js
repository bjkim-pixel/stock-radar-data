'use strict';
/* 6단계 실전 엔진 — 모의 KIS 거래소로 시험(실제 KIS 는 부르지 않음) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const PLAN = { stopPct: 2, steps: [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 3 }] };   // 매수 10010 → 손절 9800
const posts = (kx, tr) => kx.posts.filter(p => p.tr === tr);
const liveOrders = db => [...db.t.live_orders.values()];
function move(c, price, { vol = 1000, low } = {}) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += vol;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = low != null ? low : Math.min(st.low, price); st.high = Math.max(st.high, price);
}
async function setup(env = REAL) {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: env, kx }); await c.login();
  const L = (p, b) => c.call('POST', '/trade/live/' + p, { body: b });
  return { db, kx, c, L };
}
async function holding(x, qty = 5) {
  const r = await x.L('order', { code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty, plan: PLAN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  move(x.c, 10000); await x.c.t.live.tick();     // 체결 대조 + 잔고
  move(x.c, 10000); await x.c.t.live.tick();     // 익절 주문 접수
  return r;
}

test('실전 스위치가 꺼져 있으면 KIS 를 부르지 않고 거부', async () => {
  const x = await setup({ KIS_ACCOUNT_NO: '12345678-01' });
  const r = await x.L('order', { code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'real trading disabled');
  assert.equal(x.kx.posts.length, 0);
  await x.c.close();
});

test('계좌 환경변수가 없으면 503(주문 안 냄)', async () => {
  const x = await setup({ REAL_TRADING_ENABLED: '1' });
  const r = await x.L('order', { code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 503); assert.equal(x.kx.posts.length, 0);
  assert.equal((await x.c.call('GET', '/trade/live/state')).body.account, false);
  await x.c.close();
});

test('시장가 매수: KIS 요청 규격 · DB 먼저 기록 · 가상 체결가 함께 저장 · 체결 대조 · 익절 주문은 미리 걸지 않음', async () => {
  const x = await setup();
  await holding(x);
  const buy = posts(x.kx, 'TTTC0012U')[0].body;
  assert.deepEqual(buy, { CANO: '12345678', ACNT_PRDT_CD: '01', PDNO: '005930', ORD_DVSN: '01', ORD_QTY: '5', ORD_UNPR: '0', EXCG_ID_DVSN_CD: 'KRX', SLL_TYPE: '', CNDT_PRIC: '' });
  const o = liveOrders(x.db).find(r => r.reason === 'manual');
  assert.equal(o.status, 'filled'); assert.equal(+o.filled_qty, 5); assert.ok(o.odno); assert.equal(+o.sim_avg, 10010);
  assert.equal(x.db.t.live_fills.size, 1);
  assert.equal(posts(x.kx, 'TTTC0011U').length, 0);                              // 트레일링 익절 — 도달 전엔 매도 주문 없음
  assert.ok(x.db.t.live_plans.get('005930').plan.steps.length === 2);
  const s = await x.c.call('GET', '/trade/live/state');
  assert.equal(s.body.positions[0].qty, 5); assert.equal(s.body.positions[0].stop, 9800);
  assert.ok(!JSON.stringify(s.body).includes('12345678'));                      // 계좌번호는 응답에 없음
  assert.ok(!JSON.stringify(x.db.t.trade_audit).includes('12345678'));         // 감사 기록에도 없음
  await x.c.close();
});

test('실전 한도: 1회 50만원 초과 거부', async () => {
  const x = await setup();
  const r = await x.L('order', { code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 51 });
  assert.equal(r.status, 403); assert.equal(x.kx.posts.length, 0);
  await x.c.close();
});

test('주문 기록을 DB 에 못 쓰면 KIS 주문을 내지 않음', async () => {
  const x = await setup();
  x.db.setFail({ write: 'live_orders' });
  const r = await x.L('order', { code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 503); assert.equal(x.kx.posts.length, 0);
  await x.c.close();
});

test('KIS 가 거부하면 거부 사유를 그대로 보여주고 기록', async () => {
  const x = await setup();
  x.kx.next = 'REJECT';
  const r = await x.L('order', { code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 409); assert.match(r.body.error, /주문가능금액/);
  assert.equal(liveOrders(x.db)[0].status, 'rejected');
  await x.c.close();
});

test('응답을 못 받은 주문: 실제로 접수됐으면 체결조회로 찾아 연결, 같은 종목 새 주문은 막음', async () => {
  const x = await setup();
  x.kx.next = 'UNKNOWN'; x.kx.lostAccepted = true;
  const r = await x.L('order', { code: '005930', side: 'buy', type: 'limit', price: 9900, qty: 3 });
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'unknown');
  assert.equal((await x.L('order', { code: '005930', side: 'buy', type: 'limit', price: 9900, qty: 3 })).status, 409);
  assert.equal(posts(x.kx, 'TTTC0012U').length, 1);                             // 재시도로 두 번 주문하지 않음
  move(x.c, 10000); await x.c.t.live.tick();
  const o = liveOrders(x.db)[0];
  assert.equal(o.status, 'open'); assert.ok(o.odno);
  await x.c.close();
});

test('응답을 못 받은 주문이 60초 동안 체결조회에 없으면 접수 안 됨 처리 + 알림', async () => {
  const x = await setup();
  x.kx.next = 'UNKNOWN'; x.kx.lostAccepted = false;
  await x.L('order', { code: '005930', side: 'buy', type: 'limit', price: 9900, qty: 3 });
  move(x.c, 10000); await x.c.t.live.tick();
  assert.equal(liveOrders(x.db)[0].status, 'unknown');
  x.c.st.clock += 60000; move(x.c, 10000); await x.c.t.live.tick();
  const o = liveOrders(x.db)[0];
  assert.equal(o.status, 'rejected'); assert.equal(o.note, 'not_found');
  assert.ok(x.c.st.alerts.some(a => /접수되지 않은 것으로/.test(a)));
  await x.c.close();
});

test('트레일링 익절: 도달 → 감시 → 고점 대비 2% 하락 시 시장가 매도 · 단계 진행 · 실현손익', async () => {
  const x = await setup();
  await holding(x);
  move(x.c, 10350); await x.c.t.live.tick();                                     // 1·2단계 감시 시작
  assert.equal(posts(x.kx, 'TTTC0011U').length, 0);
  assert.ok(x.c.st.alerts.some(a => /익절 1단계 감시 시작/.test(a)));
  move(x.c, 10140); await x.c.t.live.tick();                                     // 10350×0.98=10143 아래 → 발동
  const sells = posts(x.kx, 'TTTC0011U').map(p => p.body);
  assert.deepEqual(sells.map(b => [b.ORD_DVSN, b.ORD_QTY]), [['01', '2'], ['01', '3']]);
  move(x.c, 10140); await x.c.t.live.tick();                                     // 체결 대조
  assert.deepEqual(x.db.t.live_plans.get('005930') ? x.db.t.live_plans.get('005930').plan.steps.map(s => s.sold) : 'gone', 'gone');   // 전량 매도 → 계획 종료
  const f = [...x.db.t.live_fills.values()].find(f => f.reason === 'tp1');
  assert.equal(f.qty, 2); assert.equal(Math.round(f.realized), (10140 - 10010) * 2);
  assert.ok(x.c.st.alerts.some(a => /익절 1단계\(트레일링\)/.test(a)));
  await x.c.close();
});

test('손절: 걸려 있는 매도 주문 취소(전량 취소 규격) → 잔고 다시 읽고 시장가 매도', async () => {
  const x = await setup();
  await holding(x);
  assert.equal((await x.L('order', { code: '005930', side: 'sell', type: 'limit', price: 11000, qty: 2 })).status, 200);
  move(x.c, 9790); await x.c.t.live.tick();
  const cx = posts(x.kx, 'TTTC0013U').map(p => p.body);
  assert.equal(cx.length, 1);
  assert.ok(cx.every(b => b.RVSE_CNCL_DVSN_CD === '02' && b.QTY_ALL_ORD_YN === 'Y' && b.ORD_QTY === '0' && b.ORGN_ODNO && b.KRX_FWDG_ORD_ORGNO === '91252'));
  const sell = posts(x.kx, 'TTTC0011U').map(p => p.body).find(b => b.ORD_DVSN === '01');
  assert.equal(sell.ORD_QTY, '5');
  const so = liveOrders(x.db).find(o => o.reason === 'stop');
  assert.equal(+so.ref_price, 9800); assert.ok(+so.sim_avg > 0);
  move(x.c, 9790); await x.c.t.live.tick();
  assert.equal(x.kx.hold.get('005930').qty, 0);
  assert.equal(posts(x.kx, 'TTTC0011U').filter(p => p.body.ORD_DVSN === '01').length, 1);   // 손절 주문은 한 번만
  move(x.c, 9790); await x.c.t.live.tick();
  assert.equal(x.db.t.live_plans.has('005930'), false);                                      // 보유가 없어지면 계획 종료
  await x.c.close();
});

test('시나리오: 손절 중 매도 주문 취소 실패 → 그 수량은 빼고 매도(초과 매도 없음) + 알림', async () => {
  const x = await setup();
  await holding(x);
  assert.equal((await x.L('order', { code: '005930', side: 'sell', type: 'limit', price: 11000, qty: 5 })).status, 200);
  x.kx.cancelFail = true;
  move(x.c, 9790); await x.c.t.live.tick();
  assert.ok(x.c.st.alerts.some(a => /취소 실패/.test(a)));
  assert.equal(posts(x.kx, 'TTTC0011U').filter(p => p.body.ORD_DVSN === '01').length, 0);   // 5주 모두 매도 주문에 묶여 매도 가능 0
  assert.ok(x.c.st.alerts.some(a => /추가 매도하지 않았습니다/.test(a)));
  x.kx.cancelFail = false;
  move(x.c, 9790); await x.c.t.live.tick();                                                  // 다음 주기: 취소 성공 → 매도
  move(x.c, 9790); await x.c.t.live.tick();
  assert.equal(x.kx.hold.get('005930').qty, 0);
  await x.c.close();
});

test('계획 없는 보유(HTS 매수 등)는 자동 매도하지 않음, 계획을 넣으면 감시 시작', async () => {
  const x = await setup();
  x.kx.hold.set('005930', { qty: 4, avg: 10000 });
  move(x.c, 9000); await x.c.t.live.tick(); move(x.c, 9000); await x.c.t.live.tick();
  assert.equal(x.kx.posts.length, 0);
  const r = await x.L('plan', { code: '005930', stop: 8500, steps: [{ n: 1, p: 10500, q: 4 }] });
  assert.equal(r.status, 200);
  move(x.c, 9000); await x.c.t.live.tick();
  assert.equal(posts(x.kx, 'TTTC0011U').length, 0);                                   // 익절은 감시만
  move(x.c, 8400); await x.c.t.live.tick();
  assert.deepEqual(posts(x.kx, 'TTTC0011U').map(p => [p.body.ORD_DVSN, p.body.ORD_QTY]), [['01', '4']]);   // 손절가 8500 아래 → 시장가
  await x.c.close();
});

test('계획 수정: 새 가격으로 트레일링 감시(미리 걸린 주문 없음)', async () => {
  const x = await setup();
  await holding(x);
  const r = await x.L('plan', { code: '005930', stop: 9500, steps: [{ n: 1, p: 10600, q: 5 }] });
  assert.equal(r.status, 200);
  move(x.c, 10300); await x.c.t.live.tick();
  assert.equal(posts(x.kx, 'TTTC0011U').length, 0);                                // 예전 1단계(10200)가 아니라 새 가격 기준
  move(x.c, 10650); await x.c.t.live.tick(); move(x.c, 10430); await x.c.t.live.tick();
  assert.deepEqual(posts(x.kx, 'TTTC0011U').map(p => [p.body.ORD_DVSN, p.body.ORD_QTY]), [['01', '5']]);
  await x.c.close();
});

test('보유 계획: 익절만 저장(손절 없음) · 모두 지우면 계획 해제', async () => {
  const x = await setup();
  x.kx.hold.set('005930', { qty: 6, avg: 10000 });
  let r = await x.L('plan', { code: '005930', steps: [{ n: 1, p: 10500, q: 1 }, { n: 2, p: 10800, q: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.position.stop, null);
  move(x.c, 9000); await x.c.t.live.tick();
  assert.equal(posts(x.kx, 'TTTC0011U').length, 0);                                        // 손절 없음 → 하락해도 안 팜
  r = await x.L('plan', { code: '005930', steps: [] });
  assert.equal(r.status, 200); assert.equal(r.body.position.plan, null);
  await x.c.close();
});

test('긴급 정지: 실전 매수 거부, 손절은 동작', async () => {
  const x = await setup();
  await holding(x);
  await x.c.call('POST', '/trade/kill');
  assert.equal((await x.L('order', { code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 403);
  move(x.c, 9790); await x.c.t.live.tick(); move(x.c, 9790); await x.c.t.live.tick();
  assert.equal(x.kx.hold.get('005930').qty, 0);
  await x.c.close();
});

test('수동 매도: 보유에서 바로 매도(미리 걸린 익절 주문 없음)', async () => {
  const x = await setup();
  await holding(x);
  const r = await x.L('order', { code: '005930', side: 'sell', type: 'market', qty: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(posts(x.kx, 'TTTC0013U').length, 0);
  assert.equal(x.kx.hold.get('005930').qty, 3);
  await x.c.close();
});

test('계좌 연결 점검: 필드 이름과 건수만(값·계좌번호 없음)', async () => {
  const x = await setup();
  x.kx.hold.set('005930', { qty: 4, avg: 10000 });
  const r = await x.c.call('GET', '/trade/live/probe');
  assert.equal(r.status, 200); assert.equal(r.body.balance.positions, 1);
  assert.ok(r.body.balance.rowKeys.includes('hldg_qty'));
  assert.ok(!JSON.stringify(r.body).includes('12345678') && !JSON.stringify(r.body).includes('10000'));
  await x.c.close();
});

test('리포트: 가상 대비 차이(시장가·손절)', async () => {
  const x = await setup();
  await holding(x);
  move(x.c, 9790); await x.c.t.live.tick(); move(x.c, 9790); await x.c.t.live.tick();
  const r = await x.c.call('GET', '/trade/live/report');
  assert.equal(r.status, 200);
  assert.ok(r.body.shadow.orders >= 2, JSON.stringify(r.body.shadow));
  assert.equal(r.body.stats.trades, 1);
  await x.c.close();
});

test('KRX 정규장 마감 직후 종가 단일가 체결을 받아 두고 15:40 이후 남은 KRX 주문 소멸', async () => {
  const x = await setup();
  await holding(x);
  assert.equal((await x.L('order', { code: '005930', side: 'sell', type: 'limit', price: 10300, qty: 3 })).status, 200);
  const b2 = await x.L('order', { code: '005930', side: 'buy', type: 'limit', price: 9000, qty: 1 }); assert.equal(b2.status, 200, JSON.stringify(b2.body));
  const tp2 = [...x.kx.orders.values()].find(o => o.side === 'sell' && o.price === 10300);
  x.c.st.clock = Date.parse('2027-01-13T15:31:00+09:00'); x.kx.fill(tp2.odno, 3, 10300);
  await x.c.t.live.tick();
  assert.equal([...x.db.t.live_orders.values()].find(o => o.odno === tp2.odno).status, 'filled');
  assert.equal([...x.db.t.live_orders.values()].find(o => +o.price === 9000).status, 'open');
  x.c.st.clock = Date.parse('2027-01-13T15:41:00+09:00'); await x.c.t.live.tick();
  const tp1 = [...x.db.t.live_orders.values()].find(o => +o.price === 9000);
  assert.equal(tp1.status, 'cancelled'); assert.equal(tp1.note, 'expired');   // KRX 정규장 주문은 15:30 소멸 → 15:40 정리
  x.c.st.clock = Date.parse('2027-01-13T20:06:00+09:00'); await x.c.t.live.tick();
  assert.ok(x.c.st.alerts.some(a => /마감\(20:00\)/.test(a)));
  await x.c.close();
});
