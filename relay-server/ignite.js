'use strict';
/* 장초 상승 포착 전략("시동", 2026-11-25) — 순수 계산(네트워크·DB 없음)
   목표: 시가부터 이미 크게 뜬 종목이 아니라, 09시 이후 거래가 붙으며 오르기 시작하는 종목을 초입에서 잡는다.
   · 추적기(tracker): 서버가 KIS 시세(멀티시세: 현재가·시가·고가·누적 거래량·누적 거래대금)를 1~2분마다 읽어 종목별로 쌓는다
   · 평가(evaluate): 한 종목의 현재 값 + 쌓인 이력으로 조건을 판정하고, 통과 여부·사유·지표를 돌려준다
   조건(기본값은 auto-strategy.js SCHEMA 의 '장초 상승 포착' 묶음):
     ① 처음부터 너무 오른 종목 제외 — 갭(시가÷전일종가) ≤ gapMaxPct, 등락률 < chgMaxPct, 시가 대비 상승 openRiseMin~openRiseMax
     ② 출발 확인 — 현재가가 장 초반(09:00~09:05) 고가를 넘었음(이력이 없으면 당일 고가 부근) + 최근 riseWinMin 분 동안 riseMinPct% 이상 상승
     ③ 거래 붙음 — 최근 분당 거래대금이 그 전(09:00~)의 분당 평균의 amtSurge 배 이상 + 최근 분당 거래대금 ≥ minMinAmtKrw
     ④ 보조(optMin개 이상) — 당일 VWAP 위 · 고가 대비 눌림 얕음 · 체결강도 ≥ cttrMin · 프로그램 순매수 양수 */

const OPEN_MIN = 9 * 60, OR_END = OPEN_MIN + 5;   // 장 시작 · 장 초반 5분 끝(09:05)
const KEEP = 420;                                  // 종목당 보관 스냅샷 수(하루치 분 단위)

function createTracker() {
  const hist = new Map();   // code -> [{m(분), t(ms), p, amt, vol, hi, op}]
  return {
    /* rows: [{code, price, open, high, vol, amt}] (amt=누적 거래대금 원, vol=누적 거래량). min=KST 분(0~1439) */
    ingest(rows, nowMs, min) {
      for (const r of rows || []) {
        if (!r || !r.code || !(r.price > 0)) continue;
        let a = hist.get(r.code); if (!a) { a = []; hist.set(r.code, a); }
        const last = a[a.length - 1];
        const s = { m: min, t: nowMs, p: +r.price, amt: +r.amt || 0, vol: +r.vol || 0, hi: +r.high || +r.price, op: +r.open || 0 };
        if (last && last.m === min) a[a.length - 1] = s; else a.push(s);   // 같은 분은 마지막 값으로 덮음
        if (a.length > KEEP) a.shift();
      }
    },
    get: code => hist.get(code) || [],
    size: () => hist.size,
    reset() { hist.clear(); },
  };
}

/* min 분 이하에서 가장 가까운 스냅샷(없으면 null). tol 분 넘게 벌어지면 null */
function snapAtOrBefore(a, min, tol = 4) {
  for (let i = a.length - 1; i >= 0; i--) if (a[i].m <= min) return min - a[i].m <= tol ? a[i] : null;
  return null;
}

/* c: {code,name,price,open,high,changePct,vol,amt} · a: tracker.get(code) · min: 지금(KST 분) · P: 전략 조건값
   ext: {cttr, pgQty} 보조 조건용(선택). 반환 { pass, fails:[], unknown:[], m:{...지표}, partial } */
