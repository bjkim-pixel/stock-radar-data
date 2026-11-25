'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const X = require('../auto-exec'), S = require('../auto-strategy');

test('fixedPlan: +6%·+9% 두 단계, 50/50', () => {
  const r = X.fixedPlan(10000, 100, { tp1Pct: 6, tp2Pct: 9, tp1Share: 50 });
  assert.deepEqual(r.steps, [{ n: 1, p: 10600, q: 50 }, { n: 2, p: 10900, q: 50 }]);
  assert.equal(r.target, 10900);
});
test('fixedPlan: 1주면 한 단계, 호가 단위 올림, 수량 합 보존', () => {
  assert.equal(X.fixedPlan(10000, 1, {}).steps.length, 1);
  const r = X.fixedPlan(53300, 18, { tp1Pct: 6, tp2Pct: 9, tp1Share: 50 });
  assert.equal(r.steps.reduce((a, x) => a + x.q, 0), 18);
  assert.ok(r.steps[0].p >= 53300 * 1.06 && r.steps[1].p >= 53300 * 1.09);
});
test('makeOrder: fixed 방식은 매물대와 무관하게 6/9% 단계 + 손절 −3%', () => {
  const q = { price: 20000, open: 19500, bids: [{ p: 19950, q: 100 }], amt: 5e9 };
  const o = X.makeOrder({ q, rows: [], perStockKrw: 1000000, opt: { tpStyle: 'fixed', stopPct: 3, tp1Pct: 6, tp2Pct: 9, tp1Share: 50, ratchet: true } });
  assert.ok(!o.skip);
  assert.equal(o.plan.steps.length, 2);
  assert.ok(Math.abs(o.plan.steps[0].p / o.buy - 1.06) < 0.01 && Math.abs(o.plan.steps[1].p / o.buy - 1.09) < 0.01);
  assert.equal(o.plan.target, o.plan.steps[1].p);
  assert.equal(o.plan.stop, X.floorTick(o.buy * 0.97));
});
test('시동 기본 전략은 fixed 6/9, tp2<=tp1 은 거부', () => {
  const b = S.BUILTIN.find(x => x.id === 'ignite-default');
  const v = S.validate('intraday', b.preset);
  assert.ok(v.val, JSON.stringify(v.errs));
  assert.equal(v.val.tpStyle, 'fixed'); assert.equal(v.val.tp1Pct, 6); assert.equal(v.val.tp2Pct, 9);
  const bad = S.validate('intraday', { ...b.preset, tp1Pct: 9, tp2Pct: 6 });
  assert.ok(bad.errs && bad.errs.some(e => e.key === 'tp2Pct'));
});
