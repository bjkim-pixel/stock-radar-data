'use strict';
/* 실전 투입 전 독립 검토(2026-11-18) 지적 사항 회귀 테스트 — 검토자가 결함을 재현한 시나리오를 그대로 두고 "이제는 안전하게 끝나는지"를 확인한다 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBroker } = require('../broker');
const G = require('../engine-guard');
const KO = require('../kis-order');
const AL = require('../kis-allow');
const RC = require('../recon');
const { fakeDb, boot, fakeKis } = require('./paper-harness');
const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const PLAN = { stopPct: 2, steps: [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 3 }] };
function move(c, price) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += 1000;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
}
async function rig(db, kx, extraDeps) {
  db = db || fakeDb(); kx = kx || fakeKis();
  const c = await boot(db, { envExtra: REAL, kx, extraDeps });
  const BR = createBroker({ paper: c.t.paper, live: c.t.live, modeOf: () => 'live', kinds: () => ['live'] });
  const tick = async price => { move(c, price); await c.t.live.tick(); };
  return { db, kx, c, b: BR.of('intraday-x'), tick };
}
async function autoBuy5(x) {
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest' + Math.random().toString(36).slice(2, 10) });
  assert.equal(r.ok, true, JSON.stringify(r));
  x.kx.fill([...x.kx.orders.values()].slice(-1)[0].odno, 5, 10010);
  await x.tick(10000); await x.tick(10000);
}
const sellQtys = kx => kx.posts.filter(q => q.tr === 'TTTC0011U').map(q => +q.body.ORD_QTY);
async function plusDirect(x, n) { const h = x.kx.hold.get('005930'); h.qty += n; x.c.st.clock += 31000; await x.tick(10000); }

test('#1 자동매매 종목을 사이트에서 직접 더 사도 자동매매 몫·계획 유지 → 손절은 자동매매 몫(5주)만', async () => {
  const x = await rig(); await autoBuy5(x);
  await x.c.login();
  const r = await x.c.call('POST', '/trade/live/order', { body: { code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: PLAN } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await x.tick(10000); await x.tick(10000);
  const pl = x.db.t.live_plans.get('005930').plan;
  assert.equal(pl.own, 5, '자동매매 몫 유지'); assert.equal(x.kx.hold.get('005930').qty, 15);
  assert.ok(x.c.st.alerts.some(a => /직접 매수분의 매도 계획은 적용하지 않았습니다/.test(a)));
  await x.tick(9700); await x.tick(9700); await x.tick(9700);
  assert.deepEqual(sellQtys(x.kx), [5], '직접 산 10주는 팔지 않음');
  await x.c.close();
});
test('#2 진행 중 자동매매 매도가 있으면 두 번째 자동 매도는 거부 · 연결부의 가능 수량도 줄어듦', async () => {
  const x = await rig(); await autoBuy5(x); await plusDirect(x, 10);
  const s1 = await x.b.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 12000, qty: 5 });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  const S = await x.b.state(), p = S.positions.find(q => q.code === '005930');
  assert.equal(p.avail, 0, '자동매매 몫이 모두 매도 진행 중');
  const s2 = await x.b.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 12000, qty: 5 });
  assert.equal(s2.ok, false); assert.match(s2.error, /자동매매 몫 부족/);
  const s3 = await x.b.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 12000, qty: 1 });
  assert.equal(s3.ok, false, '1주도 더 못 팜');
  assert.deepEqual(sellQtys(x.kx), [5]);
  await x.c.close();
});
test('#2 손절 중 자동 매도 취소가 실패해도 자동매매 몫(5주)을 넘겨 팔지 않음', async () => {
  const x = await rig(); await autoBuy5(x); await plusDirect(x, 10);
  assert.equal((await x.b.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 12000, qty: 5 })).ok, true);
  x.kx.cancelFail = true;
  for (let i = 0; i < 6; i++) await x.tick(9700);
  assert.equal(sellQtys(x.kx).reduce((a, b) => a + b, 0), 5, '총 자동 매도 = 자동매매 몫');
  await x.c.close();
});
test('#2 손절은 사용자가 직접 낸 매도 주문을 취소하지 않음(자동매매 몫이 있는 종목)', async () => {
  const x = await rig(); await autoBuy5(x); await plusDirect(x, 10);
  await x.c.login();
  const m = await x.c.call('POST', '/trade/live/order', { body: { code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 12000, qty: 3 } });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  await x.tick(9700); await x.tick(9700);
  assert.equal(x.kx.posts.filter(q => q.tr === 'TTTC0013U').length, 0, '직접 매도 주문은 그대로');
  assert.deepEqual(sellQtys(x.kx), [3, 5]);
  await x.c.close();
});
test('#2 자동매매 몫 기록이 없는 종목은 자동 매도(origin)를 내지 않음', async () => {
  const x = await rig(); x.kx.hold.set('000660', { qty: 7, avg: 10000 });
  x.c.st.clock += 31000; await x.tick(10000);
  const r = await x.b.place({ code: '000660', name: 'SK하이닉스', side: 'sell', type: 'limit', price: 12000, qty: 7 });
  assert.equal(r.ok, false); assert.match(r.error, /자동매매 몫 기록이 없어/);
  await x.c.close();
});
test('#3 주문 기록 직후 서버가 죽은(접수 확인 중) 주문 — 재시작 뒤 대조되어 손절이 멈추지 않음', async () => {
  const x = await rig(); await autoBuy5(x);
  const t0 = x.c.st.clock;
  x.db.t.live_orders.set('Lcrash', { id: 'Lcrash', created_at: new Date(t0).toISOString(), updated_at: new Date(t0).toISOString(), code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 10300, qty: 1, filled_qty: 0, filled_amt: 0, avg_price: null, status: 'pending', reason: 'manual', plan: null, note: null, odno: null, orgno: null, ref_price: 10300, sim_avg: null, sim_qty: 0, sent_at: null, msg: null, cancel_req: false, excg: 'KRX' });
  await x.c.close();
  const y = await rig(x.db, x.kx); y.c.st.clock = x.c.st.clock;
  for (let i = 0; i < 30; i++) await y.tick(9500);
  assert.equal(y.db.t.live_orders.get('Lcrash').status, 'rejected', '60초 뒤 접수 안 된 것으로 정리(sent_at 없는 옛 행도)');
  assert.deepEqual(sellQtys(y.kx), [5], '손절 실행');
  await y.c.close();
});
test('#3 새 주문 행은 DB 기록 전에 보낸 시각(sent_at)이 있다 · drain 은 진행 중 작업을 기다리고 새 주문을 막음', async () => {
  const x = await rig();
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 1, plan: PLAN, cid: 'drain0000001' });
  assert.equal(r.ok, true);
  assert.ok([...x.db.t.live_orders.values()].every(o => o.sent_at), 'sent_at 기록');
  const d = await x.c.t.live.drain(1000);
  assert.equal(d.idle, true);
  const r2 = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 1, plan: PLAN, cid: 'drain0000002' });
  assert.equal(r2.ok, false); assert.equal(r2.status, 503);
  await x.c.close();
});
test('#4 주문 권한을 잃으면 시세 틱 점검(kick)도 손절 주문을 내지 않음', async () => {
  let auth = true;
  const x = await rig(null, null, { authority: () => auth });
  await autoBuy5(x); await x.tick(10000);
  auth = false; move(x.c, 9700);
  assert.equal(await x.c.t.kick('live', '005930'), false);
  assert.equal(sellQtys(x.kx).length, 0);
  await x.c.close();
});
test('#5 매수 정정도 1회 50만 원 상한 검사 · 한도 안 정정은 그대로 됨', async () => {
  const x = await rig();
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 49, plan: PLAN, cid: 'autotestcap01' });
  assert.equal(r.ok, true);
  const m = await x.b.modify({ id: r.order.id, price: 12000 });
  assert.equal(m.ok, false); assert.equal(m.status, 403);
  assert.equal(x.kx.posts.filter(q => q.tr === 'TTTC0013U').length, 0, 'KIS 로 정정이 나가지 않음');
  const ok = await x.b.modify({ id: r.order.id, price: 10000 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  await x.c.close();
});
test('#6 Supabase 장애로 주문 권한을 잃으면 알림 1회 + /health/engine 실패(standby 로 덮지 않음)', async () => {
  let t = 1e12, fail = false;
  const rest = async (path, method) => { if (fail) throw new Error('fetch failed'); if (method === 'PATCH') return [{ holder: 'me' }]; return []; };
  const notes = [];
  const L = G.createOrderLock({ rest, instanceId: 'me', now: () => t, notify: m => notes.push(m) });
  await L.attempt(); assert.equal(L.hasAuthority(), true);
  fail = true; t += 30000; await L.attempt(); t += 5000; await L.attempt(); await L.attempt();
  assert.equal(L.hasAuthority(), false);
  assert.equal(notes.filter(n => /주문 권한 잠금을 갱신하지 못해/.test(n)).length, 1);
  const h = G.evalHealth({ now: t, min: 600, tradingDay: true, bootAt: t - 3600e3, engines: { live: { enabled: true, lastTick: t - 120000 } }, token: { ok: true }, held: 3, authority: L.status() });
  assert.equal(h.ok, false); assert.equal(h.status, 'down'); assert.match(h.reasons.join(), /주문 권한을 가진 서버가 확인되지 않습니다/);
  fail = false; await L.attempt();
  assert.equal(L.hasAuthority(), true); assert.ok(notes.some(n => /다시 됩니다/.test(n)));
  const sb = G.evalHealth({ now: t, min: 600, tradingDay: true, bootAt: t - 3600e3, engines: {}, token: { ok: true }, held: 0, authority: { mode: 'ok', held: false, holder: 'other', lastErr: null } });
  assert.equal(sb.status, 'standby', '다른 인스턴스가 확실히 쥐고 있으면 정상 대기');
});
test('#12 실전 스위치가 켜져 있으면 engine_lock 테이블이 없을 때 주문 권한 없음(가상만이면 예전처럼 허용)', async () => {
  const rest = async () => { throw new Error('PGRST205 Could not find the table'); };
  const S = G.createOrderLock({ rest, instanceId: 'a', strict: () => true }); await S.attempt();
  assert.equal(S.hasAuthority(), false);
  const P = G.createOrderLock({ rest, instanceId: 'b', strict: () => false }); await P.attempt();
  assert.equal(P.hasAuthority(), true);
});
test('#7 다른 인스턴스가 받은 긴급 정지를 권한 획득 때 이어받음 · 이 서버에서 방금 바꾼 상태는 옛 기록으로 되돌리지 않음', async () => {
  const x = await rig();
  const add = (event, ts) => x.db.t.trade_audit.push({ event, ts: new Date(ts).toISOString(), ok: true });
  add('kill', Date.now() + 1000);   // 옛 인스턴스가 받은 /정지(기록만 있음)
  await x.c.t.reloadKill();
  const b = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 1, plan: PLAN, cid: 'killtest0001' });
  assert.equal(b.ok, false, '정지 이어받음 → 매수 거부'); assert.equal(b.status, 403);
  add('resume', Date.now() + 2000); await x.c.t.reloadKill(true);
  const b2 = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 1, plan: PLAN, cid: 'killtest0002' });
  assert.equal(b2.ok, true, '해제도 따라감');
  await x.c.close();
});
test('#9 잔고 연속 조회: tr_cont 가 F·M 이면 다음 쪽까지 읽음(허용목록 통과) · 한 번 안 보였다고 계획을 지우지 않음', async () => {
  const calls = [];
  const page = (rows, cont, nk) => Object.defineProperty({ rt_cd: '0', output1: rows, output2: [{ dnca_tot_amt: '1' }], ctx_area_fk100: 'F', ctx_area_nk100: nk }, '__trCont', { value: cont });
  const kisGet = async (path, tr, params, opts) => {
    calls.push({ tr, nk: params.CTX_AREA_NK100, cont: opts && opts.trCont });
    if (tr === 'TTTC8434R') return !params.CTX_AREA_NK100 ? page([{ pdno: '000001', hldg_qty: '1' }], 'F', 'P2') : page([{ pdno: '000002', hldg_qty: '2' }], 'D', '');
    return !params.CTX_AREA_NK100 ? page([{ odno: '1', pdno: '000001' }], 'M', 'X') : page([{ odno: '2', pdno: '000002' }], 'E', '');
  };
  const k = KO.createKisOrder({ ...AL.guardKis({ kisGet, kisPost: async () => ({}) }), account: { cano: '12345678', prdt: '01' } });
  const b = await k.balance();
  assert.deepEqual(b.positions.map(p => p.code), ['000001', '000002']);
  const d = await k.dailyOrders('20261119');
  assert.deepEqual(d.map(r => r.odno), ['1', '2']);
  assert.deepEqual(calls.filter(c => c.tr === 'TTTC8434R').map(c => [c.nk, c.cont]), [['', undefined], ['P2', 'N']]);
});
test('#9 잔고에서 한 번 빠져도 계획 유지 · 연속 두 번이면 정리', async () => {
  const x = await rig(); await autoBuy5(x);
  const h = x.kx.hold.get('005930'); x.kx.hold.delete('005930');
  x.c.st.clock += 61000; await x.tick(10000);
  assert.ok(x.db.t.live_plans.get('005930'), '한 번 빠짐 → 유지');
  x.kx.hold.set('005930', h); await x.tick(10000);
  x.kx.hold.delete('005930'); x.c.st.clock += 31000; await x.tick(10000); await x.tick(10000);
  assert.equal(x.db.t.live_plans.has('005930'), false, '연속 두 번 → 정리');
  await x.c.close();
});
test('#10 #11 응답 없던 주문: 60초 뒤 "접수 안 됨" 처리 후에도 하루 한도에 계속 포함 · 늦게 나타나면 되살림(지점번호 포함) · 후보가 둘이면 고르지 않음', async () => {
  const x = await rig();
  x.kx.next = 'UNKNOWN';
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10000, qty: 3, plan: PLAN, cid: 'lostorder001' });
  assert.equal(r.ok, true); assert.equal(r.order.status, 'unsure');
  for (let i = 0; i < 14; i++) await x.tick(10000);
  const o = [...x.db.t.live_orders.values()].find(q => q.qty === 3);
  assert.equal(o.status, 'rejected'); assert.equal(o.note, 'not_found');
  assert.equal((await x.c.t.live.state()).dayBuyKrw >= 30000, true, '한도 계산엔 남음');
  const tm = new Date(+new Date(o.sent_at) + 9 * 3600e3 + 3000).toISOString().slice(11, 19).replace(/:/g, '');
  x.kx.orders.set('0000777', { odno: '0000777', orgno: '06010', code: '005930', side: 'buy', qty: 3, price: 10000, type: 'limit', filled: 0, amt: 0, cancelled: false, tmd: tm, excg: 'KRX' });
  x.c.st.clock += 31000; await x.tick(10000);
  const o2 = x.db.t.live_orders.get(o.id);
  assert.equal(o2.status, 'open'); assert.equal(o2.odno, '0000777'); assert.equal(o2.note, 'late_found');
  assert.ok(x.c.st.alerts.some(a => /늦게 확인됐습니다/.test(a)));
  await x.c.close();
});
test('#15 전략 실행 모드를 한 번도 못 읽었으면 자동매매 주기를 돌지 않음(가상으로 오인하지 않음)', async () => {
  const A = require('../auto');
  let fail = true;
  const store = { list: async () => { if (fail) throw new Error('db down'); return [{ id: 'intraday-x', kind: 'intraday', params: { execMode: 'live' } }]; }, actives: async () => ({ Is: [], C: { params: {} } }), byId: async () => null };
  const a = A.createAuto({ strategies: store, sbGet: async () => [], sbWrite: async () => {}, sendTelegram: async () => {}, now: () => Date.now(), kstNow: () => ({ date: '2026-11-19', min: 600 }) });
  await new Promise(r => setTimeout(r, 10));
  const r = await a.tick();
  assert.equal(r.ok, false); assert.match(r.err, /실행 모드/);
  fail = false;
  const r2 = await a.tick().catch(e => ({ ok: false, err: String(e.message) }));   // 이 가짜 저장소로는 주기 전체가 돌지 않아도 됨 — 실행 모드 단계를 지났는지만 봄
  assert.notEqual(r2 && r2.err && /실행 모드/.test(r2.err), true);
});
test('#11 응답 없던 주문과 비슷한 KIS 주문이 둘이면(직접 주문일 수 있음) 자동으로 짝짓지 않고 알림', async () => {
  const x = await rig();
  x.kx.next = 'UNKNOWN';
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10000, qty: 3, plan: PLAN, cid: 'ambiguous001' });
  assert.equal(r.ok, true);
  const o = [...x.db.t.live_orders.values()].find(q => q.qty === 3);
  const tm = new Date(+new Date(o.sent_at) + 9 * 3600e3 + 2000).toISOString().slice(11, 19).replace(/:/g, '');
  for (const id of ['0000881', '0000882']) x.kx.orders.set(id, { odno: id, code: '005930', side: 'buy', qty: 3, price: 10000, type: 'limit', filled: 0, amt: 0, cancelled: false, tmd: tm, excg: 'KRX' });
  for (let i = 0; i < 4; i++) await x.tick(10000);
  const o2 = x.db.t.live_orders.get(o.id);
  assert.notEqual(o2.status, 'open'); assert.equal(o2.odno, null);
  assert.ok(x.c.st.alerts.some(a => /비슷한 주문이 2건/.test(a)));
  await x.c.close();
});
