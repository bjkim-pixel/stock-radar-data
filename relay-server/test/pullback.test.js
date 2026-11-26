'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PB = require('../pullback'), ST = require('../auto-strategy');

const EOK = 1e8;
// 평범한 날 12개 + 기준봉 후보. 평균 거래대금 100억(=1e10)
const flat = (n, d0 = 1) => Array.from({ length: n }, (_, i) => ({ d: `2026-09-${String(d0 + i).padStart(2, '0')}`, o: 100, h: 102, l: 98, c: 100, v: 1e6, a: 1e10, w: 0.01 }));
const bar = (d, over = {}) => ({ d, o: 100, h: 121, l: 99, c: 120, v: 4e6, a: 6e10, w: 1.2, ...over });   // +20% 양봉 · 종가 상단 95% · 거래대금 600억(평균의 6배)

test('기준봉: 양봉 몸통 · 종가 상단 · 무게 · 거래대금(절대·20일 평균 배수) 조건을 모두 채워야', () => {
  const h = (b) => [...flat(12), b];
  assert.equal(PB.candleDays(h(bar('2026-09-20'))).length, 1);
  assert.equal(PB.candleDays(h(bar('2026-09-20', { o: 125, h: 126, l: 119, c: 120 }))).length, 0, '음봉(10/06 안랩 같은 갭 후 하락 마감)');
  assert.equal(PB.candleDays(h(bar('2026-09-20', { o: 100, c: 105, h: 106 }))).length, 0, '몸통 +5% < 10%');
  assert.equal(PB.candleDays(h(bar('2026-09-20', { h: 160 }))).length, 0, '윗꼬리 길어 종가가 고저폭 상단 70% 미만');
  assert.equal(PB.candleDays(h(bar('2026-09-20', { w: 0.3 }))).length, 0, '무게 0.5 미만');
  assert.equal(PB.candleDays(h(bar('2026-09-20', { a: 4e10 }))).length, 0, '거래대금 500억 미만');
  assert.equal(PB.candleDays(h(bar('2026-09-20', { a: 3.9e10 })), { barAmtEok: 100 }).length, 0, '20일 평균(100억)의 4배 미만');
  assert.equal(PB.candleDays([...flat(8), bar('2026-09-20')]).length, 0, '직전 일봉 10개 미만이면 평균을 못 구해 제외');
  const c = PB.candleDays(h(bar('2026-09-20')))[0];
  assert.equal(c.o, 100); assert.ok(Math.abs(c.body - 20) < 1e-9); assert.ok(c.pos > 94); assert.equal(Math.round(c.vw), 15000);
});

test('후보 수준: 경과 2~maxAge 거래일 · 무게 큰 2개 · 기준가 = 시가(기본) 또는 평균가', () => {
  const hist = [...flat(12), bar('2026-09-20', { w: 1.0 }), ...flat(3, 21), bar('2026-09-25', { w: 3.0 }), bar('2026-09-26', { w: 2.0, a: 1.5e11 }), ...flat(2, 27)];
  let L = PB.levelsOf(hist);
  assert.deepEqual(L.map(x => [x.d, x.rk]), [['2026-09-25', 1], ['2026-09-26', 2]], '무게 큰 2개 — 1위 09-25, 2위 09-26(09-20 은 3위라 제외)');
  assert.equal(L[0].ref, 100); assert.equal(L[0].age, 4);
  L = PB.levelsOf(hist, { ref: 'vwap' }); assert.equal(Math.round(L[0].ref), 15000);
  assert.equal(PB.levelsOf([...flat(12), bar('2026-09-20')]).length, 0, '어제가 기준봉(경과 1일)이면 아직 후보 아님');
  assert.equal(PB.levelsOf([...flat(12), bar('2026-09-20'), flat(1, 21)[0]]).length, 1, '경과 2일부터');
  assert.deepEqual(PB.levelsOf(hist, { maxAge: 3 }).map(x => x.d), ['2026-09-26'], 'maxAge 3 이면 경과 3일 이내인 것만');
});

