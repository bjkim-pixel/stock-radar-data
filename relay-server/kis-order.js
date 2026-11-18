'use strict';
/* ════════════════════════════════════════════════════════════════════════
   KIS 실전 주문 어댑터 (매매 6단계) — 이 파일만 KIS 주문 API 를 부릅니다.
   규격: 한국투자증권 공식 예제 저장소 koreainvestment/open-trading-api (examples_llm/domestic_stock) 확인, 2026-11-13
     · 현금 주문   POST /uapi/domestic-stock/v1/trading/order-cash        매수 TTTC0012U · 매도 TTTC0011U (구 TTTC0802U/0801U 는 차단 예정)
     · 정정·취소   POST /uapi/domestic-stock/v1/trading/order-rvsecncl    TTTC0013U (RVSE_CNCL_DVSN_CD 01=정정 02=취소, QTY_ALL_ORD_YN Y=잔량 전부)
     · 일별 주문체결 GET /uapi/domestic-stock/v1/trading/inquire-daily-ccld TTTC0081R (3개월 이내)
     · 잔고        GET /uapi/domestic-stock/v1/trading/inquire-balance     TTTC8434R
     · 매수가능조회 GET /uapi/domestic-stock/v1/trading/inquire-psbl-order  TTTC8908R (2026-11-18 추가 — 공식 예제 inquire_psbl_order 규격, 실제 응답은 4단계 수동 점검에서 확인)
     · 주문구분 ORD_DVSN 00=지정가 01=시장가 · 거래소 EXCG_ID_DVSN_CD=KRX · 값은 모두 문자열 · hashkey 는 선택(공식 예제도 생략)
   · 8단계(2026-11-13): 거래소 구분 EXCG_ID_DVSN_CD = KRX · NXT · SOR (공식 예제 order_rvsecncl 설명 'KRX: 한국거래소, NXT:대체거래소, SOR:SOR').
     주문마다 보낸 거래소를 live.js 가 저장하고 취소할 때 같은 값을 씀
   주문 요청은 절대 자동 재시도하지 않습니다(응답을 못 받으면 '확인 필요' 로 두고 체결조회로 대조).
   계좌번호는 Render 환경변수(KIS_ACCOUNT_NO 8자리, KIS_ACCOUNT_PRDT 2자리)로만 받고 로그·응답에 남기지 않습니다.
   ════════════════════════════════════════════════════════════════════════ */
