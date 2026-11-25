'use strict';
/* 눌림목 매매("무게 신고 막대 → 평균가 첫 재터치", 2026-11-26) — 순수 계산(네트워크·DB 없음)
   근거: 189·190 연구(pullback_study.md 3차). 규칙
     막대   = 그날 무게/주식수(w) ≥ wMin(0.3) · 상승 · 그때까지의 신고 무게 · 시총 ≥ capMin(1000억)
     평균가 = 막대일 거래대금 ÷ 거래량(vw)
     매수   = 막대 다음 날 이후 "처음" 평균가 부근을 다시 밟은 날의 종가 — 저가 ≤ vw×(1+touch) 이고 종가 ≥ vw×(1−touch), 막대 +2거래일 이후부터 maxAge 거래일 안
     손절   = 평균가 −stopBelow% 아래 종가 마감 · 익절 +8/+12 2분할 · holdDays 거래일 시간 청산
   과거 일봉만 보고 계산 → 장중에는 오늘 시세를 "오늘 봉"으로 붙여서 같은 규칙으로 판정한다 */

const DEF = Object.freeze({ wMin: 0.3, capMinEok: 1000, touchPct: 3, maxAge: 30, stopBelowPct: 5, holdDays: 10, smBuy: false, upOnly: false, capMaxEok: 0, minAmtEok: 0 });
const EOK = 1e8;

/* 막대 찾기. rows = 무게 ≥ wMin 인 날들(오름차순): [{code, d, w, chg, mc}] — 같은 종목 안에서 "이전 최대 무게"보다 큰 날만 신고 */
function findBars(rows, P = {}) {
  const o = { ...DEF, ...P }, by = new Map();
  for (const r of rows || []) { if (!r || !r.code || !(r.w >= o.wMin)) continue; let a = by.get(r.code); if (!a) by.set(r.code, a = []); a.push(r); }
  const out = [];
  for (const [code, a] of by) {
    a.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
    let run = -Infinity;
    for (const r of a) {
      if (r.w > run && r.chg > 0 && r.mc >= o.capMinEok * EOK) out.push({ code, d: r.d, w: r.w, chg: r.chg, mc: r.mc });
      if (r.w > run) run = r.w;
    }
  }
  return out;
}

/* 한 막대의 상태. hist = 그 종목의 막대일 이후(막대 포함, 오늘 제외) 일봉 오름차순 [{d,o,h,l,c,v,a}] — hist[0] 이 막대일.
   반환 { vw, age(막대 이후 지난 거래일, 오늘 포함), touched(오늘 전에 이미 재터치한 날), broken(종가가 손절선 아래로 마감한 적), ok(감시 대상) } */
function barState(hist, P = {}) {
  const o = { ...DEF, ...P };
  if (!hist || !hist.length) return null;
  const b = hist[0];
  if (!(b.v > 0) || !(b.a > 0)) return null;
  const vw = b.a / b.v, hi = vw * (1 + o.touchPct / 100), lo = vw * (1 - o.touchPct / 100), stop = vw * (1 - o.stopBelowPct / 100);
  let touched = null, broken = null;
  for (let j = 2; j < hist.length; j++) {   // 막대 +2거래일부터가 매수 후보(막대 다음 날은 제외)
    const x = hist[j];
    if (touched == null && x.l <= hi && x.c >= lo) touched = x.d;
  }
  for (let j = 1; j < hist.length; j++) if (hist[j].c < stop) { broken = hist[j].d; break; }
  const age = hist.length;   // 오늘이 막대 + age 번째 거래일(hist 에 막대부터 어제까지 들어 있으므로 age = hist.length)
  return { vw, stop, hi, lo, age, touched, broken, ok: age >= 2 && age <= o.maxAge && !touched };
}

/* 오늘 봉(장중 시세)이 재터치 조건을 채웠는지. live = {price, low} */
function todayTouch(st, live, P = {}) {
  const o = { ...DEF, ...P };
  if (!st || !live || !(live.price > 0)) return false;
  const low = live.low > 0 ? Math.min(live.low, live.price) : live.price;
  return low <= st.hi && live.price >= st.lo;
}

/* 점수(100): 상한가 막대 · 막대일 외+기 순매수 · 작은 시총 · 평균가에 가까운 정도 */
function score(sig) {
  let s = 40;
  const parts = {};
  parts.up = sig.up30 ? 20 : 0;
  parts.sm = sig.smBuy ? 15 : sig.smBuy === false ? 0 : 5;
  parts.cap = sig.mcEok < 5000 ? 15 : sig.mcEok < 20000 ? 8 : 0;
  parts.near = Math.round(10 * Math.max(0, 1 - Math.abs(sig.gapPct || 0) / 3) * 10) / 10;
  s += parts.up + parts.sm + parts.cap + parts.near;
  return { total: Math.round(s * 10) / 10, parts, ratio: 0 };
}

function reasons(sig) {
  const r = [`${sig.barDate.slice(5)} 무게 신고 막대(무게 ${(sig.w * 100).toFixed(1)}% · ${sig.chg >= 29 ? '상한가' : `+${sig.chg.toFixed(1)}%`})`];
  r.push(`막대일 평균가 ${Math.round(sig.vw).toLocaleString('ko-KR')}원 첫 재터치(현재가 ${sig.gapPct >= 0 ? '+' : ''}${sig.gapPct.toFixed(1)}%)`);
  if (sig.smBuy != null) r.push(`막대일 외+기 ${sig.smEok >= 0 ? '+' : ''}${Math.round(sig.smEok).toLocaleString('ko-KR')}억`);
  r.push(`시총 ${Math.round(sig.mcEok).toLocaleString('ko-KR')}억 · 막대 후 ${sig.age}거래일째`);
  return r;
}

/* 보유 일수: 매수일(YYYY-MM-DD)부터 오늘까지 지난 거래일(오늘 포함 아님). isTradingDay(d) 로 주말·휴장 제외 */
function tradingDaysBetween(from, to, isTradingDay) {
  if (!from || !to || from >= to) return 0;
  let n = 0; const x = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  while (x < end) { x.setUTCDate(x.getUTCDate() + 1); if (x > end) break; if (isTradingDay(x.toISOString().slice(0, 10))) n++; }
  return n;
}

module.exports = { DEF, findBars, barState, todayTouch, score, reasons, tradingDaysBetween };
