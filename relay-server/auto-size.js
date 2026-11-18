'use strict';
/* 실거래 전환 2단계(2026-11-18) — 종목당 매수 금액 자동 조정(기획안 C-2)과 이상 동작 차단(C2) 계산. 입력만 보고 답을 내는 함수들.

   ① sizeOf: 종목당 금액
      · 고정(fixed): 전략의 종목당 금액(시장 상태 조절이 이미 반영된 값)
      · 잔고 기준(balance): 운용 자금 × 비중 × 시장 상태 배수
          운용 자금 = 미수 없이 살 수 있는 금액(실제 계좌, 가상이면 가상 운용 자금 − 가상 보유 원가) + 자동매매 보유 평가액
          비중 = 설정값(%) 또는 1 ÷ 하루 최대 매수 종목 수
      · 두 방식 모두 상한 = min(지금 살 수 있는 금액, 1회 오작동 상한) · 1만 원 단위 내림
      · 하한: 최소 주문 금액보다 작으면 사지 않고 사유를 남김(1주도 못 사는 경우는 주문 계산에서 걸러짐)
   ② 이상 동작 차단(실전·드라이런 전략만): 전략·날짜별 기록 g = run.payload.gate
      { orders, rejects, unsure, bought:{code:true}, halted:{why,at}|null }
      · 종목당 하루 1회(한 주라도 산 종목은 다시 사지 않음 — 못 산 종목의 재시도는 허용)
      · 하루 주문 횟수 상한(정정 포함)
      · 주문 거부 N번·접수 확인 실패(KIS 응답 없음) N번이면 그날 그 전략 정지(신규 매수만 — 손절·익절은 엔진이 계속) */

const floor1 = v => Math.floor(v / 10000) * 10000;
const won = v => Math.round(v).toLocaleString('ko-KR');

function sizeOf(i) {
  const mult = i.mult > 0 ? i.mult : 1, minKrw = i.minKrw > 0 ? i.minKrw : 100000, real = i.cash != null;
  if (real && !(i.cash >= 0)) return { skip: '주문 가능 금액을 확인하지 못했습니다' };
  const caps = [];
  if (i.capKrw > 0) caps.push(['1회 오작동 상한', i.capKrw]);
  let target, capital = null, weight = null, cash = real ? i.cash : null;
  if (i.mode === 'balance') {
    if (!real) cash = Math.max(0, (i.paperCapital || 0) - (i.paperUsed || 0));   // 가상: 가상 운용 자금에서 이미 쓴 만큼 뺀 값
    capital = cash + Math.max(0, i.autoValue || 0);
    weight = i.pct > 0 ? i.pct / 100 : 1 / Math.max(1, i.maxBuys || 1);
    target = capital * weight * mult;
  } else target = +i.fixedKrw || 0;
  if (cash != null) caps.push(['주문 가능 금액', cash]);
  let krw = target, capBy = null;
  for (const [k, v] of caps) if (v < krw) { krw = v; capBy = k; }
  krw = floor1(krw);
  if (!(krw >= minKrw)) {
    const why = capBy === '주문 가능 금액' ? `주문 가능 금액 부족(${won(cash)}원 · 최소 주문 ${won(minKrw)}원)`
      : `계산된 금액 ${won(krw)}원이 최소 주문 금액 ${won(minKrw)}원보다 작음${capital != null ? `(운용 자금 ${won(capital)}원 × 비중 ${Math.round(weight * 1000) / 10}%${mult < 1 ? ` × 시장 상태 ${Math.round(mult * 100)}%` : ''})` : ''}`;
    return { skip: why, target: Math.round(target), cash, capital };
  }
  return { krw, target: Math.round(target), capBy, cash, capital, weight, mult };
}
/* 알림·기록용 한 줄 */
function sizeText(z, mode) {
  if (!z || z.skip) return z ? z.skip : '';
  const base = mode === 'balance' && z.capital != null ? `운용 자금 ${won(z.capital)}원 × ${Math.round(z.weight * 1000) / 10}%${z.mult < 1 ? ` × 시장 상태 ${Math.round(z.mult * 100)}%` : ''}` : '고정 금액';
  return `${base} → ${won(z.krw)}원${z.capBy ? ` (${z.capBy}에 맞춤)` : ''}`;
}

const gate0 = () => ({ orders: 0, rejects: 0, unsure: 0, bought: {}, halted: null });
/* 주문 전: 막을 이유(문자열) 또는 null */
function gateCheck(g, code, lim) {
  g = g || gate0();
  if (g.halted) return `오늘 이 전략 정지 중 — ${g.halted.why}`;
  if (g.bought && g.bought[code]) return '종목당 하루 1회 — 오늘 이미 산 종목';
  if ((g.orders || 0) >= (lim.maxOrdersDay || 20)) return `하루 주문 횟수 상한(${lim.maxOrdersDay || 20}번)에 닿음`;
  return null;
}
/* 주문 뒤 기록. ev: 'order'(접수) · 'modify'(정정) · 'reject'(거부·실패) · 'unsure'(응답 없음) · 'filled'(한 주라도 체결).
   반환: 이번에 전략을 정지시켰으면 그 사유 */
function gateAfter(g, ev, code, lim, nowMs) {
  if (ev === 'order' || ev === 'modify' || ev === 'unsure' || ev === 'reject') g.orders = (g.orders || 0) + 1;
  if (ev === 'reject') g.rejects = (g.rejects || 0) + 1;
  if (ev === 'unsure') g.unsure = (g.unsure || 0) + 1;
  if (ev === 'filled' && code) { g.bought = g.bought || {}; g.bought[code] = true; }
  if (g.halted) return null;
  let why = null;
  if ((g.rejects || 0) >= (lim.rejectStop || 3)) why = `주문 거부 ${g.rejects}번`;
  else if ((g.unsure || 0) >= (lim.unsureStop || 2)) why = `접수 확인 실패(KIS 응답 없음) ${g.unsure}번`;
  if (why) g.halted = { why, at: nowMs || Date.now() };
  return why;
}

module.exports = { sizeOf, sizeText, gate0, gateCheck, gateAfter };
