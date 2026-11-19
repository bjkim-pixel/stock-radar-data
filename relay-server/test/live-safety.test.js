'use strict';
/* 실거래 전환 2단계 — 실행 모드·금액 자동 조정·이상 동작 차단·정지 단계·자동매매 수량만 매도·손절 집행 감시.
   완료 기준(기획안): 가짜 KIS 로 거부·무응답·부분체결·중복·예수금 부족·연속 거부 시나리오 통과 */
const test = require('node:test');
const assert = require('node:assert/strict');
const SZ = require('../auto-size');
const X = require('../auto-exec');
const S = require('../auto-strategy');
const A = require('../auto');
const { createBroker, ownView } = require('../broker');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

/* ── ① 금액 자동 조정(C-2) ── */
test('금액: 기획안 예시 — 매수 가능 200만 + 자동매매 보유 50만 → 250만 × 20% = 50만(상한 50만 안)', () => {
  const z = SZ.sizeOf({ mode: 'balance', cash: 2000000, autoValue: 500000, maxBuys: 5, capKrw: 500000, minKrw: 100000 });
  assert.equal(z.krw, 500000); assert.equal(z.capital, 2500000); assert.equal(z.weight, 0.2);
  const z2 = SZ.sizeOf({ mode: 'balance', cash: 1000000, autoValue: 0, maxBuys: 5, capKrw: 500000, minKrw: 100000 });
  assert.equal(z2.krw, 200000, '계좌에 100만이면 20만씩');
});
test('금액: 1회 상한·주문 가능 금액으로 줄이고 사유 표시 · 시장 상태 배수 · 비중 설정값', () => {
  const big = SZ.sizeOf({ mode: 'balance', cash: 10000000, autoValue: 0, maxBuys: 5, capKrw: 500000, minKrw: 100000 });
  assert.equal(big.krw, 500000); assert.equal(big.capBy, '1회 오작동 상한');
  assert.match(SZ.sizeText(big, 'balance'), /1회 오작동 상한에 맞춤/);
  const lowCash = SZ.sizeOf({ mode: 'fixed', fixedKrw: 400000, cash: 250000, capKrw: 500000, minKrw: 100000 });
  assert.equal(lowCash.krw, 250000); assert.equal(lowCash.capBy, '주문 가능 금액');
  const reg = SZ.sizeOf({ mode: 'balance', cash: 2000000, autoValue: 0, maxBuys: 5, mult: 0.5, capKrw: 500000, minKrw: 100000 });
  assert.equal(reg.krw, 200000, '보수 단계 50%');
  const pct = SZ.sizeOf({ mode: 'balance', cash: 2000000, autoValue: 0, pct: 10, maxBuys: 5, minKrw: 100000 });
  assert.equal(pct.krw, 200000);
});
test('금액: 예수금 부족 · 최소 주문 금액 미만이면 사지 않고 사유 · 가상 잔고 기준은 가상 운용 자금에서', () => {
  assert.match(SZ.sizeOf({ mode: 'fixed', fixedKrw: 400000, cash: 50000, capKrw: 500000, minKrw: 100000 }).skip, /주문 가능 금액 부족\(50,000원/);
  assert.match(SZ.sizeOf({ mode: 'balance', cash: 300000, autoValue: 0, maxBuys: 5, minKrw: 100000 }).skip, /최소 주문 금액/);
  assert.match(SZ.sizeOf({ mode: 'fixed', fixedKrw: 400000, cash: NaN, minKrw: 100000 }).skip, /확인하지 못했/);
  const paper = SZ.sizeOf({ mode: 'balance', cash: null, paperCapital: 10000000, paperUsed: 4000000, autoValue: 4200000, maxBuys: 5, minKrw: 100000 });
  assert.equal(paper.capital, 10200000); assert.equal(paper.krw, 2040000, '가상은 1회 상한 없이(가상 한도는 엔진이)');
});

/* ── ② 이상 동작 차단(C2) ── */
test('차단 계산: 종목당 하루 1회 · 하루 주문 횟수 상한 · 거부 3번/응답 없음 2번이면 그날 정지', () => {
  const L = { maxOrdersDay: 4, rejectStop: 3, unsureStop: 2 }, g = SZ.gate0();
  assert.equal(SZ.gateCheck(g, 'A', L), null);
  SZ.gateAfter(g, 'order', 'A', L); SZ.gateAfter(g, 'filled', 'A', L);
  assert.match(SZ.gateCheck(g, 'A', L), /하루 1회/);
  assert.equal(SZ.gateCheck(g, 'B', L), null);
  SZ.gateAfter(g, 'modify', 'B', L); SZ.gateAfter(g, 'order', 'B', L); SZ.gateAfter(g, 'order', 'C', L);
  assert.match(SZ.gateCheck(g, 'D', L), /하루 주문 횟수 상한\(4번\)/);
  const g2 = SZ.gate0();
  assert.equal(SZ.gateAfter(g2, 'reject', 'A', L), null); assert.equal(SZ.gateAfter(g2, 'reject', 'B', L), null);
  assert.match(SZ.gateAfter(g2, 'reject', 'C', L), /주문 거부 3번/);
  assert.match(SZ.gateCheck(g2, 'Z', L), /정지 중/);
  const g3 = SZ.gate0();
  SZ.gateAfter(g3, 'unsure', 'A', L);
  assert.match(SZ.gateAfter(g3, 'unsure', 'B', L), /접수 확인 실패.*2번/);
});

/* ── ③ 주문 관리(auto-exec) 시나리오: 가짜 엔진 ── */
const Q = (o = {}) => ({ price: 10000, open: 10000, strength: 130, amt: 3e10, upper: 13000, bids: [{ p: 10000, q: 100 }, { p: 9990, q: 900 }], asks: [{ p: 10010, q: 100 }], ...o });
const ROWS = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: 1e9 }));
function execRig({ place, label = '실전', real = true, dry = false, size = null, halt = null, held = async () => new Set() } = {}) {
  const run = { payload: { picks: ['A', 'B', 'C', 'D'].map(c => ({ code: c, name: c + '종목', price: 10000 })), orders: {} } };
  const sent = [], placed = [];
  const broker = { label, real, dry, mode: real ? 'live' : dry ? 'dryrun' : 'paper', held,
    place: async b => { placed.push(b); return place(b, placed.length); }, state: async () => ({ ok: true, orders: [] }) };
  const ex = X.createExec({ broker, getQuote: async () => Q(), loadChart: async () => ROWS, sendTelegram: async t => { sent.push(t); },
    mutateRun: async (d, fn) => fn(run), readRun: async () => run, perStock: async () => 400000, opt: async () => ({ minRr: 0, rejectStop: 3, unsureStop: 2, maxOrdersDay: 20 }),
    ...(size ? { sizeOne: size } : {}), ...(halt ? { halt } : {}), dryLog: async e => { run.dry = (run.dry || []).concat(e); } });
  return { ex, run, sent, placed };
}
test('[연속 거부] KIS 가 3번 거부하면 그날 전략 정지 — 4번째 종목은 주문하지 않음 · 알림 한 번', async () => {
  const x = execRig({ place: () => ({ ok: false, status: 409, error: 'KIS 거부: 주문가능금액을 초과 했습니다' }) });
  const msg = await x.ex.approve('D', { ...x.run.payload, approved: ['A', 'B', 'C', 'D'] });
  assert.equal(x.placed.length, 3, '3번째 거부 뒤로는 주문 안 함');
  assert.equal(x.run.payload.orders.D.st, 'skipped'); assert.match(x.run.payload.orders.D.why, /정지 중 — 주문 거부 3번/);
  assert.equal(x.sent.filter(t => /이상 동작 차단: 주문 거부 3번/.test(t)).length, 1);
  assert.match(msg, /실전 매수/);
  assert.ok(x.run.payload.gate.halted);
});
test('[무응답] KIS 응답 없음(접수 확인 중)이 2번이면 정지 · 그 주문들은 살아 있는 것으로 둠', async () => {
  const x = execRig({ place: (b, n) => ({ ok: true, order: { id: 'L' + n, code: b.code, status: 'unsure', rawStatus: 'unknown', filled: 0 } }) });
  await x.ex.approve('D', { ...x.run.payload, approved: ['A', 'B', 'C'] });
  assert.equal(x.placed.length, 2);
  assert.equal(x.run.payload.orders.A.st, 'open'); assert.equal(x.run.payload.orders.B.st, 'open');
  assert.match(x.run.payload.orders.C.why, /접수 확인 실패.*2번/);
});
test('[중복] 한 주라도 산 종목은 그날 다시 사지 않음(다시 시도 기록이 있어도) · 이미 보유(직접 매매)면 건너뜀', async () => {
  const x = execRig({ place: (b, n) => ({ ok: true, order: { id: 'L' + n, code: b.code, status: 'filled', filled: 10, avg: 9990 } }) });
  await x.ex.approve('D', { ...x.run.payload, approved: ['A'] });
  assert.equal(x.run.payload.gate.bought.A, true);
  x.run.payload.orders.A = { st: 'retry' };   // 어떤 경로로든 다시 승인돼도
  await x.ex.approve('D', { ...x.run.payload, approved: ['A'] });
  assert.equal(x.placed.length, 1, '두 번째는 주문 안 함');
  assert.match(x.run.payload.orders.A.why, /하루 1회/);
  const y = execRig({ place: () => ({ ok: true, order: {} }), held: async () => new Set(['B']) });
  await y.ex.approve('D', { ...y.run.payload, approved: ['B'] });
  assert.equal(y.placed.length, 0); assert.match(y.run.payload.orders.B.why, /이미 보유/);
});
test('[예수금 부족] 주문 가능 금액이 모자라면 KIS 에 보내지 않고 사유 · 확인 실패도 사지 않음', async () => {
  const x = execRig({ place: () => ({ ok: true, order: {} }), size: async () => ({ skip: '주문 가능 금액 부족(50,000원 · 최소 주문 100,000원)' }) });
  await x.ex.approve('D', { ...x.run.payload, approved: ['A'] });
  assert.equal(x.placed.length, 0); assert.match(x.run.payload.orders.A.why, /주문 가능 금액 부족/);
  const y = execRig({ place: () => ({ ok: true, order: {} }), size: async () => { throw new Error('KIS TTTC8908R 500'); } });
  await y.ex.approve('D', { ...y.run.payload, approved: ['A'] });
  assert.equal(y.placed.length, 0); assert.match(y.run.payload.orders.A.why, /주문 가능 금액 확인 실패/);
});
test('[금액] 계산된 금액으로 수량을 정함 — 50만 원이면 지정가 9,990원 × 50주', async () => {
  const x = execRig({ place: (b, n) => ({ ok: true, order: { id: 'L' + n, code: b.code, status: 'open', filled: 0 } }), size: async () => ({ krw: 500000, capBy: '1회 오작동 상한', mode: 'balance', capital: 3e6, weight: 0.2, mult: 1, cash: 3e6 }) });
  await x.ex.approve('D', { ...x.run.payload, approved: ['A'] });
  assert.equal(x.placed[0].qty, 50); assert.equal(x.placed[0].price, 9990);
  assert.ok(x.run.payload.log.some(l => l.k === 'size' && /운용 자금 3,000,000원/.test(l.text)));
});
test('[정지 단계] 신규 매수 정지 중이면 승인해도 주문하지 않음', async () => {
  const x = execRig({ place: () => ({ ok: true, order: {} }), halt: async () => '자동매매 신규 매수 정지 중(/자동재개 로 풀기)' });
  await x.ex.approve('D', { ...x.run.payload, approved: ['A'] });
  assert.equal(x.placed.length, 0); assert.match(x.run.payload.orders.A.why, /신규 매수 정지/);
});
test('[드라이런] 가상으로 주문하면서 "실전이었다면" 기록 · 이상 동작 차단도 똑같이 적용', async () => {
  const x = execRig({ real: false, dry: true, label: '드라이런', place: (b, n) => ({ ok: true, order: { id: 'o' + n, code: b.code, status: 'open', filled: 0 } }), size: async () => ({ krw: 300000, cash: 1200000, mode: 'fixed' }) });
  const msg = await x.ex.approve('D', { ...x.run.payload, approved: ['A'] });
  assert.match(msg, /드라이런 매수/);
  assert.equal(x.run.dry.length, 1); assert.equal(x.run.dry[0].cash, 1200000); assert.equal(x.run.dry[0].paperOrderId, 'o1');
  assert.ok(x.run.payload.log.some(l => l.k === 'dryrun' && /실전이었다면/.test(l.text)));
  assert.equal(x.run.payload.gate.orders, 1);
});
test('[가상] 가상 전략은 차단 기록을 만들지 않음(지금과 같음)', async () => {
  const x = execRig({ real: false, label: '가상', place: (b, n) => ({ ok: false, status: 409, error: 'x' }) });
  await x.ex.approve('D', { ...x.run.payload, approved: ['A', 'B', 'C', 'D'] });
  assert.equal(x.placed.length, 4); assert.equal(x.run.payload.gate, undefined);
});
test('[부분체결] 정정 후에도 다 안 차서 취소되면 산 만큼은 "산 종목"으로 기록(다시 사지 않음)', async () => {
  let t = 1e12;
  const run = { payload: { picks: [{ code: 'A', name: 'A종목' }], orders: { A: { st: 'modified', orderId: 'L2', placedAt: t - 600e3, modifiedAt: t - 600e3, buy: 9990, qty: 50 } } } };
  const broker = { label: '실전', real: true, mode: 'live', state: async () => ({ ok: true, orders: [{ id: 'L2', code: 'A', side: 'buy', status: 'partial', price: 9990, qty: 50, filled: 20, avg: 9990 }] }),
    cancel: async () => ({ ok: true }) };
  const ex = X.createExec({ broker, getQuote: async () => Q(), loadChart: async () => ROWS, sendTelegram: async () => {}, now: () => t,
    mutateRun: async (d, fn) => fn(run), readRun: async () => run, opt: async () => ({ fillWaitMs: 60e3, cancelWaitMs: 60e3 }) });
  await ex.follow('D');
  assert.equal(run.payload.orders.A.st, 'partial_done'); assert.equal(run.payload.orders.A.filled, 20);
  assert.equal(run.payload.gate.bought.A, true);
});

