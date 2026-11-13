'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { allocate, pollWindowOpen, multiRowToPayload, planReconcile, parseQuotePower } = require('../subs');

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

test('해지 유예: grace 안이면 유지, 지나면 해지', () => {
  const at = new Map();
  let r = planReconcile(new Set(['A', 'B']), new Set(['A']), at, 1000, 36, 20000);
  assert.deepStrictEqual([r.remove, r.keep, r.add], [[], ['B'], []]);
  assert.strictEqual(r.nextAt, 21000);
  r = planReconcile(new Set(['A', 'B']), new Set(['A']), at, 15000, 36, 20000);
  assert.deepStrictEqual(r.remove, []);   // 처음 필요 없어진 시각(1000) 기준 유지
  r = planReconcile(new Set(['A', 'B']), new Set(['A']), at, 21001, 36, 20000);
  assert.deepStrictEqual([r.remove, r.keep], [['B'], []]);
  assert.strictEqual(at.has('B'), false);
});

test('해지 유예: 다시 필요해지면 재등록 없이 그대로', () => {
  const at = new Map();
  planReconcile(new Set(['A', 'B']), new Set(['A']), at, 0, 36, 20000);
  const r = planReconcile(new Set(['A', 'B']), new Set(['A', 'B']), at, 5000, 36, 20000);
  assert.deepStrictEqual([r.add, r.remove], [[], []]);
  assert.strictEqual(at.size, 0);
});

test('해지 유예: 한도가 차면 새 종목에 자리를 내줌(오래된 것부터)', () => {
  const at = new Map([['B', 0], ['C', 500]]);
  const r = planReconcile(new Set(['A', 'B', 'C']), new Set(['A', 'D']), at, 1000, 3, 20000);
  assert.deepStrictEqual([r.add, r.keep, r.remove], [['D'], ['C'], ['B']]);
});

test('현재가 시세 → 참고 지표', () => {
  const num = v => (v === '' || v == null ? null : Number(String(v).replace(/,/g, '')));
  const r = parseQuotePower({ stck_prpr: '70000', stck_hgpr: '70500', w52_hgpr: '72000', w52_hgpr_date: '20260901', vol_tnrt: '0.85', pgtr_ntby_qty: '-120000' }, num);
  assert.deepStrictEqual(r, { price: 70000, hgpr: 70500, w52: 72000, w52d: '20260901', tnrt: 0.85, pgQty: -120000, pgAmt: -8400000000 });
  assert.strictEqual(parseQuotePower(null, num), null);
  assert.strictEqual(parseQuotePower({ stck_prpr: '1000' }, num).pgAmt, null);
});

test('매매 보유 종목(최우선 가상 접속)은 화면 요청이 한도를 채워도 항상 실시간', () => {
  const held = new Set(['900001', '900002']);
  const screen = Array.from({ length: 40 }, (_, i) => String(100000 + i));
  const trade = { codes: held, hi: held, rank: new Map([...held].map((c, i) => [c, i])), lastActive: Number.MAX_SAFE_INTEGER };
  const r = allocate([cl(screen, { at: Date.now() }), trade], 36);
  assert.ok(r.ws.has('900001') && r.ws.has('900002'));
  assert.strictEqual(r.ws.size, 36);
  assert.strictEqual(r.order[0].hi, true);
});