const H = (vw, ...cs) => [{ d: '2026-10-01', c: vw }, ...cs.map((c, i) => ({ d: `2026-10-${String(i + 2).padStart(2, '0')}`, c }))];
test('무장 상태: 기준가 아래로 종가가 내려간 적만 있으면 눌림(깊이 무관), 되찾으면 해제, 다시 빠지면 재무장', () => {
  const vw = 1000;
  assert.equal(PB.levelState(H(vw, 1100, 1050), vw).armed, false, '계속 위에 있으면 눌림 아님');
  let st = PB.levelState(H(vw, 1100, 990), vw);
  assert.equal(st.armed, true, '−1% 로 얕아도 기준가 아래면 눌림'); assert.equal(st.dipDate, '2026-10-03'); assert.equal(st.ok, true); assert.equal(st.age, 3);
  assert.equal(PB.levelState(H(vw, 1100, 1000), vw).armed, false, '정확히 기준가는 아래가 아님');
  st = PB.levelState(H(vw, 1100, 970), vw);
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
  assert.equal(PB.levelState(H(vw, 970, 960), vw, { dipPct: 2 }).armed, true); assert.equal(PB.levelState(H(vw, 990), vw, { dipPct: 2 }).armed, false, 'dipPct 를 주면 그만큼 깊어야');
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
  const sig = { barDate: '2026-11-02', rk: 1, w: 0.52, chg: 29.9, body: 18, pos: 92, amtEok: 1543, ref: 1050, refKind: 'open', gapPct: 1.2, sm: { 21: { st: 'CONT', trend: 'UP' }, 63: { st: 'CONT', trend: 'UP' } }, mcEok: 3000, dipDate: '2026-11-05', age: 12 };
  const s = PB.score(sig);
  assert.ok(s.total > 80 && s.total <= 100, JSON.stringify(s));
  assert.ok(PB.score({ ...sig, rk: 2, mcEok: 30000, sm: { 63: { trend: 'FLAT' } } }).total < s.total);
  const r = PB.reasons(sig).join(' ');
  assert.ok(r.includes('기준봉') && r.includes('시가') && r.includes('1,543억') && r.includes('돌파') && r.includes('스마트머니'));
});

test('기본 전략: 눌림목은 꺼진 가상 전략으로 등록되고 검증을 통과한다', () => {
  const b = ST.BUILTIN.find(x => x.id === 'pullback-default');
  assert.ok(b && b.off && b.preset.selector === 'pullback');
  const r = ST.validate('intraday', { ...ST.defaults('intraday'), ...b.preset });
  assert.ok(r.val, JSON.stringify(r.errs));
  assert.equal(r.val.selectAt, '15:10'); assert.equal(r.val.tp1Pct, 10); assert.equal(r.val.tp2Pct, 15); assert.equal(r.val.execMode, 'paper');
  // 눌림목이 아닌 전략은 승인 마감이 14:30 을 넘으면 여전히 거부
  const bad = ST.validate('intraday', { ...ST.defaults('intraday'), selectAt: '15:10', approveWindow: 5 });
  assert.ok(bad.errs && bad.errs.some(e => e.key === 'approveWindow'));
  const row = ST.BUILTIN.find(x => x.id === 'pullback-default');
  assert.equal(ST.validate('intraday', { ...r.val, pbWMin: 2 }).errs[0].key, 'pbWMin');
  assert.equal(row.kind, 'intraday');
  assert.equal(r.val.pbSmGate, true); assert.equal(r.val.pbMaxAge, 63); assert.equal(r.val.pbBreakPct, 1); assert.equal(r.val.pbRef, 'open'); assert.equal(r.val.pbDipPct, 0); assert.equal(r.val.pbHoldDays, 0); assert.equal(r.val.pbWMin, 0.5);
});
