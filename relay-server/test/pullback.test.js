'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PB = require('../pullback'), ST = require('../auto-strategy');

const rec = (code, rk, d, w, a = 1.05e9, v = 1e6, chg = 10) => ({ code, rk, trade_date: d, w, trade_amount: a, volume: v, change_pct: chg });
const H = (vw, ...cs) => [{ d: '2026-10-01', c: vw * 1.1 }, ...cs.map((c, i) => ({ d: `2026-10-0${i + 2}`, c }))];

test('수준 추출: 무게 하한·평균가 없는 행은 버리고 평균가 = 거래대금÷거래량', () => {
  const L = PB.levels([rec('A', 1, '2026-10-01', 0.5), rec('A', 2, '2026-09-20', 0.05), rec('B', 1, '2026-10-02', 0.3, 0, 1e6), rec('C', 2, '2026-10-03', 0.2, 2e9, 1e6)]);
  assert.deepEqual(L.map(x => x.code + x.rk), ['A1', 'C2']);
  assert.equal(L[0].vw, 1050); assert.equal(L[1].vw, 2000);
});

test('무장 상태: 기준가 −2% 아래 종가가 나와야 눌림, 되찾은 뒤엔 해제, 다시 빠지면 재무장', () => {
  const vw = 1000;
  assert.equal(PB.levelState(H(vw, 1100, 1050), vw).armed, false, '계속 위에 있으면 눌림 아님');
  assert.equal(PB.levelState(H(vw, 1100, 990), vw).armed, false, '−1% 는 얕아서 눌림 아님(−2% 필요)');
  let st = PB.levelState(H(vw, 1100, 970), vw);
  assert.equal(st.armed, true); assert.equal(st.dipDate, '2026-10-03'); assert.equal(st.ok, true); assert.equal(st.age, 3);
  assert.ok(Math.abs(st.minGapPct + 3) < 1e-9);
  st = PB.levelState(H(vw, 1100, 970, 1015), vw);
  assert.equal(st.armed, false, '기준가 +1% 위로 마감해 되찾음 → 해제'); assert.equal(st.crossedDate, '2026-10-04');
  st = PB.levelState(H(vw, 1100, 970, 1005), vw);
  assert.equal(st.armed, true, '+0.5% 는 아직 완전 돌파 아님');
  st = PB.levelState(H(vw, 1100, 970, 1015, 960), vw);
  assert.equal(st.armed, true, '되찾은 뒤 다시 빠지면 재무장');
  assert.equal(PB.levelState([{ d: '2026-10-01', c: 1100 }], vw).ok, false, '오늘이 그날 다음 날이면 후보 아님');
  const long = [{ d: '2026-10-01', c: 1100 }, { d: '2026-10-02', c: 950 }]; for (let i = 0; i < 70; i++) long.push({ d: `x${i}`, c: 960 });
  assert.equal(PB.levelState(long, vw, { maxAge: 63 }).ok, false); assert.equal(PB.levelState(long.slice(0, 40), vw, { maxAge: 63 }).ok, true);
});

test('오늘 돌파 판정: +1% 이상 +6% 이하만', () => {
  assert.equal(PB.todayBreak(1000, { price: 1009 }), false);
  assert.equal(PB.todayBreak(1000, { price: 1010 }), true);
  assert.equal(PB.todayBreak(1000, { price: 1060 }), true);
  assert.equal(PB.todayBreak(1000, { price: 1061 }), false, '이미 많이 올라 쫓지 않음');
  assert.equal(PB.todayBreak(1000, null), false);
  assert.equal(PB.todayBreak(1000, { price: 1030 }, { breakPct: 3, chasePct: 5 }), true);
});

test('스마트머니 점검: 1개월·3개월 모두 매집 지속/정체이고 주도 세력이 팔고 있지 않아야', () => {
  const r = (win, st, lead_trend = 'UP') => ({ win, st, lead_nm: '외국인', lead_trend });
  assert.equal(PB.smGate([r('21', 'CONT'), r('63', 'STALL', 'FLAT')]).ok, true);
  let g = PB.smGate([r('21', 'LEAVE'), r('63', 'CONT')]);
  assert.equal(g.ok, false); assert.match(g.fails.join(), /1개월.*이탈 진행/);
  g = PB.smGate([r('21', 'CONT'), r('63', 'CONT', 'DOWN')]);
  assert.equal(g.ok, false); assert.match(g.fails.join(), /3개월.*외국인 매도 중/);
  assert.equal(PB.smGate([r('21', 'CONT', 'TURN'), r('63', 'CONT')]).ok, false);
  g = PB.smGate([r('63', 'CONT')]); assert.equal(g.ok, false); assert.match(g.fails.join(), /1개월 자료 없음/);
  assert.equal(PB.smGate(null).ok, false);
  assert.equal(PB.smGate([r('21', 'CONT'), r('63', 'CONT')]).info['21'].lead, '외국인');
});

test('거래일 수 계산 · 점수 · 사유', () => {
  const wk = d => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
  assert.equal(PB.tradingDaysBetween('2026-11-02', '2026-11-09', wk), 5);   // 월→다음 월
  assert.equal(PB.tradingDaysBetween('2026-11-06', '2026-11-09', wk), 1);   // 금→월
  assert.equal(PB.tradingDaysBetween('2026-11-09', '2026-11-09', wk), 0);
  const sig = { barDate: '2026-11-02', rk: 1, w: 0.52, chg: 29.9, vw: 1050, gapPct: 1.2, sm: { 21: { st: 'CONT', trend: 'UP' }, 63: { st: 'CONT', trend: 'UP' } }, mcEok: 3000, dipDate: '2026-11-05', age: 12 };
  const s = PB.score(sig);
  assert.ok(s.total > 80 && s.total <= 100, JSON.stringify(s));
  assert.ok(PB.score({ ...sig, rk: 2, mcEok: 30000, sm: { 63: { trend: 'FLAT' } } }).total < s.total);
  const r = PB.reasons(sig).join(' ');
  assert.ok(r.includes('1위일') && r.includes('상한가') && r.includes('돌파') && r.includes('스마트머니'));
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
  assert.equal(r.val.pbSmGate, true); assert.equal(r.val.pbMaxAge, 63); assert.equal(r.val.pbBreakPct, 1);
});
