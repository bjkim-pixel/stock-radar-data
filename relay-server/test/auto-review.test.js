'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RV = require('../auto-review');
const J = require('../auto-journal');

const T0 = Date.parse('2026-11-16T10:20:00+09:00');
const P = () => ({
  stat: { pool: 100, base: 30, flowPass: 5 }, roundN: 3,
  noticeAt: '2026-11-16T01:15:00Z', decision: { kind: 'buy', nums: [1], at: '2026-11-16T01:25:00Z' },
  picks: [{ code: 'A', name: '가', price: 10000, score: 80, round: 1 }, { code: 'B', name: '나', price: 20000, score: 70, round: 1 }, { code: 'C', name: '다', price: 5000, score: 60, round: 2 }, { code: 'D', name: '라', price: 3000, score: 55, round: 2, closed: false }],
  orders: {
    A: { st: 'filled', filled: 10, avg: 10020, buy: 10020, qty: 10, placedAt: T0, filledAt: T0 + 3 * 60e3, plan: { stop: 9500, stopPct: 5, steps: [{ n: 1, p: 10500, q: 5 }] } },
    C: { st: 'cancelled', buy: 4950, qty: 20 },
    D: { st: 'skipped', why: '체결강도 90% < 100%' },
  },
  log: [{ t: 'x', k: 'order', text: 't' }],
});

test('사지 못한 후보: 사유 분류와 선정가 대비 종가·고점·주문가 도달', () => {
  const nb = RV.notBoughtOf(P(), { B: 21000, C: 5100, D: 2800 }, { C: { high: 5300, low: 4900 }, D: { high: 3000, low: 2700 } });
  assert.deepEqual(nb.map(n => `${n.code}:${n.kind}`), ['B:unpicked', 'C:unfilled', 'D:recheck']);   // A 는 샀으니 빠짐
  const B = nb[0], C = nb[1];
  assert.equal(B.closePct, 5); assert.equal(B.highPct, null);
  assert.equal(C.closePct, 2); assert.equal(C.highPct, 6); assert.equal(C.reached, true);          // 저점 4900 ≤ 주문가 4950
  assert.equal(nb[2].closePct, -6.67);
});
test('사지 못한 후보: 승인 전·패스·만료·이전 회차', () => {
  const p = P(); p.orders = {}; p.decision = null;
  assert.ok(RV.notBoughtOf(p).every(n => n.kind === 'expired'));
  p.decision = { kind: 'pass' }; assert.ok(RV.notBoughtOf(p).every(n => n.kind === 'pass'));
  p.picks[0].closed = true; p.decision = { kind: 'buy', nums: [1, 2, 3, 4] };
  assert.equal(RV.notBoughtOf(p)[0].kind, 'closed');
});
test('복기 데이터: 화면을 다시 그릴 수 있게 후보·주문·기록을 담는다', () => {
  const r = RV.replayOf(P());
  assert.equal(r.picks.length, 4); assert.equal(r.orders.find(o => o.code === 'A').plan.stop, 9500);
  assert.equal(r.rounds.n, 3); assert.equal(r.log.length, 1);
});
test('복기 문장: 손절·익절 도달 여부, 놓친 상승, 안 사서 다행, 미체결', () => {
  const p = P(), pos = [{ code: 'A', name: '가', qty: 10, buyAvg: 10020, held: 0, state: 'closed', pnl: -5000, pct: -5, mfe: 5.5, mae: -5.2, exSrc: 'live', px0: null }];
  const sells = [{ code: 'A', why: '손절', price: 9500, qty: 10 }];
  const nb = RV.notBoughtOf(p, { B: 21000, C: 5100, D: 2800 }, { C: { high: 5300, low: 4900 }, D: { high: 3000, low: 2700 } });
  const L = RV.reviewOf({ P: p, positions: pos, sells, notBought: nb, totals: { n: 1, wins: 0, losses: 1, net: -5000, pct: -5 }, shadow: { all: 1, picked: 2, bought: -5 }, funnel: { pool: 100, base: 30, flowPass: 5, picks: 4 }, params: { maxBuys: 5 } });
  const T = L.map(x => x.text).join('\n');
  assert.match(T, /장중 3회 검토, 새 후보 2종목/);
  assert.match(T, /알림 10분 뒤/);
  assert.match(T, /3분 만에 체결/); assert.match(T, /손절 −5%/);
  assert.match(T, /1차 익절선\(\+4\.8%\)까지 갔다가 손절/);                  // 익절선 > 최고 → 문구
  assert.match(T, /선정가보다 종가가 3% 이상 높았어요: 나 \+5\.0%/);
  assert.match(T, /안 사길 잘했어요: 라 −6\.7%/);
  assert.match(T, /일중 저점이 주문가에 닿았는데 체결되지 않았어요/);
  assert.match(T, /그림자 비교/); assert.match(T, /하루 최대 5종목 중 1종목/);
  assert.equal(L.find(x => x.k === 'trade').tone, 'bad');
});
test('일지에 복기·사지 못한 종목·복기 문장이 들어간다(buildIntraday)', () => {
  const run = { trade_date: '2026-11-16', strategy_id: 'intraday-default', status: 'approved', payload: P() };
  const j = J.buildIntraday({ date: '2026-11-16', run, fills: [], closes: { B: 21000 }, today: '2026-11-17', daily: {} });
  assert.equal(j.v, 2); assert.equal(j.notBought.find(n => n.code === 'B').closePct, 5);
  assert.ok(j.review.some(x => x.k === 'missed')); assert.equal(j.replay.orders.length, 3);
});
