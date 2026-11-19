'use strict';
/* 실거래 전환 3단계 — KIS 호출 허용목록(은행·이체 호출 차단) · 계좌 현황 · 일일 대사 · 수수료·세금 추정 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const AL = require('../kis-allow');
const RC = require('../recon');
const { createBroker } = require('../broker');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

/* ── ① 허용목록 ── */
test('허용목록: 조회 3개·주문 3개 조합만 통과하고 나머지는 전부 막는다', () => {
  assert.equal(AL.ALLOW.length, 6);
  for (const a of AL.ALLOW) assert.equal(AL.isAllowed(a.m, a.path, a.tr), true, a.what);
  const B = '/uapi/domestic-stock/v1/trading/';
  assert.equal(AL.isAllowed('GET', B + 'order-cash', 'TTTC0012U'), false, '방식 불일치');
  assert.equal(AL.isAllowed('POST', B + 'inquire-balance', 'TTTC8434R'), false, '조회 경로에 POST');
  assert.equal(AL.isAllowed('GET', B + 'inquire-balance', 'TTTC0012U'), false, 'TR_ID 불일치');
  for (const p of ['transfer', 'bank-transfer', 'withdraw', 'deposit', 'order-resv', 'inquire-account-balance', 'cash-transfer', '../etc/transfer'])
    for (const m of ['GET', 'POST']) assert.equal(AL.isAllowed(m, B + p, 'TTTC8434R'), false, p);
  assert.equal(AL.isAllowed('POST', '/uapi/domestic-stock/v1/etc/transfer', 'TTTC0012U'), false);
});
test('허용목록: 감싼 함수는 막힌 호출을 KIS 로 보내기 전에 BLOCKED 로 끊는다', async () => {
  const sent = [], g = AL.guardKis({ kisGet: async (...a) => { sent.push(['G', ...a]); return {}; }, kisPost: async (...a) => { sent.push(['P', ...a]); return {}; } });
  await g.kisGet('/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', {});
  await assert.rejects(() => g.kisPost('/uapi/domestic-stock/v1/trading/order-transfer', 'TTTC8434R', {}), e => e.code === 'BLOCKED');
  await assert.rejects(() => g.kisGet('/uapi/domestic-stock/v1/trading/inquire-account-balance', 'CTRP6548R', {}), e => e.code === 'BLOCKED');
  await assert.rejects(() => g.kisPost('/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', {}), e => e.code === 'BLOCKED');
  assert.equal(sent.length, 1, '막힌 호출은 아래로 전달되지 않음');
});
test('허용목록(정적 점검): 서버 소스에서 /trading/ KIS 경로는 kis-order.js 에만 있고 모두 허용목록 안 · 이체·출금류 경로 문자열 없음', () => {
  const dir = path.join(__dirname, '..'), found = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\/uapi\/[A-Za-z0-9_\-\/]+/g)) {
      if (f === 'kis-allow.js') continue;
      found.push([f, m[0]]);
      assert.doesNotMatch(m[0], /transfer|withdraw|deposit|bank|loan|remit|ovrs/i, `${f}: ${m[0]}`);
    }
  }
  const allowed = new Set(AL.ALLOW.map(a => a.path));
  for (const [f, p] of found.filter(([, p]) => p.includes('/trading/'))) {
    assert.equal(f === 'kis-order.js', true, `${f} 가 계좌·주문 경로를 직접 가짐: ${p}`);
    assert.equal(allowed.has(p) || allowed.has(p.replace(/\/$/, '')), true, `허용목록에 없음: ${p}`);
  }
  assert.ok(found.some(([f]) => f === 'kis-order.js'));
  const tr = fs.readFileSync(path.join(dir, 'trade.js'), 'utf8');
  assert.match(tr, /createKisOrder\(\{ \.\.\.guardKis\(\{ kisGet: deps\.kisGet, kisPost: deps\.kisPost \}\), account \}\)/, 'kis-order 는 반드시 허용목록 감싸기를 거쳐 만든다');
});