/* ── ④ 실전 엔진: 자동매매 수량만 매도 · 손절 집행 감시 (가짜 KIS) ── */
const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const PLAN = { stopPct: 2, steps: [{ n: 1, p: 10200, q: 2 }, { n: 2, p: 10300, q: 3 }] };   // 매수 10010 → 손절 9800
function move(c, price, extra = {}) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += 1000;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price); Object.assign(st, extra);
}
async function liveRig() {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: REAL, kx });
  const BR = createBroker({ paper: c.t.paper, live: c.t.live, modeOf: () => 'live', kinds: () => ['live'] });
  const tick = async (price, extra) => { move(c, price, extra); await c.t.live.tick(); };
  return { db, kx, c, BR, b: BR.of('intraday-x'), tick };
}
test('[자동매매 수량만] 자동매매가 5주 산 종목을 직접 10주 더 사도 — 손절은 5주만, 다 팔면 계획 끝, 직접 산 10주는 그대로', async () => {
  const x = await liveRig();
  const r = await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest10001' });
  assert.equal(r.ok, true, JSON.stringify(r));
  x.kx.fill([...x.kx.orders.values()][0].odno, 5, 10010);
  await x.tick(10000); await x.tick(10000);
  assert.equal(x.db.t.live_plans.get('005930').plan.own, 5, '자동매매 몫 5주');
  const h = x.kx.hold.get('005930'); h.avg = (h.avg * h.qty + 10000 * 10) / (h.qty + 10); h.qty += 10;   // 사용자가 HTS 로 직접 10주 더 삼
  x.c.st.clock += 31000; await x.tick(10000);   // 잔고는 30초마다 다시 읽음
  const S = await x.b.state(), p = S.positions.find(q => q.code === '005930');
  assert.equal(p.qty, 5, '자동매매 보기에는 5주'); assert.equal(p.qtyAll, 15, '계좌 전체는 15주');
  await x.tick(9700); await x.tick(9700);
  const stops = x.kx.posts.filter(q => q.tr === 'TTTC0011U');
  assert.equal(stops.length, 1); assert.equal(stops[0].body.ORD_QTY, '5', '손절은 자동매매 몫 5주만');
  await x.tick(9700); await x.tick(9700);
  assert.equal(x.kx.hold.get('005930').qty, 10, '직접 산 10주는 남음');
  assert.equal(x.db.t.live_plans.has('005930'), false, '자동매매 몫을 다 팔아 계획 끝');
  await x.tick(9500); await x.tick(9500);
  assert.equal(x.kx.posts.filter(q => q.tr === 'TTTC0011U').length, 1, '그 뒤로 더 팔지 않음');
  await x.c.close();
});
test('[자동매매 수량만] 계획을 고쳐도(이월 전환 등) 자동매매 몫은 유지', async () => {
  const x = await liveRig();
  await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest10002' });
  x.kx.fill([...x.kx.orders.values()][0].odno, 5, 10010);
  await x.tick(10000); await x.tick(10000);
  const e = await x.b.editPlan({ code: '005930', stopPct: 5, steps: [], ratchet: null });
  assert.equal(e.ok, true);
  assert.equal(x.db.t.live_plans.get('005930').plan.own, 5);
  await x.c.close();
});
test('[직접 주문] 사람이 낸 실전 매수(출처 없음)는 자동매매 몫을 만들지 않음 — 예전처럼 계좌 전체가 계획 대상', async () => {
  const x = await liveRig();
  await x.c.login();
  const r = await x.c.call('POST', '/trade/live/order', { body: { code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 5, plan: PLAN } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await x.tick(10000); await x.tick(10000);
  assert.equal(x.db.t.live_plans.get('005930').plan.own, undefined);
  await x.c.close();
});
test('[손절 집행 감시] 손절 조건이 됐는데 20초 안에 매도가 접수되지 않으면(VI 대기) 긴급 알림 — 한 번만', async () => {
  const x = await liveRig();
  await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest10003' });
  x.kx.fill([...x.kx.orders.values()][0].odno, 5, 10010);
  await x.tick(10000); await x.tick(10000);
  for (let i = 0; i < 6; i++) await x.tick(9700, { vi: true });                    // 5초씩 30초 — VI 라 손절 주문이 못 나감
  const al = x.c.st.alerts.filter(t => /손절 조건 \d+초째/.test(t));
  assert.equal(al.length, 1, x.c.st.alerts.join(' | '));
  assert.match(al[0], /한국투자증권 앱에서 직접/);
  await x.c.close();
});
test('[손절 집행 감시] 손절 주문이 바로 접수되면 알림 없음', async () => {
  const x = await liveRig();
  await x.b.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10010, qty: 5, plan: PLAN, cid: 'autotest10004' });
  x.kx.fill([...x.kx.orders.values()][0].odno, 5, 10010);
  await x.tick(10000); await x.tick(10000);
  for (let i = 0; i < 6; i++) await x.tick(9700);
  assert.equal(x.c.st.alerts.filter(t => /손절 조건 \d+초째/.test(t)).length, 0);
  await x.c.close();
});
test('broker: 실전 보기는 자동매매 몫만큼 · 드라이런은 가상으로 주문하면서 보유·금액은 실제 계좌로', async () => {
  assert.deepEqual(ownView({ code: 'A', qty: 15, avail: 15, plan: { own: 5 } }), { code: 'A', qty: 5, avail: 5, qtyAll: 15, plan: { own: 5 } });
  assert.deepEqual(ownView({ code: 'A', qty: 15, avail: 12, plan: {} }), { code: 'A', qty: 15, avail: 12, plan: {} });
  const placed = [];
  const BR = createBroker({ paper: { place: async b => { placed.push(['paper', b]); return { ok: true, order: { id: 'o1' } }; }, heldCodes: () => new Set(['A']) },
    live: { place: async b => { placed.push(['live', b]); return { ok: true, order: {} }; }, heldCodes: () => new Set(['B']), state: async () => ({ ok: true, account: true }), buyable: async () => ({ cash: 777000 }) },
    modeOf: () => 'dryrun' });
  const b = BR.of('s');
  assert.equal(b.mode, 'dryrun'); assert.equal(b.kind, 'paper'); assert.equal(b.real, false); assert.equal(b.dry, true); assert.equal(b.label, '드라이런');
  await b.place({ code: 'C', side: 'buy' });
  assert.deepEqual(placed.map(p => p[0]), ['paper']);
  assert.deepEqual([...(await b.held())].sort(), ['A', 'B'], '직접 산 실제 계좌 종목도 피함');
  assert.equal(await b.cash('C', 10000), 777000);
  assert.equal(await BR.of('s').cash('C', 1) , 777000);
  const P = createBroker({ paper: { heldCodes: () => new Set() } }).of('p');
  assert.equal(await P.cash('C', 1), null, '가상은 금액 조회 없음');
});

