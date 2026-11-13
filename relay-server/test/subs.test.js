'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { allocate, pollWindowOpen, multiRowToPayload } = require('../subs');

const cl = (codes, opt = {}) => ({ codes: new Set(codes), hi: new Set(opt.hi || []), rank: new Map(codes.map((c, i) => [c, i])), lastActive: opt.at || 0 });

test('한도 안이면 전부 웹소켓', () => {
  const r = allocate([cl(['000001', '000002'])], 36);
  assert.deepStrictEqual([...r.ws], ['000001', '000002']);
  assert.strictEqual(r.polled.size, 0);
});

test('한도 초과분은 순위 뒤쪽부터 폴링으로', () => {
  const codes = Array.from({ length: 40 }, (_, i) => String(100000 + i));
  const r = allocate([cl(codes)], 36);
  assert.strictEqual(r.ws.size, 36);
  assert.deepStrictEqual([...r.polled], codes.slice(36));
});

test('매매 화면 종목(hi)은 순위와 무관하게 먼저', () => {
  const codes = Array.from({ length: 40 }, (_, i) => String(100000 + i));
  const r = allocate([cl(codes, { hi: ['100039'] })], 36);
  assert.ok(r.ws.has('100039'));
  assert.ok(r.polled.has('100035'));
});

test('최근 활동한 접속의 요청이 오래된 접속보다 먼저', () => {
  const a = Array.from({ length: 30 }, (_, i) => String(200000 + i));
  const b = Array.from({ length: 30 }, (_, i) => String(300000 + i));
  const r = allocate([cl(a, { at: 1 }), cl(b, { at: 2 })], 36);
  b.forEach(c => assert.ok(r.ws.has(c)));
  assert.strictEqual(a.filter(c => r.ws.has(c)).length, 6);
});

test('같은 종목을 여러 접속이 요청하면 가장 좋은 우선순위로 한 번만', () => {
  const r = allocate([cl(['111111'], { at: 1 }), cl(['111111'], { at: 5, hi: ['111111'] })], 1);
  assert.deepStrictEqual(r.order, [{ code: '111111', hi: true }]);
});

test('폴링 시간대: 평일 장중만', () => {
  assert.strictEqual(pollWindowOpen(new Date('2026-11-13T01:00:00Z')), true);   // 금 10:00 KST
  assert.strictEqual(pollWindowOpen(new Date('2026-11-13T12:00:00Z')), false);  // 금 21:00 KST
  assert.strictEqual(pollWindowOpen(new Date('2026-11-14T01:00:00Z')), false);  // 토
});

test('멀티시세 행 → 체결 메시지 모양', () => {
  const num = v => (v === '' || v == null ? null : Number(v));
  const p = multiRowToPayload({ inter_shrn_iscd: '005930', inter2_prpr: '70000', prdy_ctrt: '1.5', inter2_oprc: '69000', inter2_hgpr: '70500', acml_vol: '100', acml_tr_pbmn: '7000000' }, num);
  assert.deepStrictEqual(p, { type: 'price', code: '005930', price: 70000, changePct: 1.5, sign: null, time: null, polled: true, open: 69000, dayHighPx: 70500, accVol: 100, accAmt: 7000000 });
  assert.strictEqual(multiRowToPayload({ inter_shrn_iscd: '005930', inter2_prpr: '0' }, num), null);
});
