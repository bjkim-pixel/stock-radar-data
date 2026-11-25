'use strict';
/* 인버스·사이드카 전략(2026-11-26) — 순수 계산(네트워크·DB 없음). 근거: 191(인버스)·192(사이드카)·193(사이드카 대리 신호) 연구
     A 하락 국면 보유 : KODEX200(069500) 현재가 < 60일선이면 인버스를 15:10 에 사서, 60일선 위로 올라오면 15:05~15:20 에 판다
     B 외국인 동반 순매도 : 어제 외국인이 코스피 현물과 코스피200 선물을 둘 다 순매도 → 오늘 장 초반 인버스(2X) 시장가, 15:15 청산
     C 매도 사이드카 반등 : 사이드카가 난 날(또는 KODEX200 이 −x% 이하) 15:10 에 지수 ETF 매수 → 이틀째 15:15 정리(하락 국면이면 다음날)
   매수 사이드카 → 인버스는 근거가 없어 전략으로 만들지 않는다(가상 신호 기록만). */

const DEF = Object.freeze({ maDays: 60, dropPct: 4, holdDays: 2, regimeCode: '069500' });

/* 상품표: lev = 배율. 단일종목 상품도 같은 규칙으로 쓸 수 있게 넣어 둠 */
const PRODUCTS = Object.freeze({
  '114800': { name: 'KODEX 인버스', lev: 1, inv: true },
  '252670': { name: 'KODEX 200선물인버스2X', lev: 2, inv: true },
  '251340': { name: 'KODEX 코스닥150선물인버스', lev: 1, inv: true },
  '0197X0': { name: 'SOL SK하이닉스단일종목인버스2X', lev: 2, inv: true },
  '069500': { name: 'KODEX 200', lev: 1, inv: false },
  '122630': { name: 'KODEX 레버리지', lev: 2, inv: false },
  '494310': { name: 'KODEX 반도체레버리지', lev: 2, inv: false },
});
const productName = code => (PRODUCTS[code] && PRODUCTS[code].name) || code;
const levOf = code => (PRODUCTS[code] && PRODUCTS[code].lev) || 1;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

/* 이동평균: 어제까지 종가(prevCloses, 오름차순) 마지막 n−1개 + 오늘 현재가 → n일선. 자료가 모자라면 null */
function ma(prevCloses, live, n = DEF.maDays) {
  const c = (prevCloses || []).map(Number).filter(x => x > 0);
  if (!(live > 0) || c.length < n - 1) return null;
  return mean(c.slice(c.length - (n - 1)).concat([live]));
}

/* 하락 국면: 현재가 < n일선 */
function regime(prevCloses, live, n = DEF.maDays) {
  const m = ma(prevCloses, live, n);
  if (m == null) return { ok: false, on: false, ma: null, gapPct: null };
  return { ok: true, on: live < m, ma: m, gapPct: (live / m - 1) * 100 };
}

/* B: 외국인 코스피 현물·선물 둘 다 순매도(억원). 둘 중 하나라도 자료가 없으면 신호 아님 */
function flowSignal(spot, fut) {
  if (spot == null || fut == null || !Number.isFinite(+spot) || !Number.isFinite(+fut)) return { ok: false, on: false };
  return { ok: true, on: +spot < 0 && +fut < 0, spot: +spot, fut: +fut };
}

/* C: 사이드카(매도) 발동 기록이 오늘 있거나, KODEX200 등락률이 −dropPct% 이하 */
function sidecarSignal({ sellToday, chgPct, dropPct = DEF.dropPct }) {
  const via = sellToday ? 'event' : (chgPct != null && chgPct <= -Math.abs(dropPct)) ? 'drop' : null;
  return { on: !!via, via };
}

/* C 보유일: 하락 국면이면 다음날(1), 아니면 holdDays(2) */
const holdDaysC = (regimeOn, hold = DEF.holdDays) => (regimeOn ? 1 : Math.max(1, Math.round(hold)));

/* 손절 기본값: 1배 5%, 2배 10%(C) · A 는 7%(종가 마감) · B 는 4% */
const stopDefault = (mode, code) => (mode === 'regime' ? 7 : mode === 'flow' ? 4 : levOf(code) >= 2 ? 10 : 5);

/* 포지션 꼬리표: 엔진이 전략 간 공유라 계획(plan.tag)에 붙여 둔다 — A, B, C1, C2 */
const tagOf = (mode, days) => (mode === 'regime' ? 'A' : mode === 'flow' ? 'B' : `C${days === 1 ? 1 : 2}`);
const tagDays = tag => (/^C[12]$/.test(tag || '') ? +tag[1] : 0);

function reasons(mode, sig) {
  const r = [];
  if (mode === 'regime') r.push(`코스피200(KODEX 200) ${Math.round(sig.price).toLocaleString('ko-KR')}원이 ${sig.n}일선 ${Math.round(sig.ma).toLocaleString('ko-KR')}원보다 ${Math.abs(sig.gapPct).toFixed(1)}% 아래 — 하락 국면`, '60일선 위로 올라오면 정리');
  else if (mode === 'flow') r.push(`어제 외국인 코스피 현물 ${Math.round(sig.spot).toLocaleString('ko-KR')}억 · 선물 ${Math.round(sig.fut).toLocaleString('ko-KR')}억 동반 순매도`, '장 초반 매수 → 15:15 청산');
  else r.push(sig.via === 'event' ? '오늘 매도 사이드카 발동 기록' : `KODEX 200 ${sig.chgPct.toFixed(1)}% (사이드카 대리 신호: −${sig.dropPct}% 이하)`, sig.days === 1 ? '하락 국면이라 다음날 15:15 정리' : '이틀째 15:15 정리');
  return r;
}

module.exports = { DEF, PRODUCTS, productName, levOf, ma, regime, flowSignal, sidecarSignal, holdDaysC, stopDefault, tagOf, tagDays, reasons };
