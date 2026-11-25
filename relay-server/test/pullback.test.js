'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PB = require('../pullback'), ST = require('../auto-strategy');

const EOK = 1e8;
const day = (d, o, h, l, c, v = 1e6) => ({ d, o, h, l, c, v, a: v * (o + c) / 2 });

test('막대: 그때까지의 신고 무게 · 상승 · 시총 하한만', () => {
  const rows = [
    { code: 'A', d: '2026-10-01', w: 0.35, chg: 5, mc: 2000 * EOK },    // 첫 막대
    { code: 'A', d: '2026-10-05', w: 0.31, chg: 4, mc: 2000 * EOK },    // 이전 최대(0.35)보다 작음 → 아님
    { code: 'A', d: '2026-10-09', w: 0.50, chg: 29.9, mc: 2000 * EOK }, // 새 신고 → 막대
    { code: 'B', d: '2026-10-02', w: 0.40, chg: -3, mc: 3000 * EOK },   // 하락 → 아님
    { code: 'B', d: '2026-10-08', w: 0.38, chg: 6, mc: 3000 * EOK },    // 이미 0.40 이 있어 신고 아님
    { code: 'C', d: '2026-10-03', w: 0.60, chg: 8, mc: 500 * EOK },     // 시총 1천억 미만
    { code: 'D', d: '2026-10-03', w: 0.20, chg: 8, mc: 5000 * EOK },    // 무게 미달
  ];
  const b = PB.findBars(rows);
  assert.deepEqual(b.map(x => x.code + x.d), ['A2026-10-01', 'A2026-10-09']);
});

test('barState: 막대 +2일부터 첫 재터치 · 이미 터치했으면 제외 · 범위 밖이면 제외', () => {
  // 막대일 평균가 = (1000+1100)/2 = 1050
  const bar = day('2026-11-02', 1000, 1100, 990, 1100);
  const up = [day('2026-11-03', 1100, 1200, 1090, 1180), day('2026-11-04', 1180, 1250, 1150, 1200)];
  let st = PB.barState([bar, ...up]);
  assert.ok(Math.abs(st.vw - 1050) < 1e-9);
  assert.equal(st.age, 3);
  assert.equal(st.touched, null);
  assert.equal(st.ok, true);
  assert.ok(Math.abs(st.stop - 1050 * 0.95) < 1e-9);
  // 3일째 저가가 1050×1.03=1081.5 이하 + 종가 ≥ 1050×0.97=1018.5 → 이미 터치한 날이 있음
  st = PB.barState([bar, up[0], day('2026-11-04', 1150, 1160, 1070, 1090)]);
  assert.equal(st.touched, '2026-11-04'); assert.equal(st.ok, false);
  // 다음 날(막대+1)은 터치로 세지 않음
  st = PB.barState([bar, day('2026-11-03', 1100, 1100, 1040, 1060), day('2026-11-04', 1180, 1250, 1150, 1200)]);
  assert.equal(st.touched, null, '막대 다음 날은 제외'); assert.equal(st.ok, true);
  // 터치했지만 종가가 평균가 −3% 아래면 터치로 세지 않음
  st = PB.barState([bar, up[0], day('2026-11-04', 1100, 1100, 1000, 1010)]);
  assert.equal(st.touched, null); assert.equal(st.broken, null, '종가 1010 > 손절선 997.5');
  st = PB.barState([bar, up[0], day('2026-11-04', 1100, 1100, 960, 990)]);
  assert.equal(st.broken, '2026-11-04');
  // 막대 바로 다음 날까지만(age 2 = 오늘이 막대+2일째)
  assert.equal(PB.barState([bar, up[0]]).ok, true);
  assert.equal(PB.barState([bar]).ok, false, '오늘이 막대 다음 날이면 후보 아님');
  // 너무 오래됨
  const long = [bar]; for (let i = 0; i < 30; i++) long.push(day(`2026-12-${String(i + 1).padStart(2, '0')}`, 1300, 1320, 1280, 1300));
  assert.equal(PB.barState(long, { maxAge: 30 }).ok, false);
  assert.equal(PB.barState(long.slice(0, 30), { maxAge: 30 }).ok, true);
});

test('오늘 봉 판정: 저가가 평균가+3% 이하까지 내려오고 현재가는 평균가−3% 위', () => {
  const st = PB.barState([day('2026-11-02', 1000, 1100, 990, 1100), day('2026-11-03', 1100, 1200, 1090, 1180)]);   // vw 1050 → hi 1081.5, lo 1018.5
  assert.equal(PB.todayTouch(st, { price: 1060, low: 1050 }), true);
  assert.equal(PB.todayTouch(st, { price: 1100, low: 1075 }), true, '저가가 범위 안');
  assert.equal(PB.todayTouch(st, { price: 1100, low: 1090 }), false, '저가가 아직 위');
  assert.equal(PB.todayTouch(st, { price: 1010, low: 1000 }), false, '종가가 평균가 −3% 아래');
  assert.equal(PB.todayTouch(st, { price: 1060, low: 0 }), true, '저가 정보가 없으면 현재가로 판단');
  assert.equal(PB.todayTouch(st, null), false);
});

test('거래일 수 계산 · 점수 · 사유', () => {
  const wk = d => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
  assert.equal(PB.tradingDaysBetween('2026-11-02', '2026-11-09', wk), 5);   // 월→다음 월
  assert.equal(PB.tradingDaysBetween('2026-11-06', '2026-11-09', wk), 1);   // 금→월
  assert.equal(PB.tradingDaysBetween('2026-11-09', '2026-11-09', wk), 0);
  const sig = { barDate: '2026-11-02', w: 0.52, chg: 29.9, up30: true, vw: 1050, gapPct: 0.8, smEok: 40, smBuy: true, mcEok: 3000, age: 4 };
  const s = PB.score(sig);
  assert.ok(s.total > 80 && s.total <= 100, JSON.stringify(s));
  assert.ok(PB.score({ ...sig, up30: false, smBuy: false, mcEok: 30000 }).total < s.total);
  assert.ok(PB.reasons(sig).join(' ').includes('상한가'));
});

test('기본 전략: 눌림목은 꺼진 가상 전략으로 등록되고 검증을 통과한다', () => {
  const b = ST.BUILTIN.find(x => x.id === 'pullback-default');
  assert.ok(b && b.off && b.preset.selector === 'pullback');
  const r = ST.validate('intraday', { ...ST.defaults('intraday'), ...b.preset });
  assert.ok(r.val, JSON.stringify(r.errs));
  assert.equal(r.val.selectAt, '15:10'); assert.equal(r.val.tp1Pct, 8); assert.equal(r.val.tp2Pct, 12); assert.equal(r.val.execMode, 'paper');
  // 눌림목이 아닌 전략은 승인 마감이 14:30 을 넘으면 여전히 거부
  const bad = ST.validate('intraday', { ...ST.defaults('intraday'), selectAt: '15:10', approveWindow: 5 });
  assert.ok(bad.errs && bad.errs.some(e => e.key === 'approveWindow'));
  const row = ST.BUILTIN.find(x => x.id === 'pullback-default');
  assert.equal(ST.validate('intraday', { ...r.val, pbWMin: 2 }).errs[0].key, 'pbWMin');
  assert.equal(row.kind, 'intraday');
});
