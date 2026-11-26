'use strict';
/* 눌림목 매매("기준봉 시가 회복", 2026-11-26 규칙 교체 · 198 백테스트 근거) — 순수 계산(네트워크·DB 없음)
   기준봉 = 양봉(시가 대비 +bodyPct% 이상) · 종가가 그날 고저폭 상단 closePos% 이상 · 무게/주식수 ≥ wMin · 거래대금 ≥ barAmtEok억 이면서 직전 20일 평균의 barAmtX배 이상
   관찰   = 최근 maxAge 거래일(≈3개월) 안 기준봉 중 무게 큰 2개(1위·2위) · 시총 ≥ capMin
   기준가 = 기준봉의 시가(ref='open', 기본) 또는 평균가(거래대금÷거래량, ref='vwap')
   무장   = 그 뒤 종가가 기준가 아래(dipPct 만큼 이상)로 내려간 적이 있고, 그 뒤 기준가 +breakPct% 위로 종가 마감한 적은 없음(= 아직 못 되찾은 눌림 상태)
   수급   = 종목상세 스마트머니(smx_state) 1개월·3개월 모두 매집 지속/정체 · 주도 세력이 팔고 있지 않을 것
   매수   = 무장 상태에서 오늘 현재가가 기준가 +breakPct% 이상 돌파(단 +chasePct% 까지) → 15:10 시장가. 기준봉이 둘이면 오늘 돌파한 것 중 기준가에 가까운 쪽
   손절 −stopBelow%(종가 마감) · 익절·시간 청산은 전략 공통 설정 */

const DEF = Object.freeze({ wMin: 0.5, capMinEok: 1000, maxAge: 63, dipPct: 0, breakPct: 1, chasePct: 6, bodyPct: 10, closePos: 70, barAmtEok: 500, barAmtX: 4, ref: 'open', stopBelowPct: 5, holdDays: 0, smGate: true, capMaxEok: 0, minAmtEok: 0 });
const EOK = 1e8;

/* 기준봉 찾기. hist = 한 종목의 일봉 오름차순(주말 행 제외) [{d,o,h,l,c,v,a,w}] — 직전 20일 평균 거래대금이 필요하므로 기준봉 날보다 앞선 일봉도 함께 */
function candleDays(hist, P = {}) {
  const o = { ...DEF, ...P }, out = [];
  for (let i = 0; i < (hist || []).length; i++) {
    const x = hist[i];
    if (!(x.o > 0 && x.c > x.o && x.h > x.l && x.w >= o.wMin && x.a >= o.barAmtEok * EOK)) continue;
    const body = (x.c - x.o) / x.o * 100, pos = (x.c - x.l) / (x.h - x.l) * 100;
    if (body < o.bodyPct || pos < o.closePos) continue;
    const prev = hist.slice(Math.max(0, i - 20), i);
    if (prev.length < 10) continue;
    const avg = prev.reduce((s, y) => s + (+y.a || 0), 0) / prev.length;
    if (!(x.a >= o.barAmtX * avg)) continue;
    out.push({ i, d: x.d, w: x.w, o: x.o, c: x.c, a: x.a, body, pos, chg: x.o > 0 && hist[i - 1] && hist[i - 1].c > 0 ? (x.c / hist[i - 1].c - 1) * 100 : body, vw: x.v > 0 ? x.a / x.v : 0 });
  }
  return out;
}

/* 오늘(= hist 마지막 다음 날)의 관찰 후보 수준: 기준봉 중 경과 2~maxAge거래일 · 무게 큰 2개. 반환 [{rk, ...candle, ref, age}] */
function levelsOf(hist, P = {}) {
  const o = { ...DEF, ...P }, m = (hist || []).length;
  const c = candleDays(hist, o).filter(x => m - x.i >= 2 && m - x.i <= o.maxAge).sort((x, y) => y.w - x.w).slice(0, 2);
  return c.map((x, k) => ({ ...x, rk: k + 1, age: m - x.i, ref: o.ref === 'vwap' ? x.vw : x.o })).filter(x => x.ref > 0);
}

/* 한 수준의 상태. hist = 그 종목의 1·2위일 이후(그날 포함, 오늘 제외) 일봉 오름차순 [{d,c}] — hist[0] 이 1·2위일.
   반환 { vw, age(그날 이후 지난 거래일, 오늘 포함), armed(눌림 상태), dipDate, minGapPct(가장 깊었던 종가가 기준가 대비 몇 %), crossedDate(마지막으로 기준가를 되찾은 날) } */
function levelState(hist, vw, P = {}) {
  const o = { ...DEF, ...P };
  if (!hist || !hist.length || !(vw > 0)) return null;
  const dip = vw * (1 - o.dipPct / 100), brk = vw * (1 + o.breakPct / 100);
  let armed = false, dipDate = null, crossedDate = null, minC = Infinity;
  for (let j = 1; j < hist.length; j++) {
    const c = hist[j].c;
    if (!(c > 0)) continue;
    if (c < minC) minC = c;
    if (c < dip) { if (!armed) dipDate = hist[j].d; armed = true; }
    else if (armed && c >= brk) { armed = false; crossedDate = hist[j].d; dipDate = null; }
  }
  const age = hist.length;   // hist 에 그날부터 어제까지 → 오늘은 그날 + age 번째 거래일
  return { vw, age, armed, dipDate, crossedDate, minGapPct: minC === Infinity ? null : (minC / vw - 1) * 100, ok: armed && age >= 2 && age <= o.maxAge };
}

