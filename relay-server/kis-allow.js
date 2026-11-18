'use strict';
/* 실거래 전환 3단계(2026-11-18) — 계좌·주문용 KIS 호출 허용목록.
   kis-order.js 가 쓰는 kisGet/kisPost 를 이 목록으로 감싼다. 목록에 없는 (방식·경로·TR_ID) 조합은 KIS 로 나가기 전에 막는다.
   → 계좌 현황 화면과 대사는 "조회"만 하고, 이체·출금·입금·대출 같은 돈을 옮기는 API 는 코드가 실수로 불러도 나갈 수 없다.
   새 KIS 계좌 API 를 쓰려면 여기에 한 줄을 추가해야 하고, 테스트(kis-allow.test.js)가 그 목록을 고정해 둔다. */
const B = '/uapi/domestic-stock/v1/trading/';
const ALLOW = Object.freeze([
  { m: 'GET',  path: B + 'inquire-balance',     tr: 'TTTC8434R', what: '잔고·예수금 조회' },
  { m: 'GET',  path: B + 'inquire-daily-ccld',  tr: 'TTTC0081R', what: '일별 주문·체결 조회' },
  { m: 'GET',  path: B + 'inquire-psbl-order',  tr: 'TTTC8908R', what: '매수 가능 금액 조회' },
  { m: 'POST', path: B + 'order-cash',          tr: 'TTTC0012U', what: '현금 매수 주문' },
  { m: 'POST', path: B + 'order-cash',          tr: 'TTTC0011U', what: '현금 매도 주문' },
  { m: 'POST', path: B + 'order-rvsecncl',      tr: 'TTTC0013U', what: '주문 정정·취소' },
]);
const key = (m, p, t) => `${m} ${p} ${t}`;
const SET = new Set(ALLOW.map(a => key(a.m, a.path, a.tr)));
const isAllowed = (m, p, t) => SET.has(key(m, p, t));
function blocked(m, p, t) { const e = new Error(`허용되지 않은 KIS 호출 차단: ${m} ${p} ${t}`); e.code = 'BLOCKED'; return e; }

/* get/post 를 감싼 새 함수 쌍. 막히면 KIS 로 아무것도 보내지 않고 code='BLOCKED' 오류 */
function guardKis({ kisGet, kisPost }) {
  return {
    kisGet: kisGet && (async (path, tr, params, opts) => { if (!isAllowed('GET', path, tr)) throw blocked('GET', path, tr); return kisGet(path, tr, params, opts); }),
    kisPost: kisPost && (async (path, tr, body) => { if (!isAllowed('POST', path, tr)) throw blocked('POST', path, tr); return kisPost(path, tr, body); }),
  };
}
module.exports = { ALLOW, isAllowed, guardKis };
