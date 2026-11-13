'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTickHook } = require('../kick');

function mk(lines, held = ['005930']) {
  const calls = [];
  const h = createTickHook({ held: () => new Set(held), watchLines: () => lines, kick: async (e, c) => { calls.push([e, c]); return true; } });
  return { h, calls };
}
const L = { stop: 9800, stopped: false, trail: 2, steps: [{ p: 10200, armed: true, peak: 10300 }] };

test('보유 종목이 아니면 아무것도 안 함', async () => {
  const { h, calls } = mk([['paper', L]], []);
  await Promise.all(h.onTick('005930', 9000, 1e6));
  assert.equal(calls.length, 0);
});

test('손절선 아래 틱 → 해당 엔진 깨움 + 통계', async () => {
  const { h, calls } = mk([['paper', L], ['live', { ...L, stop: 9500, steps: [] }]]);
  await Promise.all(h.onTick('005930', 9790, 1e6));
  assert.deepEqual(calls, [['paper', '005930']]);          // 실전 손절선(9500)은 아직
  assert.equal(h.stat.acted, 1); assert.equal(h.stat.lastEng, 'paper');
});

test('최근 10초 틱 최고가로 트레일링 발동선 계산 (엔진 고점이 아직 갱신 전이어도)', async () => {
  const { h, calls } = mk([['paper', L]]);
  await Promise.all(h.onTick('005930', 10700, 1e6));       // 새 고점(엔진 peak 10300 모름)
  assert.equal(calls.length, 0);
  await Promise.all(h.onTick('005930', 10480, 1e6 + 3000)); // 10700×0.98=10486 아래 → 깨움
  assert.equal(calls.length, 1);
  await Promise.all(h.onTick('005930', 10480, 1e6 + 20000)); // 10초 지나 최근 최고가 사라짐 → 엔진 고점 기준(10094) 위
  assert.equal(calls.length, 1);
});