/* ── ② 계좌 현황 · 비용 · 대사 (가짜 KIS) ── */
const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const PLAN = { stopPct: 2, steps: [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 3 }] };
function move(c, price) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += 1000;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
}
async function rig() {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: REAL, kx });
  const BR = createBroker({ paper: c.t.paper, live: c.t.live, modeOf: () => 'live', kinds: () => ['live'] });
  const tick = async p => { move(c, p); await c.t.live.tick(); };
  const gets = []; const g0 = kx.get; kx.get = async (tr, p) => { gets.push(tr); return g0(tr, p); };
  return { db, kx, c, BR, b: BR.of('intraday-x'), tick, gets, live: c.t.live };
}
async function autoBuy(x, qty = 5) {
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty, plan: PLAN, cid: 'autotest20001' });
  assert.equal(r.ok, true, JSON.stringify(r));
  x.kx.fill([...x.kx.orders.values()].pop().odno, qty, 10010);
  await x.tick(10000); await x.tick(10000);
}
test('계좌 현황: 예수금·D+1·D+2·총평가·손익이 KIS 응답 그대로 · 자동매매 몫/직접 수량 분리 · 조회 TR 만 사용(주문·이체 없음)', async () => {
  const x = await rig();
  await autoBuy(x, 5);
  const h = x.kx.hold.get('005930'); h.avg = (h.avg * h.qty + 10000 * 10) / (h.qty + 10); h.qty += 10;   // 직접 10주
  x.c.st.clock += 31000; await x.tick(10000);
  const posts0 = x.kx.posts.length; x.gets.length = 0;
  const a = await x.live.account();
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual({ cash: a.summary.cash, d1: a.summary.d1, d2: a.summary.d2, total: a.summary.total, purchase: a.summary.purchase, evalAmt: a.summary.evalAmt, pnl: a.summary.pnl },
    { cash: 1000000, d1: 900000, d2: 800000, total: 2000000, purchase: 500000, evalAmt: 520000, pnl: 20000 });
  const p = a.positions.find(q => q.code === '005930');
  assert.equal(p.qty, 15); assert.equal(p.own, 5); assert.equal(p.direct, 10); assert.equal(p.auto, true);
  assert.equal(a.buyable.ok, true); assert.ok(a.buyable.cash > 0);
  for (const tr of x.gets) assert.ok(['TTTC8434R', 'TTTC8908R'].includes(tr), '조회 TR 만: ' + tr);
  assert.equal(x.kx.posts.length, posts0, '계좌 현황은 주문·정정·취소를 내지 않음');
});
test('계좌 현황: 매수가능조회가 실패해도 나머지는 보여 주고 이유만 표시 · 계좌 미설정이면 account:false', async () => {
  const x = await rig(); x.kx.buyableFail = true;
  const a = await x.live.account();
  assert.equal(a.ok, true); assert.equal(a.buyable.ok, false); assert.equal(a.summary.cash, 1000000);
  const db = fakeDb(), c = await boot(db, { envExtra: { REAL_TRADING_ENABLED: '1' }, kx: fakeKis() });
  const a2 = await c.t.live.account();
  assert.equal(a2.ok, true); assert.equal(a2.account, false, '계좌 환경변수가 없으면 계좌 없음으로 알림');
});
test('비용: 체결마다 수수료·세금 추정이 저장되고(매수 0.015% · 매도 0.215%) 성과의 net 은 그만큼 뺀다', async () => {
  const x = await rig();
  await autoBuy(x, 10);   // 10 × 10010 = 100,100 → 수수료 15
  const f = [...x.db.t.live_fills.values()][0];
  assert.equal(f.fee, Math.round(100100 * 0.015 / 100));
  await x.tick(9700); await x.tick(9700);   // 손절 → 매도 체결
  const sells = [...x.db.t.live_fills.values()].filter(q => q.side === 'sell');
  assert.ok(sells.length >= 1); for (const s of sells) assert.equal(s.fee, Math.round(s.amount * 0.215 / 100));
  const r = await x.live.report(null, null);
  assert.equal(r.ok, true); assert.equal(r.summary.net, r.summary.realized - r.summary.fee);
  assert.ok(r.summary.fee > 15, '매도 비용까지 합산');
});
const mk = (o = {}) => ({ ok: true, day: '2026-11-19', kisRows: [], orders: [], positions: [], plans: [], ...o });
const ord = (o = {}) => ({ id: 'L1', code: '005930', name: '삼성전자', side: 'buy', qty: 5, filled: 5, status: 'filled', odno: '0000001001', origin: 'auto:intraday-x', createdAt: 1, ...o });
const row = (o = {}) => ({ odno: '0000001001', code: '005930', side: 'buy', qty: 5, filled: 5, ...o });
test('대사(순수): 일치하면 이상 없음 · 직접 주문은 건수만', () => {
  const r = RC.reconcile(mk({ kisRows: [row(), row({ odno: '0000009999', filled: 3 })], orders: [ord()], positions: [{ code: '005930', qty: 8 }], plans: [{ code: '005930', own: 5 }] }));
  assert.equal(r.ok, true); assert.equal(r.stats.matched, 1); assert.equal(r.stats.direct, 1);
});
test('대사(순수): 체결 수량 불일치 · KIS 에 없는 주문 · 확인 중 주문 · 자동매매 몫 부족을 전략별로 찾는다', () => {
  const fill = RC.reconcile(mk({ kisRows: [row({ filled: 3 })], orders: [ord()], positions: [{ code: '005930', qty: 5 }], plans: [{ code: '005930', own: 5 }] }));
  assert.equal(fill.ok, false); assert.equal(fill.issues[0].kind, 'fill'); assert.equal(fill.issues[0].sid, 'intraday-x'); assert.match(fill.issues[0].text, /우리 5주 · 한국투자증권 3주/);
  const miss = RC.reconcile(mk({ kisRows: [], orders: [ord()] }));
  assert.equal(miss.issues[0].kind, 'missing');
  const uns = RC.reconcile(mk({ orders: [ord({ status: 'unknown', odno: null, filled: 0 })] }));
  assert.equal(uns.issues[0].kind, 'unsure');
  const rej = RC.reconcile(mk({ orders: [ord({ status: 'rejected', odno: null, filled: 0 })] }));
  assert.equal(rej.ok, true, '거부돼 접수번호가 없는 주문은 문제 아님');
  const pos = RC.reconcile(mk({ kisRows: [row()], orders: [ord()], positions: [{ code: '005930', qty: 2 }], plans: [{ code: '005930', own: 5 }] }));
  assert.equal(pos.issues[0].kind, 'position'); assert.equal(pos.issues[0].sid, 'intraday-x'); assert.match(pos.issues[0].text, /5주인데 실제 계좌엔 2주뿐/);
  const own0 = RC.reconcile(mk({ positions: [], plans: [{ code: '005930', own: 0 }, { code: '000660', own: null }] }));
  assert.equal(own0.ok, true, '자동매매 몫이 없는 계획은 대상 아님');
});
function reconRig(snaps) {
  const store = new Map(), msgs = []; let i = 0;
  const live = { reconSnapshot: async () => snaps[Math.min(i++, snaps.length - 1)] };
  const rc = RC.createRecon({ live, notify: t => msgs.push(t), kstNow: () => rc._now, isTradingDay: () => true,
    sbGet: async () => (store.has('r') ? [{ value: JSON.parse(store.get('r')) }] : []), sbWrite: async (p, m, b) => { store.set('r', JSON.stringify(b[0].value)); } });
  rc._now = { date: '2026-11-19', min: 940 };
  return { rc, msgs, store };
}
test('대사 흐름: 불일치 → 그 전략만 신규 매수 정지 + 알림 → 다음날 깨끗하면 풀림 · /대사해제 로 즉시 풀기', async () => {
  const bad = mk({ kisRows: [row({ filled: 3 })], orders: [ord()] }), good = mk({ day: '2026-11-20' });
  const { rc, msgs } = reconRig([bad, bad, good]);
  assert.equal(await rc.tick(), null, '15:45 전에는 안 돎');
  rc._now.min = 945; const r = await rc.tick();
  assert.equal(r.ok, true); assert.equal(r.issues.length, 1);
  assert.match(await rc.blockedFor('intraday-x'), /신규 매수 정지/); assert.equal(await rc.blockedFor('intraday-y'), null, '다른 전략은 영향 없음');
  assert.match(msgs[0], /대사 불일치 1건/);
  assert.equal(await rc.tick(), null, '같은 시각 중복 실행 없음');
  rc._now.min = 1210; await rc.tick();   // 같은 날 20:10 — 아직 불일치
  assert.ok(await rc.blockedFor('intraday-x'), '같은 날에는 풀리지 않음');
  rc._now = { date: '2026-11-20', min: 945 }; await rc.tick();
  assert.equal(await rc.blockedFor('intraday-x'), null, '다음 거래일 대사가 깨끗하면 풀림');
  const b2 = reconRig([bad]); b2.rc._now.min = 945; await b2.rc.tick();
  assert.equal(await b2.rc.clear('intraday-x'), 1); assert.equal(await b2.rc.blockedFor('intraday-x'), null);
});
test('대사 흐름: 전략을 알 수 없는 불일치는 실전 전략 전부 정지 · 조회 실패는 알림만(정지 안 함) · 휴장일·권한 없음은 건너뜀', async () => {
  const bad = mk({ kisRows: [], orders: [ord({ origin: null })] });
  const a = reconRig([bad]); a.rc._now.min = 950; await a.rc.tick();
  assert.ok(await a.rc.blockedFor('아무전략'), '* 차단');
  const f = reconRig([{ ok: false, error: '잔고 조회 실패' }]); f.rc._now.min = 950; const r = await f.rc.tick();
  assert.equal(r.ok, false); assert.equal(await f.rc.blockedFor('x'), null); assert.match(f.msgs[0], /대사를 하지 못했습니다/);
  const h = RC.createRecon({ live: { reconSnapshot: async () => { throw new Error('호출되면 안 됨'); } }, kstNow: () => ({ date: '2026-11-21', min: 960 }), isTradingDay: () => false, sbGet: async () => [], sbWrite: async () => {}, notify() {} });
  assert.equal(await h.tick(), null);
  const n = RC.createRecon({ live: { reconSnapshot: async () => { throw new Error('호출되면 안 됨'); } }, authority: () => false, kstNow: () => ({ date: '2026-11-19', min: 960 }), isTradingDay: () => true, sbGet: async () => [], sbWrite: async () => {}, notify() {} });
  assert.equal(await n.tick(), null);
});
test('대사 스냅샷(실제 엔진): 가짜 KIS 의 체결과 우리 기록이 맞으면 이상 없음 · 직접 주문은 건수만 · 자동매매 몫이 계좌보다 크면 불일치', async () => {
  const x = await rig();
  await autoBuy(x, 5);
  const direct = { odno: String(++x.kx.seq), code: '000660', side: 'buy', qty: 3, price: 200000, type: 'limit', filled: 3, amt: 600000, cancelled: false, tmd: '100000', excg: 'KRX' };
  x.kx.orders.set(direct.odno, direct);   // 앱에서 직접 낸 주문
  const snap = await x.live.reconSnapshot();
  assert.equal(snap.ok, true);
  let r = RC.reconcile(snap); assert.equal(r.ok, true, JSON.stringify(r.issues)); assert.equal(r.stats.direct, 1); assert.equal(r.stats.matched, 1);
  x.kx.hold.get('005930').qty = 2;   // 앱에서 3주를 직접 팔아 자동매매 몫(5)보다 적어짐
  r = RC.reconcile(await x.live.reconSnapshot());
  assert.equal(r.ok, false); assert.equal(r.issues.some(i => i.kind === 'position' && i.sid === 'intraday-x'), true);
});
test('실전 수동 화면: 자동매매 매수가 걸린 종목은 별도 매수 막기 · 자동 주문의 정정·취소는 자동매매 기록과 같은 경로로(가상과 동일)', async () => {
  const x = await rig(); await x.c.login();
  const calls = [];
  const kinds = [];
  x.c.t.attachAuto({ pendingAutoBuy: async (code, k) => { kinds.push(k); return code === '005930' && k === 'live' ? 'L-auto' : null; }, autoOrderCode: async (id, k) => { kinds.push(k); return id === 'L-auto' && k === 'live' ? '005930' : null; },
    siteOrderEdit: async b => { calls.push(b); return { ok: true, action: b.action, real: true }; } });
  const buy = await x.c.call('POST', '/trade/live/order', { body: { code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 1 } });
  assert.equal(buy.status, 409); assert.match(buy.body.error, /자동매매 매수 주문이 체결 대기 중/);
  assert.equal(x.kx.posts.length, 0, 'KIS 로 주문이 나가지 않음');
  const cn = await x.c.call('POST', '/trade/live/cancel', { body: { id: 'L-auto' } });
  assert.equal(cn.status, 200); assert.deepEqual(calls[0], { code: '005930', engine: 'live', orderId: 'L-auto', action: 'cancel' });
  const md = await x.c.call('POST', '/trade/live/modify', { body: { id: 'L-auto', price: 9990, qty: 3 } });
  assert.equal(md.status, 200); assert.deepEqual(calls[1], { code: '005930', engine: 'live', orderId: 'L-auto', action: 'modify', price: 9990, qty: 3 });
  assert.equal(x.kx.posts.length, 0, '자동 주문 정정·취소는 자동매매 경로가 처리(여기선 가짜)');
  const other = await x.c.call('POST', '/trade/live/order', { body: { code: '000660', side: 'buy', type: 'limit', price: 10000, qty: 1 } });
  assert.notEqual(other.status, 409, '다른 종목 수동 주문은 영향 없음');
  assert.ok(kinds.length && kinds.every(k => k === 'live'), '실전 화면은 실전 장부만 물어봄');
});