function evaluate(c, a, P, min, ext = {}) {
  const fails = [], unknown = [], m = {};
  const prevClose = c.changePct > -99 && c.price > 0 ? c.price / (1 + c.changePct / 100) : null;
  m.gapPct = c.open > 0 && prevClose > 0 ? (c.open / prevClose - 1) * 100 : null;
  m.openRise = c.open > 0 ? (c.price / c.open - 1) * 100 : null;
  m.chg = c.changePct;
  // ① 처음부터 너무 오른 종목 제외
  if (m.gapPct != null && m.gapPct > P.gapMaxPct) fails.push(`갭 ${m.gapPct.toFixed(1)}% (상한 ${P.gapMaxPct}%)`);
  if (!(c.changePct > 0)) fails.push(`등락률 ${(+c.changePct || 0).toFixed(1)}% (상승 아님)`);
  else if (c.changePct >= P.chgMaxPct) fails.push(`등락률 ${c.changePct.toFixed(1)}% (${P.chgMaxPct}% 이상은 이미 과열)`);
  if (m.openRise == null) unknown.push('시가 없음');
  else if (m.openRise < P.openRiseMin) fails.push(`시가 대비 ${m.openRise.toFixed(1)}% (최소 +${P.openRiseMin}%)`);
  else if (m.openRise > P.openRiseMax) fails.push(`시가 대비 ${m.openRise.toFixed(1)}% (최대 +${P.openRiseMax}%)`);
  // ② 출발 확인
  const early = a.filter(s => s.m <= OR_END);
  const orHigh = early.length && early[0].m >= OPEN_MIN - 1 ? Math.max(...early.map(s => s.hi)) : null;
  let partial = false;
  if (orHigh != null && min > OR_END) {
    m.orHigh = orHigh;
    if (!(c.price > orHigh)) fails.push(`장 초반 고가 ${Math.round(orHigh).toLocaleString('ko-KR')}원 미돌파`);
  } else if (c.high > 0) {   // 이력이 없으면(서버가 장중에 켜진 경우) 당일 고가 부근이어야 함
    partial = true; m.nearHigh = (c.price / c.high - 1) * 100;
    if (m.nearHigh < -1) fails.push(`당일 고가보다 ${Math.abs(m.nearHigh).toFixed(1)}% 아래(초반 고가 이력 없음)`);
  }
  const base = snapAtOrBefore(a, min - P.riseWinMin, 5);
  if (base) {
    m.riseWin = (c.price / base.p - 1) * 100;
    if (m.riseWin < P.riseMinPct) fails.push(`최근 ${P.riseWinMin}분 ${m.riseWin >= 0 ? '+' : ''}${m.riseWin.toFixed(1)}% (최소 +${P.riseMinPct}%)`);
  } else { unknown.push(`${P.riseWinMin}분 전 시세 없음`); partial = true; }
  // ③ 거래 붙음
  if (base && base.amt > 0 && c.amt > 0) {
    const w = Math.max(1, min - base.m), recent = (c.amt - base.amt) / w;   // 최근 분당 거래대금
    const before = Math.max(1, base.m - OPEN_MIN), prior = base.amt / before;   // 그 전 분당 평균(09:00~)
    m.minAmt = recent; m.amtRatio = prior > 0 ? recent / prior : null;
    if (!(recent >= P.minMinAmtKrw)) fails.push(`분당 거래대금 ${Math.round(recent / 1e4).toLocaleString('ko-KR')}만 (최소 ${Math.round(P.minMinAmtKrw / 1e4).toLocaleString('ko-KR')}만)`);
    if (m.amtRatio == null || m.amtRatio < P.amtSurge) fails.push(`거래대금 ${m.amtRatio == null ? '–' : m.amtRatio.toFixed(1)}배 (최소 ${P.amtSurge}배)`);
  } else unknown.push('거래대금 이력 없음');
  // ④ 보조
  const opt = [];
  const vwap = c.vol > 0 && c.amt > 0 ? c.amt / c.vol : null;
  if (vwap) { m.vwapGap = (c.price / vwap - 1) * 100; opt.push(['VWAP 위', c.price > vwap]); }
  if (c.high > 0) { m.pullback = (c.price / c.high - 1) * 100; opt.push(['고가 근처', m.pullback >= -P.pullbackMaxPct]); }
  if (ext.cttr != null) { m.cttr = ext.cttr; opt.push([`체결강도 ${Math.round(ext.cttr)}%`, ext.cttr >= P.cttrMin]); }
  if (ext.pgQty != null) { m.pgQty = ext.pgQty; opt.push(['프로그램 순매수', ext.pgQty > 0]); }
  m.optMet = opt.filter(x => x[1]).map(x => x[0]); m.optMissing = opt.filter(x => !x[1]).map(x => x[0]);
  const need = Math.min(P.optMin, opt.length || P.optMin);
  if (m.optMet.length < need) fails.push(`보조 ${m.optMet.length}/${P.optMin} (${m.optMissing.join('·') || '자료 없음'} 부족)`);
  return { pass: !fails.length && !unknown.some(u => /거래대금 이력|시세 없음/.test(u)), fails, unknown, m, partial };
}

/* 점수(100): 거래 붙는 속도 40 · 상승 시작 강도 30 · 보조 20 · 덜 오른 정도 10 */
function score(m, P) {
  const cl = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  const sAmt = 40 * cl(m.amtRatio || 0, P.amtSurge, P.amtSurge * 3);
  const sRise = 30 * cl(m.riseWin || 0, P.riseMinPct, P.riseMinPct * 4);
  const nOpt = (m.optMet || []).length + (m.optMissing || []).length;
  const sOpt = 20 * ((m.optMet || []).length / Math.max(1, nOpt));
  const sLow = 10 * (1 - cl(m.chg || 0, 2, P.chgMaxPct));
  const parts = { amt: sAmt, rise: sRise, opt: sOpt, low: sLow };
  return { total: Math.round((sAmt + sRise + sOpt + sLow) * 10) / 10, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])), ratio: 0 };
}

function reasons(m, P) {
  const r = [];
  if (m.riseWin != null) r.push(`최근 ${P.riseWinMin}분 +${m.riseWin.toFixed(1)}%`);
  if (m.amtRatio != null) r.push(`거래대금 ${m.amtRatio.toFixed(1)}배(분당 ${Math.round(m.minAmt / 1e4).toLocaleString('ko-KR')}만)`);
  if (m.orHigh) r.push('장 초반 고가 돌파');
  if (m.optMet && m.optMet.length) r.push(m.optMet.join('·'));
  if (m.openRise != null) r.push(`시가 대비 +${m.openRise.toFixed(1)}%`);
  return r;
}

module.exports = { createTracker, evaluate, score, reasons, snapAtOrBefore, OPEN_MIN, OR_END };