/* 오늘 시세가 완전 돌파 조건을 채웠는지. live = {price} */
function todayBreak(vw, live, P = {}) {
  const o = { ...DEF, ...P };
  if (!(vw > 0) || !live || !(live.price > 0)) return false;
  const g = Math.round((live.price / vw - 1) * 1e8) / 1e6;   // 부동소수 오차(6.000000000000005) 방지
  return g >= o.breakPct && g <= o.chasePct;
}

/* 스마트머니 점검: rows = smx_state 행 [{win, st, lead_nm, lead_trend}] (win '21'·'63'). 두 기간 모두 매집 지속/정체이고 주도 세력이 팔고 있지(DOWN·TURN) 않아야 통과 */
const SM_ST_KO = { CONT: '매집 지속', STALL: '고점 후 정체', LEAVE: '이탈 진행', HEAVY: '이탈 심화', OUT: '순유출', NONE: '매집 이력 없음' };
const SM_TR_KO = { UP: '매집 가속', SLOW: '매집 둔화', DOWN: '매도 중', REBUY: '재매집', RESUME: '재개', TURN: '매도 전환', FLAT: '보합' };
function smGate(rows) {
  const by = {}; for (const r of rows || []) if (r && r.win) by[String(r.win)] = r;
  const fails = [], info = {};
  for (const [win, nm] of [['21', '1개월'], ['63', '3개월']]) {
    const r = by[win];
    if (!r) { fails.push(`스마트머니 ${nm} 자료 없음`); info[win] = null; continue; }
    info[win] = { st: r.st, lead: r.lead_nm || null, trend: r.lead_trend || null };
    if (r.st !== 'CONT' && r.st !== 'STALL') fails.push(`스마트머니 ${nm}: ${SM_ST_KO[r.st] || r.st}`);
    else if (r.lead_trend === 'DOWN' || r.lead_trend === 'TURN') fails.push(`스마트머니 ${nm}: 주도 ${r.lead_nm || '세력'} ${SM_TR_KO[r.lead_trend]}`);
  }
  return { ok: !fails.length, fails, info };
}

/* 점수(100): 무게 1위 기준봉 · 3개월 주도세력 추세 · 작은 시총 · 기준가에 가까운 정도 */
function score(sig) {
  const parts = {};
  parts.rk = sig.rk === 1 ? 10 : 5;
  const t3 = sig.sm && sig.sm['63'] && sig.sm['63'].trend;
  parts.sm = t3 === 'UP' || t3 === 'REBUY' || t3 === 'RESUME' ? 15 : t3 === 'FLAT' || t3 === 'SLOW' ? 8 : 0;
  parts.cap = sig.mcEok < 5000 ? 15 : sig.mcEok < 20000 ? 8 : 0;
  parts.near = Math.round(10 * Math.max(0, 1 - Math.abs(sig.gapPct || 0) / 6) * 10) / 10;
  return { total: Math.round((40 + parts.rk + parts.sm + parts.cap + parts.near) * 10) / 10, parts, ratio: 0 };
}

function reasons(sig) {
  const kind = sig.refKind === 'vwap' ? '평균가' : '시가';
  const r = [`${sig.barDate.slice(5)} 기준봉(양봉 +${(+sig.body || 0).toFixed(1)}% · 종가 상단 ${Math.round(sig.pos || 0)}% · 무게 ${(sig.w * 100).toFixed(0)}% · 거래대금 ${Math.round(sig.amtEok || 0).toLocaleString('ko-KR')}억) — 기준가(${kind}) ${Math.round(sig.ref).toLocaleString('ko-KR')}원`];
  r.push(`${sig.dipDate ? sig.dipDate.slice(5) + ' 종가가 기준가 아래로 빠진 뒤 ' : ''}현재가 ${sig.gapPct >= 0 ? '+' : ''}${sig.gapPct.toFixed(1)}%로 기준가를 돌파`);
  if (sig.sm) { const a = sig.sm['21'], b = sig.sm['63']; const f = x => (x ? `${SM_ST_KO[x.st] || x.st}${x.lead ? '·' + x.lead : ''}${x.trend ? ' ' + (SM_TR_KO[x.trend] || x.trend) : ''}` : '자료 없음'); r.push(`스마트머니 1개월 ${f(a)} / 3개월 ${f(b)}`); }
  r.push(`시총 ${Math.round(sig.mcEok).toLocaleString('ko-KR')}억 · 기준봉 후 ${sig.age}거래일째`);
  return r;
}

/* 보유 일수: 매수일(YYYY-MM-DD)부터 오늘까지 지난 거래일(오늘 포함 아님). isTradingDay(d) 로 주말·휴장 제외 */
function tradingDaysBetween(from, to, isTradingDay) {
  if (!from || !to || from >= to) return 0;
  let n = 0; const x = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  while (x < end) { x.setUTCDate(x.getUTCDate() + 1); if (x > end) break; if (isTradingDay(x.toISOString().slice(0, 10))) n++; }
  return n;
}

module.exports = { DEF, candleDays, levelsOf, levelState, todayBreak, smGate, SM_ST_KO, SM_TR_KO, score, reasons, tradingDaysBetween };
