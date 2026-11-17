'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEod, RULE } = require('../auto-eod');

function rig({ open, price, avg = 10000, rule = {}, it = {}, plan = { stopPct: 5, steps: [{ n: 1, p: 10500, q: 3 }], ratchet: null, src: '원래 계획' } } = {}) {
  const carry = { items: { A: { code: 'A', name: '가', q0: 10, avg, from: '2026-11-16', sold: 0, state: 'wait', sid: 'intraday-a', ...it } } };
  const edits = [], placed = [], sent = [];
  const D = {
    paper: {
      state: async () => ({ ok: true, positions: [{ code: 'A', name: '가', qty: 10, avail: 10, avg }] }),
      editPlan: async b => { edits.push(b); return { ok: true }; },
      place: async o => { placed.push(o); return { ok: true, fills: [{ qty: o.qty, amount: o.qty * price }] }; },
    },
    getQuote: async () => ({ price, open, prevClose: 10000 }),
    readCarry: async () => carry, mutateCarry: async fn => fn(carry),
    mutateRun: async () => {}, readRun: async () => null, sendTelegram: async t => sent.push(t),
    rule: async () => ({ ...RULE, ...rule }), now: () => 1e12, restorePlan: async () => plan, intraCodes: () => [],
  };
  return { eod: createEod(D), carry, edits, placed, sent };
}
const MIN = 9 * 60 + 6;

test('시가·현재가 모두 매수가보다 낮으면 매도 보류 + 장중 계획 복원 + 상태 intra', async () => {
  const r = rig({ open: 9800, price: 9850 });
  await r.eod.morning('2026-11-17', MIN);
  assert.equal(r.placed.length, 0);
  assert.equal(r.edits.length, 1); assert.equal(r.edits[0].steps.length, 1); assert.equal(r.edits[0].stopPct, 5);
  assert.equal(r.carry.items.A.state, 'intra'); assert.equal(r.carry.items.A.holdDate, '2026-11-17');
  assert.match(r.sent.join(), /보류/);
});
test('보류 조건을 "둘 다"로 하면 시가가 매수가 이상일 때 기존대로 분할 매도', async () => {
  const r = rig({ open: 10100, price: 9850, rule: { holdMode: 'both' } });
  await r.eod.morning('2026-11-17', MIN);
  assert.equal(r.edits.length, 0); assert.ok(r.placed.length >= 1);
});
test('현재가만 보는 모드, 끄면 보류 안 함, 이미 판 종목은 보류 안 함', async () => {
  const a = rig({ open: 10100, price: 9850 }); await a.eod.morning('2026-11-17', MIN);   // 기본값 = 현재가만
  assert.equal(a.carry.items.A.state, 'intra');
  const b = rig({ open: 9800, price: 9850, rule: { holdOn: false } }); await b.eod.morning('2026-11-17', MIN);
  assert.equal(b.carry.items.A.state === 'intra', false);
  const c = rig({ open: 9800, price: 9850, it: { sold: 3, state: 'selling' } }); await c.eod.morning('2026-11-17', MIN);
  assert.equal(c.carry.items.A.state === 'intra', false);
});
test('장중 전환 종목은 같은 날 아침 매도에서 제외, 20:00 재이월은 손절만 남기고 carry 로 되돌림', async () => {
  const r = rig({ open: 9800, price: 9850 });
  await r.eod.morning('2026-11-17', MIN);
  r.placed.length = 0; r.edits.length = 0;
  await r.eod.morning('2026-11-17', MIN + 1);
  assert.equal(r.placed.length, 0);
  const out = await r.eod.reconvert('2026-11-17');
  assert.equal(out.n, 1);
  assert.deepEqual(r.edits[0], { code: 'A', stopPct: 5, steps: [], ratchet: null });
  assert.equal(r.carry.items.A.state, 'wait'); assert.equal(r.carry.items.A.from, '2026-11-17'); assert.equal(r.carry.items.A.reconv, 1);
});
test('계획을 복원하지 못하면 보류하지 않고 기존대로 매도', async () => {
  const r = rig({ open: 9800, price: 9850, plan: null });
  await r.eod.morning('2026-11-17', MIN);
  assert.ok(r.placed.length >= 1);
});

test('전환 효과 비교: 그냥 팔았다면 vs 전환 후(매도 실현 + 남은 수량 평가)', () => {
  const { holdCompare } = require('../auto-ui');
  const it = { code: 'A', name: '가', avg: 10000, holdDate: '2026-11-17', holdPrice: 9850, holdQty: 10, holdAt: 1000 };
  const r = holdCompare([it], [{ code: 'A', side: 'sell', qty: 4, ts: 2000, realized: 2000 }], [{ code: 'A', last: 10100 }], '2026-11-17');
  assert.deepEqual(r[0], { code: 'A', name: '가', qty: 10, avg: 10000, holdPrice: 9850, soldQty: 4, restQty: 6, last: 10100, straight: -1500, actual: 2600, diff: 4100 });
  assert.equal(holdCompare([it], [], [], '2026-11-17').length, 0);              // 현재가를 모르면 비교 안 함
  assert.equal(holdCompare([it], [], [{ code: 'A', last: 9900 }], '2026-11-18').length, 0);   // 다른 날짜
  const rig2 = rig({ open: 9800, price: 9850 });
  return rig2.eod.morning('2026-11-17', MIN).then(() => assert.equal(rig2.carry.items.A.holdQty, 10));
});
