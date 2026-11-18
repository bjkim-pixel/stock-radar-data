'use strict';
/* 실거래 전환 1단계: 자동매매 → 매매 엔진 연결부(broker.js) — 같은 시나리오를 가상 엔진과 실전 엔진(가짜 KIS)에 똑같이 돌린다 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot, fakeKis } = require('./paper-harness');
const { createBroker } = require('../broker');
const { createOptCol } = require('../opt-col');

const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const PLAN = { stopPct: 2, steps: [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 3 }] };   // 매수 10010 → 손절 9800
function move(c, price) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += 1000;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
}
async function setup(kind) {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: REAL, kx });
  const BR = createBroker({ paper: c.t.paper, live: c.t.live, modeOf: () => kind, kinds: () => [kind] });
  /* 엔진 한 주기: 실전은 체결조회·잔고 대조, 가상은 체결 판단 */
  const settle = async (price = 10000) => { move(c, price); if (kind === 'live') await c.t.live.tick(); else await c.t.paper.tick(); };
  /* 지정가 매수가 체결되게: 가상은 매도1호가 이상이면 즉시, 실전은 가짜 거래소에서 체결 처리 */
  const fillBuy = async (order, price) => { if (kind === 'live') { const odno = [...kx.orders.values()].find(o => o.side === 'buy' && !o.cancelled && o.filled < o.qty).odno; kx.fill(odno, order.qty - order.filled, price); } await settle(); await settle(); };
  return { db, kx, c, BR, b: BR.of('intraday-x'), settle, fillBuy };
}
const rowsOf = (x, kind) => [...x.db.t[kind === 'live' ? 'live_orders' : 'paper_orders'].values()];

for (const kind of ['paper', 'live']) {
  const K = kind === 'live' ? '실전' : '가상';

  test(`[${K}] 주문·조회·정정·취소가 같은 모양으로 — 출처(origin)·상태·fills`, async () => {
    const x = await setup(kind), b = x.b;
    assert.equal(b.kind, kind); assert.equal(b.real, kind === 'live'); assert.equal(b.label, K);
    const r = await b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 5, plan: PLAN, cid: 'autotest00001' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.order.origin, 'auto:intraday-x');
    assert.equal(r.order.status, 'open');
    assert.ok(Array.isArray(r.fills));
    assert.equal(rowsOf(x, kind).find(o => o.id === r.order.id).origin, 'auto:intraday-x', 'DB 에도 출처가 남는다');
    assert.ok((await b.held()).has('005930'), '진행 중 매수는 보유·주문 중으로 본다');

    const S = await b.state();
    const so = S.orders.find(o => o.id === r.order.id);
    assert.equal(so.kind, kind); assert.equal(so.origin, 'auto:intraday-x'); assert.equal(S.kind, kind);

    const newPlan = { ...PLAN, stopPct: 3 };
    const m = await b.modify({ id: r.order.id, price: 9950, plan: newPlan });
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.equal(m.order.price, 9950); assert.equal(m.order.origin, 'auto:intraday-x', '정정한 주문도 출처를 이어받는다');
    const mrow = rowsOf(x, kind).find(o => o.id === m.order.id);
    assert.equal(mrow.plan.stopPct, 3, '매수 정정 때 매도 계획도 바뀐다');

    const cx = await b.cancel(m.order.id);
    assert.equal(cx.ok, true, JSON.stringify(cx));
    await x.settle();
    const S2 = await b.state();
    assert.ok(!S2.orders.some(o => o.id === m.order.id && ['open', 'partial', 'unsure'].includes(o.status)), '취소한 주문은 더 이상 살아 있지 않다');
    await x.c.close();
  });

  test(`[${K}] 체결 → 계획이 보유로 옮겨짐 → 계획 수정 → 매도`, async () => {
    const x = await setup(kind), b = x.b;
    const r = await b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest00002' });
    assert.equal(r.ok, true, JSON.stringify(r));
    await x.fillBuy(r.order, 10010);
    let S = await b.state();
    const p = S.positions.find(q => q.code === '005930');
    assert.ok(p, '보유가 생긴다'); assert.equal(p.qty, 5); assert.equal(p.kind, kind);
    assert.equal(p.plan.stopPct, 2); assert.equal(p.stop, 9800);
    const e = await b.editPlan({ code: '005930', stopPct: 5, steps: [], ratchet: null });
    assert.equal(e.ok, true, JSON.stringify(e));
    S = await b.state();
    assert.equal(S.positions.find(q => q.code === '005930').plan.stopPct, 5);
    const s = await b.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'market', qty: 5 });
    assert.equal(s.ok, true, JSON.stringify(s));
    if (kind === 'paper') assert.equal(s.fills.reduce((a, f) => a + f.qty, 0), 5, '가상은 응답에 바로 체결');
    else assert.deepEqual(s.fills, [], '실전은 응답에 체결이 없고 체결조회로 들어온다');
    await x.settle(); await x.settle();
    S = await b.state();
    assert.ok(!S.positions.some(q => q.code === '005930' && q.qty > 0), '다 팔렸다');
    await x.c.close();
  });

  test(`[${K}] 아침 보류(setPreHold): 보류 중엔 손절을 내지 않고, 풀리면 손절`, async () => {
    const x = await setup(kind), b = x.b;
    let hold = true; const asked = [];
    x.BR.setPreHold(async (code, min) => { asked.push([code, min]); return hold; });
    const r = await b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest00003' });
    await x.fillBuy(r.order, 10010);
    const sells = () => rowsOf(x, kind).filter(o => o.side === 'sell' && o.reason === 'stop').length;
    await x.settle(9700); await x.settle(9700);
    assert.ok(asked.length > 0, '엔진이 손절 전에 보류 여부를 묻는다');
    assert.equal(sells(), 0, '보류 중에는 손절 주문 없음');
    hold = false;
    await x.settle(9700); await x.settle(9700);
    assert.ok(sells() >= 1, '보류가 풀리면 손절');
    await x.c.close();
  });
}

