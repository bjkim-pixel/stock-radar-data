'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldKick } = require('../trail');

const L = { stop: 9800, stopped: false, trail: 2, steps: [{ p: 10200, armed: false, peak: null }, { p: 10400, armed: false, peak: null }] };

test('손절선 이하 틱 → 깨움, 위면 안 깨움', () => {
  assert.equal(shouldKick(L, 9800, 0), true);
  assert.equal(shouldKick(L, 9790, 0), true);
  assert.equal(shouldKick(L, 9810, 0), false);
});

test('감시 전 단계: 익절가 도달 시 깨움', () => {
  assert.equal(shouldKick(L, 10199, 0), false);
  assert.equal(shouldKick(L, 10200, 0), true);
});

test('감시 중 단계: 고점(엔진 고점·최근 틱 최고가 중 큰 값) 대비 trail% 하락 시 깨움', () => {
  const A = { ...L, steps: [{ p: 10200, armed: true, peak: 10450 }] };
  assert.equal(shouldKick(A, 10250, 0), false);      // 10450×0.98=10241 위
  assert.equal(shouldKick(A, 10241, 0), true);
  assert.equal(shouldKick(A, 10400, 10600), false);  // 최근 최고 10600 → 10388 위
  assert.equal(shouldKick(A, 10380, 10600), true);   // 엔진이 아직 모르는 새 고점 반영
});

test('손절 진행 중·계획 없음·가격 없음 → 깨우지 않음', () => {
  assert.equal(shouldKick({ ...L, stopped: true }, 9000, 0), false);
  assert.equal(shouldKick(null, 9000, 0), false);
  assert.equal(shouldKick(L, 0, 0), false);
  assert.equal(shouldKick({ stop: null, steps: [] }, 5000, 0), false);
});
