'use strict';
const test = require('node:test'), assert = require('node:assert');
const IG = require('../ignite'), ST = require('../auto-strategy');
const P = ST.BUILTIN.find(b => b.id === 'ignite-default').preset;
const PP = ST.validate('intraday', P).val;
const M = (h, m) => h * 60 + m;

/* 09:00~now 사이 1분 스냅샷을 만든다. 가격·누적 거래대금을 함수로 */
function series(from, to, px, amt) {
  const t = IG.createTracker();
  for (let m = from; m <= to; m++) t.ingest([{ code: 'A', price: px(m), open: 10000, high: Math.max(...Array.from({ length: m - from + 1 }, (_, i) => px(from + i))), vol: amt(m) / 10000, amt: amt(m) }], m * 60000, m);
  return t;
}
const row = (price, amt, over = {}) => ({ code: 'A', name: 'A', price, open: 10000, high: price, changePct: (price / 10000 - 1) * 100 + 0.0, vol: amt / 10100, amt, ...over });

test('프리셋 검증: 시총 3천억~4조 미만 · 09:15 · 10분 · 100만원 · 5종목 · 당일 청산 끔', () => {
  assert.ok(PP, '프리셋이 검증을 통과해야 함');
  assert.strictEqual(PP.selector, 'ignite'); assert.strictEqual(PP.capMaxEok, 40000); assert.strictEqual(PP.selectAt, '09:15');
  assert.strictEqual(PP.roundMin, 10); assert.strictEqual(PP.roundEnd, '14:30'); assert.strictEqual(PP.perStockKrw, 1000000);
  assert.strictEqual(PP.maxBuys, 5); assert.strictEqual(PP.flatOn, false); assert.strictEqual(PP.flatAt, '15:14'); assert.strictEqual(PP.execMode, 'paper');
});
test('기본 전략 목록: 시동은 꺼진 채 들어 있고 기존 전략은 그대로 켜짐', async () => {
  const st = ST.createStore({ sbGet: async () => { throw new Error('404 PGRST205'); }, sbWrite: async () => {} });
  const L = await st.list(true);
  assert.strictEqual(L.find(x => x.id === 'ignite-default').enabled, false);
  assert.strictEqual(L.find(x => x.id === 'intraday-default').params.selector, 'flow');
  assert.deepStrictEqual((await st.actives()).Is.map(x => x.id), ['intraday-default']);
});
test('오르기 시작하는 종목은 통과', () => {
  // 09:00~09:10 잔잔(10000~10050, 분당 1억) → 09:11~09:20 상승(10050→10300), 분당 4억
  const px = m => (m <= M(9, 10) ? 10000 + (m - 540) * 5 : 10050 + (m - M(9, 10)) * 25);
  const amt = m => (m <= M(9, 10) ? (m - 539) * 1e8 : 11e8 + (m - M(9, 10)) * 4e8);
  const t = series(M(9, 0), M(9, 20), px, amt), now = M(9, 20);
  const c = row(px(now), amt(now));
  const ev = IG.evaluate(c, t.get('A'), PP, now, { cttr: 135, pgQty: 1000 });
  assert.ok(ev.pass, ev.fails.join(' | '));
  assert.ok(ev.m.amtRatio >= 2 && ev.m.riseWin >= 0.8 && ev.m.orHigh > 0);
  const sc = IG.score(ev.m, PP); assert.ok(sc.total > 40 && sc.total <= 100);
});
test('시작부터 크게 갭 상승한 종목은 제외', () => {
  const px = m => 10600 + (m - 540) * 10, amt = m => (m - 539) * 3e8;
  const t = series(M(9, 0), M(9, 20), px, amt);
  const c = row(px(M(9, 20)), amt(M(9, 20)), { open: 10600, changePct: 8 });
  const ev = IG.evaluate({ ...c, open: 10600 }, t.get('A'), PP, M(9, 20), { cttr: 150, pgQty: 1 });
  assert.ok(!ev.pass); assert.ok(ev.fails.some(f => /갭/.test(f)));
});
test('이미 12% 이상 오른 과열 종목은 제외', () => {
  const px = m => 11300 + (m - 540) * 5, amt = m => (m - 539) * 3e8;
  const t = series(M(9, 0), M(9, 20), px, amt);
  const ev = IG.evaluate(row(px(M(9, 20)), amt(M(9, 20)), { open: 10300, changePct: 13 }), t.get('A'), PP, M(9, 20), { cttr: 150, pgQty: 1 });
  assert.ok(ev.fails.some(f => /과열/.test(f)));
});
test('거래대금이 안 붙으면 제외', () => {
  const px = m => (m <= M(9, 10) ? 10000 + (m - 540) * 5 : 10050 + (m - M(9, 10)) * 25);
  const amt = m => (m - 539) * 1e8;   // 분당 1억 일정
  const t = series(M(9, 0), M(9, 20), px, amt);
  const ev = IG.evaluate(row(px(M(9, 20)), amt(M(9, 20))), t.get('A'), PP, M(9, 20), { cttr: 150, pgQty: 1 });
  assert.ok(!ev.pass); assert.ok(ev.fails.some(f => /거래대금 \d/.test(f)));
});
test('이력이 없으면(서버 재시작 직후) 통과시키지 않고 이유를 남김', () => {
  const ev = IG.evaluate(row(10250, 50e8), [], PP, M(10, 0), { cttr: 150, pgQty: 1 });
  assert.ok(!ev.pass); assert.ok(ev.unknown.length);
});
test('장 초반 고가를 못 넘으면 제외', () => {
  // 09:03에 10400 찍고 눌린 뒤 10250 — 현재가 < 초반 고가
  const px = m => (m === M(9, 3) ? 10400 : m < M(9, 11) ? 10100 : 10100 + (m - M(9, 10)) * 15);
  const amt = m => (m <= M(9, 10) ? (m - 539) * 1e8 : 11e8 + (m - M(9, 10)) * 4e8);
  const t = series(M(9, 0), M(9, 20), px, amt);
  const ev = IG.evaluate(row(px(M(9, 20)), amt(M(9, 20))), t.get('A'), PP, M(9, 20), { cttr: 150, pgQty: 1 });
  assert.ok(ev.fails.some(f => /장 초반 고가/.test(f)));
});