/* ── ⑤ 자동매매(auto.js): 모드 전환 규칙 · 실전용 복제 · 정지 단계 ── */
function stratDb(rows) {
  const db = { auto_strategies: rows.map(r => ({ ...r })), versions: [], runs: {}, cfg: {}, carry: { items: {} } };
  return {
    db,
    sbGet: async p => {
      if (p.startsWith('auto_strategies')) return JSON.parse(JSON.stringify(db.auto_strategies));
      if (p.startsWith('auto_strategy_versions')) return db.versions.slice().reverse();
      if (p.startsWith('auto_runs')) { const d = (p.match(/trade_date=eq\.([\d-]+)/) || [])[1], s = (p.match(/strategy_id=eq\.([\w-]+)/) || [])[1]; return Object.values(db.runs).filter(r => (!d || r.trade_date === d) && (!s || r.strategy_id === s)).map(r => JSON.parse(JSON.stringify(r))); }
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; if (k === 'carry') return [{ key: 'carry', value: db.carry }]; return db.cfg[k] ? [{ key: k, value: db.cfg[k] }] : []; }
      return [];
    },
    sbWrite: async (p, m, b) => {
      if (p.startsWith('auto_strategies')) b.forEach(x => { const i = db.auto_strategies.findIndex(r => r.id === x.id); if (i >= 0) db.auto_strategies[i] = { ...db.auto_strategies[i], ...x }; else db.auto_strategies.push({ ...x }); });
      else if (p.startsWith('auto_strategy_versions')) db.versions.push(...b);
      else if (p.startsWith('auto_runs')) b.forEach(x => { db.runs[`${x.trade_date}|${x.strategy_id}`] = JSON.parse(JSON.stringify(x)); });
      else if (p.startsWith('auto_config')) b.forEach(x => { if (x.key === 'carry') db.carry = x.value; else db.cfg[x.key] = x.value; });
    },
  };
}
const srow = (id, kind, params = {}) => ({ id, name: id, kind, enabled: id === 'intraday-default' || kind === 'closing', builtin: id.endsWith('default'), version: 1, params: { ...S.defaults(kind), ...params } });
function autoRig({ liveReady = { ok: true }, paperState } = {}) {
  const f = stratDb([srow('intraday-default', 'intraday'), srow('closing-default', 'closing')]);
  const store = S.createStore(f);
  const sent = [];
  const auto = A.createAuto({ strategies: store, sbGet: f.sbGet, sbWrite: f.sbWrite, sendTelegram: async t => sent.push(t), kstNow: () => ({ date: '2026-11-18', min: 16 * 60 }),
    isTradingDay: () => true, paper: { heldCodes: () => new Set(), state: async () => (paperState || { ok: true, positions: [], orders: [], fills: [] }) }, live: { heldCodes: () => new Set(), state: async () => ({ ok: true, account: true, positions: [], orders: [], fills: [] }) },
    liveReady: () => liveReady });
  return { f, store, auto, sent };
}
test('[모드 전환] 실전으로 바꾸려면 PIN 재확인 필요 · 실전 엔진이 준비 안 됐으면 거부 · 가상 탭 전략은 쪽 이동 불가 · 드라이런→실전은 PIN', async () => {
  const x = autoRig();
  const r1 = await x.auto.saveStrategy('intraday-default', { params: { execMode: 'live' } }, 'site', { confirm: true });
  assert.equal(r1.ok, false); assert.equal(r1.needPin, true);
  const y = autoRig({ liveReady: { ok: false, why: '실전 스위치(REAL_TRADING_ENABLED)가 꺼져 있습니다' } });
  const r2 = await y.auto.saveStrategy('intraday-default', { params: { execMode: 'live' } }, 'site', { confirm: true, pinOk: true });
  assert.equal(r2.ok, false); assert.match(r2.error, /실전 스위치/);
  const r3 = await x.auto.saveStrategy('intraday-default', { params: { execMode: 'dryrun' } }, 'site', { confirm: true });
  assert.equal(r3.ok, false, '가상 탭 전략은 쪽을 옮기지 않음(2026-11-19) — 「실전에 적용」으로 복제'); assert.equal(r3.status, 409);
  const c = await x.auto.createStrategy({ from: 'intraday-default', asLive: true }, 'site');
  assert.equal(c.ok, true); assert.equal(x.auto.modeOf(c.strategy.id), 'dryrun');
  const r4 = await x.auto.saveStrategy(c.strategy.id, { params: { execMode: 'live' } }, 'site', { confirm: true, pinOk: true });
  assert.equal(r4.ok, true, JSON.stringify(r4)); assert.equal(x.auto.modeOf(c.strategy.id), 'live');
  const r5 = await x.auto.saveStrategy(c.strategy.id, { params: { execMode: 'live', stopPct: 4 } }, 'site', { confirm: true });
  assert.equal(r5.ok, true, '모드가 그대로면 다른 조건은 PIN 없이 저장');
});
test('[모드 전환] 체결 대기 주문·오늘 산 종목 보유·안 판 이월이 있으면 못 바꿈', async () => {
  const x = autoRig();
  x.f.db.runs['2026-11-18|intraday-default'] = { trade_date: '2026-11-18', strategy_id: 'intraday-default', status: 'approved', payload: { orders: { A: { st: 'open', orderId: 'o1' } } } };
  assert.match((await x.auto.saveStrategy('intraday-default', { params: { execMode: 'dryrun' } }, 'site', { confirm: true })).error, /체결 대기 중인 주문/);
  x.f.db.runs['2026-11-18|intraday-default'].payload.orders.A = { st: 'filled', filled: 10 };
  const y = autoRig({ paperState: { ok: true, positions: [{ code: 'A', qty: 10, avg: 1 }], orders: [], fills: [] } });
  y.f.db.runs = x.f.db.runs;
  assert.match((await y.auto.saveStrategy('intraday-default', { params: { execMode: 'dryrun' } }, 'site', { confirm: true })).error, /오늘 산 종목을 아직 보유/);
  const z = autoRig();
  z.f.db.carry = { items: { B: { code: 'B', sid: 'intraday-default', state: 'wait', from: '2026-11-17' } } };
  assert.match((await z.auto.saveStrategy('intraday-default', { params: { execMode: 'dryrun' } }, 'site', { confirm: true })).error, /이월 종목/);
});
test('[실전용 복제] 드라이런·직접 승인으로 만들어짐(이름에 실전) · 실전 원본을 그냥 복제해도 실전으로 시작하지 않음', async () => {
  const x = autoRig();
  const r = await x.auto.createStrategy({ from: 'intraday-default', asLive: true }, 'site');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.strategy.params.execMode, 'dryrun'); assert.equal(r.strategy.params.liveAutoOk, false); assert.match(r.strategy.name, /\(실전\)/);
  assert.equal(r.strategy.enabled, false);
  await x.auto.saveStrategy(r.strategy.id, { params: { execMode: 'live' } }, 'site', { confirm: true, pinOk: true });
  const c2 = await x.auto.createStrategy({ from: r.strategy.id }, 'site');
  assert.equal(c2.strategy.params.execMode, 'dryrun', '실전 원본의 복사본은 드라이런');
});
test('[정지 단계] 자동매매 전체 정지면 tick 이 매매 일을 하지 않음 · 해제하면 다시', async () => {
  const x = autoRig();
  await x.auto.setHalt('all', 'test');
  assert.equal(await x.auto.haltLevel(), 'all');
  const t = await x.auto.tick();
  assert.ok(t.idle === 'halted' || t.idle === 'outside-window', JSON.stringify(t));
  await x.auto.setHalt(null, 'test');
  assert.equal(await x.auto.haltLevel(), null);
  assert.equal(x.f.db.cfg.halt.level, null);
});