test('[실전] KIS 응답이 없으면 "접수 확인 중"(unsure) — 원래 상태는 rawStatus', async () => {
  const x = await setup('live'), b = x.b;
  x.kx.next = 'UNKNOWN';
  const r = await b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 5, plan: PLAN, cid: 'autotest00004' });
  assert.equal(r.ok, true);
  assert.equal(r.order.status, 'unsure'); assert.equal(r.order.rawStatus, 'unknown');
  const S = await b.state();
  assert.equal(S.orders.find(o => o.id === r.order.id).status, 'unsure');
  const cx = await b.cancel(r.order.id);
  assert.equal(cx.ok, false, '접수 확인 중에는 취소할 수 없다');
  await x.c.close();
});

test('실전 엔진이 없으면(계좌 미설정) 주문은 503 — 가상으로 돌리지 않는다', async () => {
  const placed = [];
  const BR = createBroker({ paper: { place: async b => { placed.push(b); return { ok: true, order: {} }; }, heldCodes: () => new Set() }, live: null, modeOf: () => 'live' });
  const r = await BR.of('s').place({ code: '005930', side: 'buy', type: 'limit', price: 1, qty: 1 });
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.equal(placed.length, 0);
  assert.equal(BR.of('s').available, false);
});

test('보유 확인: 가상은 실패해도 빈 목록(예전과 같음), 실전은 확인 못 하면 예외', async () => {
  const paper = { heldCodes: () => { throw new Error('x'); }, state: async () => ({ ok: true }) };
  const live = { heldCodes: () => new Set(['000660']), state: async () => ({ ok: false, error: '잔고 조회 실패' }) };
  const onlyPaper = createBroker({ paper, live, modeOf: () => 'paper' });
  assert.deepEqual([...(await onlyPaper.heldAll())], []);
  const both = createBroker({ paper: { heldCodes: () => new Set(['005930']) }, live, modeOf: () => 'live', kinds: () => ['live'] });
  await assert.rejects(both.heldAll(), /잔고 조회 실패/);
  await assert.rejects(both.of('s').held(), /잔고 조회 실패/);
  const ok = createBroker({ paper: { heldCodes: () => new Set(['005930']) }, live: { heldCodes: () => new Set(['000660']), state: async () => ({ ok: true, account: true }) }, modeOf: () => 'live', kinds: () => ['live'] });
  assert.deepEqual([...(await ok.heldAll())].sort(), ['000660', '005930'], '쓰이는 엔진 전부(실전 계좌의 직접 보유 포함)를 후보에서 뺀다');
  const noAcct = createBroker({ live: { heldCodes: () => new Set(), state: async () => ({ ok: true, account: false }) }, modeOf: () => 'live' });
  await assert.rejects(noAcct.of('s').held(), /계좌가 설정되지/);
});

