'use strict';
/* 자동매매 보강 E2: 총 노출·상한 · 이벤트 표시 · MFE/MAE 기록 */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../auto-risk'), E = require('../auto-events'), X = require('../auto-excursion'), J = require('../auto-journal');

const ps = () => ({
  ok: true,
  positions: [
    { code: 'A', name: '가나', qty: 100, avg: 10000, last: 10500, stop: 9500 },    // 평가 105만 · 손절 시 −5만
    { code: 'B', name: '다라', qty: 50, avg: 20000, last: 19000, stop: 19000 },    // 평가 95만 · 손절 시 −5만
    { code: 'C', name: '마바', qty: 10, avg: 30000, last: 33000, stop: 31000 },    // 트레일링으로 손절선이 매수가 위 → 손실 0
    { code: 'M', name: '직접', qty: 10, avg: 1000, last: 1000, stop: null },      // 자동매매 아님
  ],
  orders: [{ id: 'o1', code: 'D', side: 'buy', status: 'open', price: 5000, qty: 100, filled: 40 }, { id: 'o2', code: 'A', side: 'sell', status: 'open', price: 11000, qty: 50, filled: 0 }],
});

test('총 노출: 자동매매 종목만 · 미체결 매수 포함 · 손절 시 손실은 매수가 기준(이익은 안 셈)', () => {
  const e = R.exposureOf(ps(), new Set(['A', 'B', 'C', 'D']));
  assert.equal(e.n, 3);
  assert.equal(e.value, 1050000 + 950000 + 330000);
  assert.equal(e.pending, 60 * 5000);                // 매도 주문은 제외, 매수 미체결 60주
  assert.equal(e.total, e.value + e.pending);
  assert.equal(e.lossAtStop, 50000 + 50000 + 0);
  assert.equal(e.lossFromNow, 100 * 1000 + 0 + 10 * 2000);
  assert.equal(R.exposureOf(ps(), null).n, 4);
  assert.equal(R.exposureOf(ps(), null).noStop, 1);
});
test('총액 상한: 0=없음 · 넘으면 막고 사유를 돌려줌', () => {
  const e = { total: 2000000 };
  assert.equal(R.capCheck(0, e, 1e9).ok, true);
  assert.equal(R.capCheck(3000000, e, 1000000).ok, true);
  const r = R.capCheck(2500000, e, 1000000);
  assert.equal(r.ok, false); assert.match(r.why, /총액 상한 2,500,000원 초과/);
  assert.match(R.exposureLine({ n: 3, total: 2330000, pending: 0, lossAtStop: 100000 }, 5000000), /총 노출 2,330,000원\(3종목\).*−100,000원.*상한 5,000,000원\(47%\)/);
  assert.equal(R.exposureLine({ n: 0, pending: 0 }), null);
});
test('총액 상한: 승인 단계에서 상한을 넘기는 종목만 사지 않고 기록한다', async () => {
  const Ex = require('../auto-exec');
  const run = { payload: { picks: [{ code: '005930', name: '삼성전자', price: 70000 }], approved: ['005930'] } };
  let placed = 0;
  const ex = Ex.createExec({ paper: { heldCodes: () => [], place: async () => { placed++; return { ok: false }; } }, getQuote: async () => ({ price: 70000, bids: [] }), loadChart: async () => [],
    sendTelegram: async () => {}, mutateRun: async (d, fn) => fn(run), readRun: async () => run, perStock: async () => 1e6, opt: async () => ({ totalCapKrw: 3e6 }), exposure: async () => ({ total: 2.5e6 }) });
  const msg = await ex.approve('D', run.payload);
  assert.match(msg, /매수 안 함 — 총액 상한/); assert.equal(placed, 0);
  assert.equal(run.payload.orders['005930'].st, 'skipped'); assert.match(run.payload.orders['005930'].why, /총액 상한/);
});

