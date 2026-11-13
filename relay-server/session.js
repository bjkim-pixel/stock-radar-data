'use strict';
/* ════════════════════════════════════════════════════════════════════════
   거래 세션 판단 (매매 8단계 · NXT·시간외 확장, 2026-11-13) — 순수 함수, 네트워크 없음
   가상(paper.js)·실전(live.js)·시세(trade.js)·화면이 모두 이 판단 하나만 씁니다.
   근거(2026-11-13 확인)
   · NXT: 프리마켓 08:00~08:50 · 메인마켓 09:00~15:20 · 애프터마켓 15:40~20:00. NXT 주문은 20:00까지 유지
   · KRX: 정규장 09:00~15:30(15:20~15:30 종가 단일가) · 2026-09-14부터 애프터마켓 16:00~20:00(접속매매, ETF·ETN·관리·투자경고·위험·정리매매 제외)
     KRX 정규장 미체결은 애프터마켓으로 이어지지 않음(15:30 소멸)
   · 프리·애프터마켓은 시장가 주문 불가(지정가만)
   · KIS 시세 시장구분 J=KRX · NX=NXT · UN=통합, 주문 거래소 구분 KRX · NXT · SOR
   info: { nxt: true|false|null (stocks.nxt_ok, null 은 KRX 만으로 봄), etf: bool, warnings: [..] }
   ════════════════════════════════════════════════════════════════════════ */
const M = (h, m) => h * 60 + m;
const T = {
  START: M(8, 0), PRE_END: M(8, 50), REG: M(9, 0), NXT_MAIN_END: M(15, 20), KRX_CLOSE: M(15, 30),
  NXT_AFTER: M(15, 40), KRX_AFTER: M(16, 0), END: M(20, 0), SETTLE: M(20, 5),
};
const KRX_AFTER_BLOCK = ['관리종목', '투자경고', '투자위험', '정리매매'];

const closed = (reason, mkt) => ({ open: false, name: 'closed', label: '주문 불가', reason, venue: null, market: false, mkt });
const open = (name, label, venue, market, mkt) => ({ open: true, name, label, reason: null, venue, market, mkt });

/* 그 종목이 KRX 애프터마켓(16~20시) 대상인지 */
function krxAfterOk(info) {
  if (!info || info.etf) return false;
  return !(info.warnings || []).some(w => KRX_AFTER_BLOCK.includes(w));
}

/* min: KST 0시부터 분. 반환 { open, name, label, reason, venue(주문 거래소), market(시장가 허용), mkt(시세 시장구분) } */
function sessionOf(min, info) {
  const nxt = !!(info && info.nxt);
  const idle = nxt ? 'UN' : 'J';
  if (min < T.START || min >= T.END) return closed('거래 시간이 아닙니다(08:00~20:00)', idle);
  if (min < T.PRE_END) return nxt ? open('pre', 'NXT 프리마켓', 'NXT', false, 'NX')
    : closed('NXT 거래 대상이 아닌 종목이라 09:00 정규장부터 주문할 수 있습니다', 'J');
  if (min < T.REG) return closed('08:50~09:00 에는 주문할 수 없습니다(NXT 프리마켓 종료 · 정규장 시작 전)', idle);
  if (min < T.NXT_MAIN_END) return nxt ? open('regular', '정규장(KRX+NXT)', 'SOR', true, 'UN') : open('regular', '정규장(KRX)', 'KRX', true, 'J');
  if (min < T.KRX_CLOSE) return open('close', 'KRX 종가 단일가', 'KRX', true, 'J');
  if (min < T.NXT_AFTER) return closed('15:30~15:40 에는 주문할 수 없습니다(정규장 종료 · 애프터마켓 시작 전)', idle);
  if (min < T.KRX_AFTER) return nxt ? open('after', 'NXT 애프터마켓', 'NXT', false, 'NX')
    : closed('NXT 거래 대상이 아닌 종목이라 16:00 KRX 애프터마켓부터 주문할 수 있습니다', 'J');
  if (nxt) return open('after', '애프터마켓(KRX+NXT)', 'SOR', false, 'UN');
  if (info && !krxAfterOk(info)) return closed('KRX 애프터마켓 대상이 아닌 종목입니다(ETF·ETN·관리·투자경고·위험·정리매매)', 'J');
  return open('after', 'KRX 애프터마켓', 'KRX', false, 'J');
}

/* 익절(대기 지정가) 주문을 낼 거래소. NXT 종목은 하루 종일 NXT(20:00까지 유지되므로 세션이 바뀌어도 다시 낼 필요 없음),
   KRX 종목은 KRX(정규장분은 15:30 소멸 → 16:00 애프터마켓에서 다시 냄). 지금 그 거래소가 주문을 받지 않으면 null */
function restVenue(min, info) {
  const s = sessionOf(min, info);
  if (!s.open) return null;
  if (info && info.nxt) return s.name === 'close' ? null : 'NXT';
  return 'KRX';
}

/* 그 거래소에 걸린 주문이 언제 소멸하는지(분). KRX 는 정규장 주문이면 15:30, 애프터마켓 주문이면 20:00. NXT·SOR 는 20:00 */
function expiryOf(venue, createdMin) {
  if (venue === 'KRX' && createdMin < T.KRX_CLOSE) return T.KRX_CLOSE;
  return T.END;
}

/* 시장가를 못 쓰는 시간의 손절 지정가: 매수 1호가에서 ticks 호가 아래(하한가 이상). tickOf 는 paper-engine 의 것 */
function stopLimitPrice(q, ticks, tickOf, floorTick) {
  const bid = ((q.bids || []).find(l => l.p > 0 && l.q > 0) || {}).p || q.price || 0;
  let p = bid;
  for (let i = 0; i < ticks && p > 0; i++) p -= tickOf(Math.max(1, p - 1));
  p = floorTick(Math.max(1, p));
  if (q.lower > 0) p = Math.max(p, q.lower);
  return p;
}

module.exports = { T, sessionOf, restVenue, expiryOf, krxAfterOk, stopLimitPrice };
