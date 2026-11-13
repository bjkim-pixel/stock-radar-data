'use strict';
/* 정정(가격·수량 바꾸기) — 가상: 취소 후 재주문 · 실전: KIS 정정(TTTC0013U, 01) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

test('가상 정정: 매수 지정가 잔량을 새 가격으로 · 원주문 취소 · 계획 유지', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const plan = { stopPct: 3, steps: [{ n: 1, p: 10500, q: 3 }] };
  const r = await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 3, plan });
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'open');
  const m = await c.call('POST', '/trade/paper/modify', { body: { id: r.body.order.id, price: 9950 } });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.order.price, 9950); assert.equal(m.body.order.qty, 3);
  const old = db.t.paper_orders.get(r.body.order.id); assert.equal(old.status, 'cancelled'); assert.equal(old.note, 'modified');
  const nw = db.t.paper_orders.get(m.body.order.id); assert.ok(nw.plan && nw.plan.steps.length === 1);
  assert.ok(db.t.trade_audit.some(a => a.event === 'paper_modify' && a.ok));
  assert.equal((await c.call('POST', '/trade/paper/modify', { body: { id: m.body.order.id, price: 9951 } })).status, 400);   // 호가 단위
  assert.equal((await c.call('POST', '/trade/paper/modify', { body: { id: m.body.order.id, price: 9950, qty: 4 } })).status, 400); // 잔량 초과
  assert.equal((await c.call('POST', '/trade/paper/modify', { body: { id: r.body.order.id, price: 9950 } })).status, 409);         // 끝난 주문
  await c.close();
});

test('실전 정정: KIS 정정 요청 규격 · 새 주문번호로 추적 · 원주문은 체결조회로 종료', async () => {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' }, kx }); await c.login();
  const L = (p, b) => c.call('POST', '/trade/live/' + p, { body: b });
  const r = await L('order', { code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await L('modify', { id: r.body.order.id, price: 9950, qty: 2 });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const p = kx.posts.at(-1);
  assert.equal(p.tr, 'TTTC0013U'); assert.equal(p.body.RVSE_CNCL_DVSN_CD, '01'); assert.equal(p.body.ORD_UNPR, '9950'); assert.equal(p.body.ORD_QTY, '2'); assert.equal(p.body.QTY_ALL_ORD_YN, 'N');
  const L2 = c.t.live._orders;
  assert.equal(L2.get(r.body.order.id).qty, 1);                           // 원주문엔 1주 남음
  const n = L2.get(m.body.order.id); assert.equal(n.qty, 2); assert.equal(n.price, 9950); assert.ok(n.odno);
  const m2 = await L('modify', { id: r.body.order.id, price: 9950 });     // 나머지 전부
  assert.equal(m2.status, 200); assert.equal(kx.posts.at(-1).body.QTY_ALL_ORD_YN, 'Y');
  c.st.clock += 5000; await c.t.live.tick();
  assert.equal(L2.get(r.body.order.id).status, 'cancelled');
  assert.equal(L2.get(m.body.order.id).status, 'open');
  await c.close();
});
