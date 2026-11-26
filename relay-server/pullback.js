'use strict';
/* 눌림목 매매("무게 1·2위일 가격 회복", 2026-11-26 규칙 교체) — 순수 계산(네트워크·DB 없음)
   관찰   = 최근 maxAge 거래일(≈3개월) 안에 "무게/주식수 역대 1위일·2위일"(record_wt)이 있는 종목 · 시총 ≥ capMin
   기준가 = 그 1·2위일의 평균가(거래대금 ÷ 거래량)
   무장   = 그 뒤 종가가 기준가 −dipPct% 밑으로 내려간 적이 있고, 그 뒤 기준가 +breakPct% 위로 종가 마감한 적은 없음(= 아직 기준가를 못 되찾은 눌림 상태)
   수급   = 종목상세 스마트머니 매집·이탈(smx_state) 1개월·3개월 모두 "매집 지속/정체"이고 주도 세력 추세가 팔고 있지 않을 것(주도세력 미이탈)
   매수   = 무장 상태에서 오늘 현재가가 기준가 +breakPct% 이상으로 완전히 돌파(단 +chasePct% 까지 — 이미 너무 튄 건 쫓지 않음) → 15:10 시장가
   손절 −stopBelow%(종가 마감) · 익절 +8/+12 2분할 · holdDays 거래일 시간 청산은 전략 공통 설정 */

const DEF = Object.freeze({ wMin: 0.1, capMinEok: 1000, maxAge: 63, dipPct: 2, breakPct: 1, chasePct: 6, stopBelowPct: 5, holdDays: 10, smGate: true, capMaxEok: 0, minAmtEok: 0 });
const EOK = 1e8;

/* record_wt 행 → 관찰 후보 수준. rows = [{code, rk, trade_date, w, trade_amount, volume, change_pct}] . 평균가 없는 행·무게 하한 미만은 버린다 */
function levels(rows, P = {}) {
  const o = { ...DEF, ...P }, out = [];
  for (const r of rows || []) {
    if (!r || !r.code) continue;
    const w = +r.w, a = +r.trade_amount, v = +r.volume, d = String(r.trade_date || '').slice(0, 10);
    if (!(w >= o.wMin) || !(a > 0) || !(v > 0) || !d) continue;
    out.push({ code: r.code, rk: +r.rk || 0, d, w, chg: +r.change_pct || 0, vw: a / v });
  }
  return out;
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

/* 점수(100): 1위일 · 3개월 주도세력 추세 · 작은 시총 · 기준가에 가까운 정도 */
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
  const r = [`${sig.barDate.slice(5)} 무게/주식수 ${sig.rk}위일(무게 ${(sig.w * 100).toFixed(1)}% · ${sig.chg >= 29 ? '상한가' : `${sig.chg >= 0 ? '+' : ''}${sig.chg.toFixed(1)}%`}) — 그날 평균가 ${Math.round(sig.vw).toLocaleString('ko-KR')}원`];
  r.push(`${sig.dipDate ? sig.dipDate.slice(5) + ' 종가가 평균가 아래로 빠진 뒤 ' : ''}현재가 ${sig.gapPct >= 0 ? '+' : ''}${sig.gapPct.toFixed(1)}%로 평균가를 돌파`);
  if (sig.sm) { const a = sig.sm['21'], b = sig.sm['63']; const f = x => (x ? `${SM_ST_KO[x.st] || x.st}${x.lead ? '·' + x.lead : ''}${x.trend ? ' ' + (SM_TR_KO[x.trend] || x.trend) : ''}` : '자료 없음'); r.push(`스마트머니 1개월 ${f(a)} / 3개월 ${f(b)}`); }
  r.push(`시총 ${Math.round(sig.mcEok).toLocaleString('ko-KR')}억 · ${sig.age}거래일째`);
  return r;
}

/* 보유 일수: 매수일(YYYY-MM-DD)부터 오늘까지 지난 거래일(오늘 포함 아님). isTradingDay(d) 로 주말·휴장 제외 */
function tradingDaysBetween(from, to, isTradingDay) {
  if (!from || !to || from >= to) return 0;
  let n = 0; const x = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  while (x < end) { x.setUTCDate(x.getUTCDate() + 1); if (x > end) break; if (isTradingDay(x.toISOString().slice(0, 10))) n++; }
  return n;
}

module.exports = { DEF, levels, levelState, todayBreak, smGate, SM_ST_KO, SM_TR_KO, score, reasons, tradingDaysBetween };
