'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeReport, roundTrips, sourceOf } = require('../paper-report');
const { fakeDb, boot } = require('./paper-harness');

const T = s => Date.parse(s + '+09:00');
const f = (id, ts, code, side, price, qty, realized, reason = 'manual', orderId = id) => ({ id, ts: T(ts), orderId, code, side, price, qty, amount: price * qty, fee: 0, realized, reason });

test('한 번의 매매(0→0) 묶기 · 손절 종료 표시', () => {
  const fl = [f('a', '2027-01-04T10:00:00', 'A', 'buy', 100, 10, null), f('b', '2027-01-05T10:00:00', 'A', 'sell', 110, 4, 40, 'tp1'),
    f('c', '2027-01-06T10:00:00', 'A', 'sell', 90, 6, -60, 'stop'), f('d', '2027-01-06T11:00:00', 'A', 'buy', 95, 5, null)];
  const t = roundTrips(fl);
  assert.equal(t.length, 1); assert.equal(t[0].realized, -20); assert.equal(t[0].endedBy, 'stop');
  assert.equal(Math.round((t[0].closeTs - t[0].openTs) / 86400e3), 2);
});

test('기간 요약·통계·종목별·월별·코스피', () => {
  const fills = [
    f('1', '2026-12-10T10:00:00', 'A', 'buy', 100, 10, null), f('2', '2026-12-11T10:00:00', 'A', 'sell', 120, 10, 200),
    f('3', '2027-01-04T10:00:00', 'B', 'buy', 200, 10, null), f('4', '2027-01-05T10:00:00', 'B', 'sell', 190, 10, -100, 'stop'),
    f('5', '2027-01-06T10:00:00', 'C', 'buy', 50, 20, null), f('6', '2027-01-07T10:00:00', 'C', 'sell', 60, 20, 200, 'tp1'),
    f('7', '2027-01-08T10:00:00', 'D', 'buy', 1000, 2, null),
  ];
  const r = computeReport({ fills, orders: [], positions: [{ code: 'D', name: '디', qty: 2, avg: 1000, last: 1100 }],
    kospi: [{ trade_date: '2026-12-31', index_close: 2500 }, { trade_date: '2027-01-08', index_close: 2550 }], from: '2027-01-01', to: '2027-01-31' });
  assert.equal(r.summary.realized, 100); assert.equal(r.summary.unrealized, 200); assert.equal(r.summary.total, 300);
  assert.equal(r.summary.retPct, Math.round(100 / (2000 + 1000) * 10000) / 100);   // 매도 원가 = 금액 - 실현손익
  assert.equal(r.summary.kospiPct, 2);
  assert.equal(r.stats.trades, 2); assert.equal(r.stats.winRate, 50); assert.equal(r.stats.payoff, 2); assert.equal(r.stats.stopRate, 50);
  assert.deepEqual(r.codes.map(c => c.code), ['C', 'D', 'B']);
  assert.deepEqual(r.monthly, [{ month: '2026-12', realized: 200, cum: 200 }, { month: '2027-01', realized: 100, cum: 300 }]);
});

test('슬리피지(시장가·손절 기준가 대비)·지정가 체결률', () => {
  const orders = [
    { id: 'm', createdAt: T('2027-01-04T10:00:00'), code: 'A', side: 'buy', type: 'market', qty: 10, filled: 10, status: 'filled', reason: 'manual', refPrice: 100 },
    { id: 's', createdAt: T('2027-01-05T10:00:00'), code: 'A', side: 'sell', type: 'market', qty: 10, filled: 10, status: 'filled', reason: 'stop', refPrice: 95 },
    { id: 'l', createdAt: T('2027-01-05T09:00:00'), code: 'B', side: 'buy', type: 'limit', price: 50, qty: 10, filled: 5, status: 'cancelled', reason: 'manual', refPrice: 50 },
  ];
  const fills = [f('1', '2027-01-04T10:00:00', 'A', 'buy', 101, 10, null, 'manual', 'm'), f('2', '2027-01-05T10:00:00', 'A', 'sell', 94, 10, -70, 'stop', 's'),
    f('3', '2027-01-05T09:30:00', 'B', 'buy', 50, 5, null, 'manual', 'l')];
  const r = computeReport({ fills, orders, from: '2027-01-01', to: '2027-01-31' });
  const by = Object.fromEntries(r.slippage.rows.map(x => [x.kind, x]));
  assert.equal(by['시장가 매수'].avgPct, 1); assert.equal(by['시장가 매수'].krw, 10);
  assert.equal(by['손절(시장가)'].avgPct, Math.round(1 / 95 * 10000) / 100);
  assert.equal(r.slippage.limitFillRate, 50); assert.equal(r.slippage.limitDelayMin, 30);
});

test('주문 출처 표시', () => {
  assert.equal(sourceOf({ reason: 'manual' }), '직접 주문');
  assert.equal(sourceOf({ reason: 'stop' }), '자동 손절');
  assert.equal(sourceOf({ reason: 'tp2' }), '자동 익절 2단계');
  assert.equal(sourceOf({ reason: 'tp1', note: 'reopen' }), '장 시작 재접수(익절 1단계)');
});

test('API: 가상 운영 후 리포트(손절 슬리피지 기준=손절가 · 트레일링 익절 표시)', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const mv = (price, vol = 1000) => { const st = c.st; st.clock += 5000; st.price = price; st.vol += vol; st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]); st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]); st.low = Math.min(st.low, price); st.high = Math.max(st.high, price); };
  await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: { stopPct: 2, steps: [{ n: 1, p: 10200, q: 5 }, { n: 2, p: 10400, q: 5 }] } });
  mv(10000); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-13T15:31:00+09:00'); await c.t.paper.tick();
  c.st.clock = Date.parse('2027-01-14T09:00:05+09:00') - 5000; mv(10050); await c.t.paper.tick();
  mv(10250); await c.t.paper.tick();            // 1단계 감시
  mv(10040); await c.t.paper.tick();            // 10250×0.98 아래 → 1단계 트레일링 익절
  mv(9790); await c.t.paper.tick();              // 손절(9800)
  await c.login();   // 하루가 지나 거래 세션(15분)이 만료됨
  const r = await c.call('GET', '/trade/paper/report?from=2027-01-01&to=2027-01-31');
  assert.equal(r.status, 200);
  assert.equal(r.body.stats.trades, 1); assert.equal(r.body.stats.stopRate, 100);
  assert.ok(r.body.orders.some(o => /트레일링 익절 1단계/.test(o.source)));
  assert.ok(r.body.orders.some(o => o.source === '자동 손절'));
  const stop = r.body.slippage.rows.find(x => x.kind === '손절(시장가)');
  assert.ok(stop && stop.orders === 1 && stop.avgPct > 0, JSON.stringify(r.body.slippage));   // 9790 기준 매수호가로 팔아 손절가 9800 보다 불리
  assert.equal((await c.call('GET', '/trade/paper/report?from=2027-1-1')).status, 400);
  await c.close();
});
