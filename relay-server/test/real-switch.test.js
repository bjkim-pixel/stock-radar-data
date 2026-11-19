'use strict';
/* 사이트 "실전 주문" 스위치(2026-11-19): 기본 꺼짐 · 켜기=PIN · 끄기=바로 · 신규 매수만 막고 매도·취소는 계속 · 재시작 뒤 유지 · 자동매매 실전 전략은 건너뜀 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, fakeKis, boot } = require('./paper-harness');

const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const sw = (c, body) => c.call('POST', '/trade/live/switch', { body });

test('기본은 꺼짐 — 실전 신규 매수 거부, 매도·취소는 허용, 상태에 realOn:false', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: REAL, kx: fakeKis(), realOn: false }); await c.login();
  const st = (await c.call('GET', '/trade/status')).body;
  assert.equal(st.realEnabled, true); assert.equal(st.realOn, false);
  assert.equal(c.t.guard('buy', 'REAL').error, 'real orders switched off (site switch)');
  assert.equal(c.t.guard('sell', 'REAL').ok, true);
  assert.equal(c.t.guard('cancel', 'REAL').ok, true);
  assert.equal(c.t.guard('buy', 'VIRTUAL').ok, true);   // 가상·드라이런은 영향 없음
  assert.equal(c.t.realOrdersOn(), false);
  await c.close();
});

test('켜기: PIN 없으면 거부 · 틀리면 거부 · 맞으면 켜짐 + 감사 기록 + 알림', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: REAL, kx: fakeKis(), realOn: false }); await c.login();
  assert.equal((await sw(c, { on: true })).status, 403);
  assert.equal((await sw(c, { on: true, pin: '000000' })).status, 403);
  assert.equal(c.t.realOrdersOn(), false);
  const r = await sw(c, { on: true, pin: '123456' });
  assert.equal(r.status, 200); assert.equal(r.body.realOn, true);
  assert.equal((await c.call('GET', '/trade/status')).body.realOn, true);
  assert.equal(c.t.guard('buy', 'REAL').ok, true);
  assert.ok(db.t.trade_audit.some(a => a.event === 'real_on'));
  assert.ok(c.st.alerts.some(a => /실전 주문" 스위치를 켰습니다/.test(a)));
  await c.close();
});

test('끄기: PIN 없이 바로 꺼지고 매수 거부 · 매도는 계속', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: REAL, kx: fakeKis() }); await c.login();   // 하네스가 켠 상태로 시작
  assert.equal(c.t.guard('buy', 'REAL').ok, true);
  const r = await sw(c, { on: false });
  assert.equal(r.status, 200); assert.equal(r.body.realOn, false);
  assert.equal(c.t.guard('buy', 'REAL').error, 'real orders switched off (site switch)');
  assert.equal(c.t.guard('sell', 'REAL').ok, true);
  assert.ok(db.t.trade_audit.some(a => a.event === 'real_off'));
  assert.ok(c.st.alerts.some(a => /껐습니다/.test(a)));
  await c.close();
});

test('환경변수 REAL_TRADING_ENABLED 가 꺼져 있으면 켤 수 없음 · 긴급 정지 중에도 못 켬 · 세션 없으면 401', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: { KIS_ACCOUNT_NO: '12345678-01' }, kx: fakeKis() });
  assert.equal((await sw(c, { on: true, pin: '123456' })).status, 401);   // 세션 없음
  await c.login();
  const r = await sw(c, { on: true, pin: '123456' });
  assert.equal(r.status, 409); assert.match(r.body.error, /REAL_TRADING_ENABLED/);
  assert.equal((await c.call('GET', '/trade/status')).body.realOn, false);
  await c.close();
  const c2 = await boot(fakeDb(), { envExtra: REAL, kx: fakeKis(), realOn: false }); await c2.login();
  await c2.call('POST', '/trade/kill');
  assert.equal((await sw(c2, { on: true, pin: '123456' })).status, 409);
  await c2.close();
});

test('켠 기록을 저장하지 못하면 켜지 않음 · 끄기는 기록 실패해도 꺼짐', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: REAL, kx: fakeKis(), realOn: false }); await c.login();
  db.setFail({ write: 'trade_audit' });
  const r = await sw(c, { on: true, pin: '123456' });
  assert.equal(r.status, 503); assert.equal(c.t.realOrdersOn(), false);
  db.setFail(null);
  assert.equal((await sw(c, { on: true, pin: '123456' })).status, 200);
  db.setFail({ write: 'trade_audit' });
  const off = await sw(c, { on: false });
  assert.equal(off.status, 200); assert.equal(off.body.saved, false); assert.equal(c.t.realOrdersOn(), false);
  assert.ok(c.st.alerts.some(a => /기록 저장 실패/.test(a)));
  await c.close();
});

test('잘못된 요청: on 이 불리언이 아니면 400', async () => {
  const c = await boot(fakeDb(), { envExtra: REAL, kx: fakeKis() }); await c.login();
  assert.equal((await sw(c, { on: 'yes', pin: '123456' })).status, 400);
  await c.close();
});

test('재시작: 켜 둔 상태는 기록에서 복구 · 끈 상태도 복구 · 기록 없으면 꺼짐', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: REAL, kx: fakeKis(), realOn: false }); await c.login();
  await sw(c, { on: true, pin: '123456' });
  await c.close();
  const c2 = await boot(db, { envExtra: REAL, kx: fakeKis(), realOn: false });   // 같은 DB 로 새로 부팅 = 재시작
  assert.equal(c2.t.realOrdersOn(), true);
  await c2.login(); await sw(c2, { on: false });
  await c2.close();
  const c3 = await boot(db, { envExtra: REAL, kx: fakeKis(), realOn: false });
  assert.equal(c3.t.realOrdersOn(), false);
  await c3.close();
  const c4 = await boot(fakeDb(), { envExtra: REAL, kx: fakeKis(), realOn: false });
  assert.equal(c4.t.realOrdersOn(), false);
  await c4.close();
});

test('다른 인스턴스가 남긴 끄기 기록을 다시 읽어 따라감(reloadReal) · 방금 바꾼 상태는 옛 기록으로 되돌리지 않음', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: REAL, kx: fakeKis() });   // 켠 상태
  assert.equal(c.t.realOrdersOn(), true);
  c.st.clock += 5000;
  db.t.trade_audit.push({ event: 'real_off', ts: new Date(c.st.clock).toISOString(), ok: true });
  await c.t.reloadReal();
  assert.equal(c.t.realOrdersOn(), false);
  await c.t.setRealOn(true, null, 'test');   // 이 서버에서 방금 켬(기록 시각은 harness 의 ts 가 없어 옛 것으로 보일 수 있음)
  assert.equal(c.t.realOrdersOn(), true);
  await c.t.reloadReal();
  assert.equal(c.t.realOrdersOn(), true);
  await c.close();
});

test('실전 주문 엔드포인트: 꺼짐이면 /trade/live/order 매수는 403, 매도는 통과 가능, 켜면 매수 접수', async () => {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: REAL, kx, realOn: false }); await c.login();
  const buy = { code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 1 };
  const r1 = await c.call('POST', '/trade/live/order', { body: buy });
  assert.equal(r1.status, 403); assert.match(r1.body.error, /switched off/);
  assert.equal(kx.posts.filter(p => /order-cash/.test(p.path || '')).length, 0);   // KIS 로 나가지 않음
  await sw(c, { on: true, pin: '123456' });
  const r2 = await c.call('POST', '/trade/live/order', { body: buy });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  await c.close();
});