const n = v => { const x = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
const VENUES = new Set(['KRX', 'NXT', 'SOR']);
const venueOf = v => { const x = String(v || 'KRX').toUpperCase(); if (!VENUES.has(x)) { const e = new Error('bad venue'); e.code = 'REJECT'; throw e; } return x; };
const up = o => { const r = {}; for (const k of Object.keys(o || {})) r[k.toUpperCase()] = o[k]; return r; };

function createKisOrder({ kisGet, kisPost, account }) {
  const acct = () => {
    const c = String(account && account.cano || ''), p = String(account && account.prdt || '');
    if (!/^\d{8}$/.test(c) || !/^\d{2}$/.test(p)) { const e = new Error('account not configured'); e.code = 'NOACCT'; throw e; }
    return { CANO: c, ACNT_PRDT_CD: p };
  };
  const configured = () => { try { acct(); return true; } catch (_) { return false; } };

  /* 현금 주문. 반환 { odno, orgno, tmd } — KIS 가 거부하면 e.code='REJECT'(e.msg 사유), 응답을 못 받으면 e.code='UNKNOWN' */
  async function order({ side, code, type, price, qty, venue }) {
    const body = {
      ...acct(), PDNO: code, ORD_DVSN: type === 'market' ? '01' : '00', ORD_QTY: String(qty), ORD_UNPR: type === 'market' ? '0' : String(price),
      EXCG_ID_DVSN_CD: venueOf(venue), SLL_TYPE: side === 'sell' ? '01' : '', CNDT_PRIC: '',
    };
    const j = await kisPost('/uapi/domestic-stock/v1/trading/order-cash', side === 'buy' ? 'TTTC0012U' : 'TTTC0011U', body);
    const o = up(j.output);
    if (!o.ODNO) { const e = new Error('no order number'); e.code = 'UNKNOWN'; throw e; }
    return { odno: String(o.ODNO), orgno: String(o.KRX_FWDG_ORD_ORGNO || ''), tmd: String(o.ORD_TMD || '') };
  }
  /* 잔량 전부 취소 */
  async function cancel({ odno, orgno, venue }) {
    const body = { ...acct(), KRX_FWDG_ORD_ORGNO: String(orgno || ''), ORGN_ODNO: String(odno), ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02', ORD_QTY: '0', ORD_UNPR: '0', QTY_ALL_ORD_YN: 'Y', EXCG_ID_DVSN_CD: venueOf(venue) };
    const j = await kisPost('/uapi/domestic-stock/v1/trading/order-rvsecncl', 'TTTC0013U', body);
    const o = up(j.output);
    return { odno: String(o.ODNO || '') };
  }
  /* 정정(RVSE_CNCL_DVSN_CD 01): 남은 수량 중 qty 만큼(all=true 면 잔량 전부)을 새 가격으로. 새 주문번호가 생기고 원주문 잔량은 빠짐 */
  async function modify({ odno, orgno, venue, price, qty, all }) {
    const body = { ...acct(), KRX_FWDG_ORD_ORGNO: String(orgno || ''), ORGN_ODNO: String(odno), ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '01', ORD_QTY: all ? '0' : String(qty), ORD_UNPR: String(price), QTY_ALL_ORD_YN: all ? 'Y' : 'N', EXCG_ID_DVSN_CD: venueOf(venue) };
    const j = await kisPost('/uapi/domestic-stock/v1/trading/order-rvsecncl', 'TTTC0013U', body);
    const o = up(j.output);
    if (!o.ODNO) { const e = new Error('no order number'); e.code = 'UNKNOWN'; throw e; }
    return { odno: String(o.ODNO), orgno: String(o.KRX_FWDG_ORD_ORGNO || orgno || '') };
  }
  /* 오늘(또는 지정일) 주문·체결 목록 */
  async function dailyOrders(ymd) {
    const j = await kisGet('/uapi/domestic-stock/v1/trading/inquire-daily-ccld', 'TTTC0081R', {
      ...acct(), INQR_STRT_DT: ymd, INQR_END_DT: ymd, SLL_BUY_DVSN_CD: '00', INQR_DVSN: '00', PDNO: '', CCLD_DVSN: '00', ORD_GNO_BRNO: '', ODNO: '',
      INQR_DVSN_3: '00', INQR_DVSN_1: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '', EXCG_ID_DVSN_CD: 'ALL',
    });
    return (j.output1 || []).map(r => ({
      odno: String(r.odno || ''), orgnOdno: String(r.orgn_odno || ''), code: String(r.pdno || ''), name: r.prdt_name || null,
      side: r.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy', qty: n(r.ord_qty), price: n(r.ord_unpr), filled: n(r.tot_ccld_qty), amt: n(r.tot_ccld_amt), avg: n(r.avg_prvs),
      rmn: n(r.rmn_qty), rejected: n(r.rjct_qty), cancelled: r.cncl_yn === 'Y', tmd: String(r.ord_tmd || ''), excg: String(r.excg_id_dvsn_cd || r.excg_id_dvsn_Cd || r.excg_dvsn_cd || ''), _keys: Object.keys(r),
    })).filter(r => r.odno);
  }
  /* 잔고: 보유 종목 + 예수금 */
  async function balance() {
    const j = await kisGet('/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', {
      ...acct(), AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    });
    const rows = (j.output1 || []).map(r => ({ code: String(r.pdno || ''), name: r.prdt_name || null, qty: n(r.hldg_qty), sellable: n(r.ord_psbl_qty), avg: n(r.pchs_avg_pric), price: n(r.prpr),
      evalAmt: n(r.evlu_amt), pnl: n(r.evlu_pfls_amt), pnlRt: n(r.evlu_pfls_rt), _keys: Object.keys(r) }))
      .filter(r => r.code && r.qty > 0);
    const s = (j.output2 || [])[0] || {};
    /* 요약(3단계 계좌 현황): 예수금(D+0 dnca_tot_amt)·D+1(nxdy_excc_amt)·D+2(prvs_rcdl_excc_amt)·매입 합계·평가 합계·평가손익 합계·총평가 — 필드 이름은 KIS 공식 예제 기준, 4단계 점검에서 앱과 대조 */
    const sum = { cash: n(s.dnca_tot_amt), d1: n(s.nxdy_excc_amt), d2: n(s.prvs_rcdl_excc_amt), purchase: n(s.pchs_amt_smtl_amt), evalAmt: n(s.evlu_amt_smtl_amt), pnl: n(s.evlu_pfls_smtl_amt), total: n(s.tot_evlu_amt) };
    return { positions: rows, cash: n(s.dnca_tot_amt), total: n(s.tot_evlu_amt), sum, _keys2: Object.keys(s) };
  }
  /* 매수가능조회(실거래 전환 2단계): 미수 없이 살 수 있는 금액(nrcvb_buy_amt)·수량. 금액 자동 조정과 주문 직전 예수금 점검에 씀.
     가격을 주면 그 가격 기준, 없으면(0) 시장가 기준. 조회 전용 — 돈을 옮기는 API 가 아님 */
  async function buyable({ code, price } = {}) {
    const j = await kisGet('/uapi/domestic-stock/v1/trading/inquire-psbl-order', 'TTTC8908R', {
      ...acct(), PDNO: String(code || ''), ORD_UNPR: price > 0 ? String(Math.round(price)) : '0', ORD_DVSN: price > 0 ? '00' : '01', CMA_EVLU_AMT_ICLD_YN: 'N', OVRS_ICLD_YN: 'N',
    });
    const o = j.output || {};
    return { cash: n(o.nrcvb_buy_amt), qty: n(o.nrcvb_buy_qty), ordCash: n(o.ord_psbl_cash), maxAmt: n(o.max_buy_amt), _keys: Object.keys(o) };
  }
  return { order, cancel, modify, dailyOrders, balance, buyable, configured };
}

module.exports = { createKisOrder };