test('실행 모드 설정 전(modeOf 없음)에는 모든 전략이 가상 · 실전 엔진은 쓰이지 않음', async () => {
  const BR = createBroker({ paper: { heldCodes: () => new Set() }, live: { heldCodes: () => { throw new Error('부르면 안 됨'); }, state: async () => { throw new Error('부르면 안 됨'); } } });
  assert.equal(BR.of('a').kind, 'paper'); assert.equal(BR.of('a').label, '가상');
  assert.deepEqual(BR.kindsInUse(), ['paper']);
  assert.deepEqual([...(await BR.heldAll())], []);
});

test('합친 보기(stateAll): 쓰이는 엔진의 보유·주문·체결을 합치고 각 행에 kind', async () => {
  const P = { ok: true, positions: [{ code: 'A', qty: 1 }], orders: [{ id: 'o1', status: 'open' }], fills: [], realizedToday: 100 };
  const L = { ok: true, positions: [{ code: 'B', qty: 2 }], orders: [{ id: 'L1', status: 'pending' }], fills: [{ id: 'f' }], realizedToday: -30 };
  const BR = createBroker({ paper: { state: async () => P }, live: { state: async () => L }, kinds: () => ['live'] });
  const S = await BR.stateAll();
  assert.deepEqual(S.positions.map(p => [p.code, p.kind]), [['A', 'paper'], ['B', 'live']]);
  assert.deepEqual(S.orders.map(o => [o.id, o.status, o.kind]), [['o1', 'open', 'paper'], ['L1', 'unsure', 'live']]);
  assert.equal(S.realizedToday, 70);
  const onlyPaper = createBroker({ paper: { state: async () => P }, live: { state: async () => L } });
  assert.equal((await onlyPaper.stateAll()).positions.length, 1);
});

/* ── 자동매매 주문 관리(auto-exec)가 "접수 확인 중"을 취소된 것으로 오해하지 않는지 ── */
test('auto-exec: 접수 확인 중(unsure) 주문은 정정·취소·종료 처리하지 않고 기다린다', async () => {
  const X = require('../auto-exec');
  let t = 1e12;
  const run = { payload: { picks: [{ code: '005930', name: '삼성전자' }], orders: { '005930': { st: 'open', orderId: 'L1', placedAt: t - 3600e3, buy: 9900, qty: 5 } } } };
  const calls = [];
  const broker = { label: '실전', state: async () => ({ ok: true, orders: [{ id: 'L1', code: '005930', side: 'buy', status: 'unsure', rawStatus: 'unknown', price: 9900, qty: 5, filled: 0 }] }),
    modify: async b => { calls.push(['modify', b]); return { ok: true, order: {} }; }, cancel: async id => { calls.push(['cancel', id]); return { ok: true }; } };
  const ex = X.createExec({ broker, getQuote: async () => ({ price: 9800, bids: [{ p: 9800, q: 1 }], asks: [{ p: 9810, q: 1 }] }), loadChart: async () => [], sendTelegram: async () => {}, now: () => t,
    mutateRun: async (d, fn) => fn(run), readRun: async () => run, opt: async () => ({ fillWaitMs: 60e3, cancelWaitMs: 60e3 }) });
  await ex.follow('2027-01-13');
  assert.deepEqual(calls, []);
  assert.equal(run.payload.orders['005930'].st, 'open', '장부도 그대로(취소로 적지 않음)');
  const u = await ex.userEdit('2027-01-13', '005930', { action: 'cancel' });
  assert.equal(u.ok, false); assert.match(u.error, /접수 확인 중/);
});