const EVS = [
  { event_date: '2026-11-16', kind: 'earnings', code: 'A', name: '가나', title: '영업(잠정)실적', detail: 'u' },
  { event_date: '2026-11-15', kind: 'ir', code: 'B', name: '다라', title: '기업설명회(IR)개최' },
  { event_date: '2026-11-10', kind: 'earnings', code: 'C', title: '영업(잠정)실적' },
  { event_date: '2026-11-17', kind: 'expiry', code: null, title: '옵션 만기일' },
  { event_date: '2026-12-10', kind: 'expiry', code: null, title: '선물·옵션 동시만기일(쿼드러플 위칭)' },
];
test('이벤트: 종목 배지는 오늘·어제 공시만, 시장 일정은 지정 기간만', () => {
  assert.deepEqual(E.stockBadges(EVS, 'A', '2026-11-16'), ['실적 공시(오늘)']);
  assert.deepEqual(E.stockBadges(EVS, 'B', '2026-11-16'), ['IR 공시(어제)']);
  assert.deepEqual(E.stockBadges(EVS, 'C', '2026-11-16'), []);
  const n = E.marketNotes(EVS, '2026-11-16', 1);
  assert.equal(n.length, 1); assert.equal(n[0].text, '내일 옵션 만기일');
  assert.match(E.marketLine(n), /^📅 내일 옵션 만기일/);
  assert.equal(E.marketLine([]), null);
  assert.equal(E.upcoming(EVS, '2026-11-16', 7).length, 1);
});
test('이벤트: 테이블이 없거나 읽기 실패면 빈 목록', async () => {
  assert.deepEqual(await E.loadEvents(async () => { throw new Error('relation does not exist'); }, '2026-11-16'), []);
  let url; await E.loadEvents(async u => { url = u; return []; }, '2026-11-16', 3, 8);
  assert.match(url, /event_date=gte\.2026-11-13/); assert.match(url, /event_date=lte\.2026-11-24/);
});

test('MFE/MAE 기록: 훑을 때마다 최고·최저 갱신, 팔면 완료 기록으로 이동, 매수한 날은 당일 고저 무시', () => {
  const st = X.fresh(), watch = new Set(['A']);
  const pos = (last, extra = {}) => [{ code: 'A', qty: 10, avg: 10000, last, ...extra }];
  X.update(st, pos(10000, { dayHigh: 12000, dayLow: 9000 }), watch, '2026-11-16');   // 매수한 날: dayHigh/dayLow 는 매수 전 시간대가 섞여 무시
  X.update(st, pos(10400), watch, '2026-11-16');
  X.update(st, pos(9700), watch, '2026-11-16');
  assert.deepEqual([st.pos.A.hi, st.pos.A.lo], [10400, 9700]);
  X.update(st, pos(10100, { dayHigh: 10900, dayLow: 9500 }), watch, '2026-11-17');   // 다음 날: 당일 고저 반영
  assert.deepEqual([st.pos.A.hi, st.pos.A.lo], [10900, 9500]);
  assert.equal(X.find(st, 'A', '2026-11-16').open, true);
  const r = X.update(st, [], watch, '2026-11-17');                                    // 다 팔림
  assert.equal(r.changed, true); assert.equal(st.pos.A, undefined);
  assert.deepEqual(st.done[0], { code: 'A', since: '2026-11-16', to: '2026-11-17', avg: 10000, hi: 10900, lo: 9500 });
  const ex = X.excursionFor(st, {}, 'A', '2026-11-16', 10000);
  assert.deepEqual(ex, { mfe: 9, mae: -5, src: 'live' });
  const ap = X.excursionFor(X.fresh(), { B: { high: 21000, low: 19000 } }, 'B', '2026-11-16', 20000);   // 기록 없으면 일봉 근사
  assert.deepEqual(ap, { mfe: 5, mae: -5, src: 'daily' });
  assert.equal(X.excursionFor(X.fresh(), {}, 'Z', '2026-11-16', 100), null);
  assert.equal(X.update(X.fresh(), [{ code: 'M', qty: 1, avg: 100, last: 100 }], watch, '2026-11-16').store.pos.M, undefined);   // 자동매매 종목만
});
test('MFE/MAE: 일지 종목 줄에 기록(live)·근사(daily)로 표시', () => {
  const run = { trade_date: '2026-11-16', strategy_id: 'intraday-default', status: 'approved', payload: { strategy: { id: 'intraday-default', version: 1, name: 'x' }, picks: [{ code: 'A', name: '가나' }], approved: ['A'],
    orders: { A: { st: 'filled', orderId: 'oA', filled: 100, avg: 10000 } }, shadow: [] } };
  const fills = [{ id: 'f1', ts: Date.parse('2026-11-16T10:06:00+09:00'), orderId: 'oA', code: 'A', side: 'buy', price: 10000, qty: 100, amount: 1e6, fee: 0, realized: null }];
  const st = { pos: { A: { avg: 10000, since: '2026-11-16', hi: 10600, lo: 9800, n: 5 } }, done: [] };
  const live = J.buildIntraday({ date: '2026-11-16', run, fills, marks: { A: 10100 }, today: '2026-11-16', exc: st, daily: {} });
  assert.deepEqual([live.positions[0].mfe, live.positions[0].mae, live.positions[0].exSrc], [6, -2, 'live']);
  const ap = J.buildIntraday({ date: '2026-11-16', run, fills, closes: { A: 10100 }, today: '2026-11-17', exc: X.fresh(), daily: { A: { high: 10900, low: 9700 } } });
  assert.deepEqual([ap.positions[0].mfe, ap.positions[0].mae, ap.positions[0].exSrc], [9, -3, 'daily']);
});