test('auto-exec: 보유 확인이 실패하면 사지 않는다 · 이미 보유(Set)면 건너뜀 — 예전엔 Set.includes 오류로 이 검사가 무시됐음', async () => {
  const X = require('../auto-exec');
  for (const [held, why] of [[async () => { throw new Error('잔고 조회 실패'); }, /보유 종목 확인 실패 — 잔고 조회 실패/], [async () => new Set(['005930']), /이미 보유·주문 중/]]) {
    const runs = { payload: { picks: [{ code: '005930', name: '삼성전자', price: 70000 }], approved: ['005930'] } };
    let placed = 0;
    const ex = X.createExec({ broker: { label: '실전', held, place: async () => { placed++; return { ok: false }; } }, getQuote: async () => ({ price: 70000, bids: [] }), loadChart: async () => [],
      sendTelegram: async () => {}, mutateRun: async (d, fn) => fn(runs), readRun: async () => runs, perStock: async () => 1e6, opt: async () => ({}) });
    const msg = await ex.approve('D', runs.payload);
    assert.match(msg, why); assert.equal(placed, 0);
    assert.match(msg, /실전 매수/, '알림에 실전 표시');
  }
  /* 실제 가상 엔진(paper.js)이 돌려주는 Set 으로도 걸러지는지 */
  const x = await setup('paper');
  await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 5, cid: 'autotest00005' });
  const runs = { payload: { picks: [{ code: '005930', name: '삼성전자', price: 70000 }], approved: ['005930'] } };
  const ex = X.createExec({ broker: x.BR.of('intraday-y'), getQuote: async () => ({ price: 70000, bids: [] }), loadChart: async () => [],
    sendTelegram: async () => {}, mutateRun: async (d, fn) => fn(runs), readRun: async () => runs, perStock: async () => 1e6, opt: async () => ({}) });
  assert.match(await ex.approve('D', runs.payload), /이미 보유·주문 중/);
  await x.c.close();
});

/* ── 선택 컬럼(origin): DB 설정 전에도 기록이 멈추지 않는다 ── */
test('opt-col: 컬럼이 없으면(PGRST204) 빼고 다시 쓰고, 이후로는 계속 뺀다 · 다른 오류는 그대로', async () => {
  const writes = []; let miss = 0;
  const W = async (path, method, rows) => {
    writes.push(rows.map(r => Object.keys(r).sort().join(',')));
    if (rows.some(r => 'origin' in r)) throw new Error('POST paper_orders 400 {"code":"PGRST204","message":"Could not find the \'origin\' column of \'paper_orders\' in the schema cache"}');
  };
  const oc = createOptCol('origin', { onMissing: () => miss++ });
  await oc.write(W, 'paper_orders', 'POST', [{ id: 1, origin: 'auto' }]);
  await oc.write(W, 'paper_orders', 'POST', [{ id: 2, origin: 'auto' }]);
  assert.deepEqual(writes, [['id,origin'], ['id'], ['id']]);
  assert.equal(miss, 1); assert.equal(oc.has, false);
  const oc2 = createOptCol('origin');
  await assert.rejects(oc2.write(async () => { throw new Error('network'); }, 'p', 'POST', [{ origin: 'auto' }]), /network/);
});

test('가상 엔진: origin 컬럼이 없는 DB 에서도 자동 주문이 그대로 기록된다', async () => {
  const db = fakeDb();
  const raw = db.sbWrite;
  db.sbWrite = async (path, method, rows) => {
    if (path === 'paper_orders' && Array.isArray(rows) && rows.some(r => r && 'origin' in r)) throw new Error('POST paper_orders 400 {"code":"PGRST204","message":"Could not find the \'origin\' column"}');
    return raw(path, method, rows);
  };
  const c = await boot(db, {});
  const BR = createBroker({ paper: c.t.paper });
  const r = await BR.of('s1').place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9900, qty: 5, cid: 'autotest00006' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = db.t.paper_orders.get(r.order.id);
  assert.ok(row, '주문이 기록됨'); assert.equal('origin' in row, false);
  await c.close();
});

test('아침 보류는 엔진 종류를 함께 넘긴다 — 이월을 넘긴 전략의 엔진에서만 보류', async () => {
  const seen = [];
  const P = { setPreHold: f => { P.f = f; } }, L = { setPreHold: f => { L.f = f; } };
  const BR = createBroker({ paper: P, live: L, modeOf: sid => (sid === 'live-s' ? 'live' : 'paper') });
  BR.setPreHold(async (code, min, kind) => { seen.push(kind); return kind === BR.modeOf('paper-s'); });   // 가상 전략이 넘긴 이월 종목
  assert.equal(await P.f('005930', 500), true, '가상 엔진은 보류');
  assert.equal(await L.f('005930', 500), false, '같은 종목이라도 실전 엔진(직접 보유)은 보류하지 않음');
  assert.deepEqual(seen, ['paper', 'live']);
});

test('화면(HTTP)에서 온 주문은 origin 을 보내도 직접 주문으로 기록 — 자동매매 출처를 사칭할 수 없음', async () => {
  const db = fakeDb(), c = await boot(db, {});
  await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9900, qty: 1, origin: 'auto:intraday-default' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.t.paper_orders.get(r.body.order.id);
  assert.equal(row.origin, undefined); assert.equal(r.body.order.origin, null);
  await c.close();
});
