'use strict';
/* 선택 컬럼(실거래 전환 1단계, 2026-11-18): DB 에 새 컬럼을 추가하기 전에도 기존 동작이 멈추지 않게 한다.
   행에 그 컬럼이 들어 있는데 테이블에 아직 없으면(PostgREST PGRST204) 그 컬럼만 빼고 다시 쓰고, 이후로는 계속 뺀다.
   예: 주문 출처(origin) — [수시] DB 테이블·뷰 생성 → order_origin 을 실행하면 다음 재시작부터 기록된다. */
function createOptCol(col, { onMissing } = {}) {
  let has = true;
  const strip = rows => rows.map(r => { if (!r || !(col in r)) return r; const x = { ...r }; delete x[col]; return x; });
  const missing = e => { const m = String((e && e.message) || e); return m.includes('PGRST204') && m.includes(col); };
  async function write(W, path, method, rows) {
    if (!Array.isArray(rows) || !rows.some(r => r && col in r)) return W(path, method, rows);
    if (!has) return W(path, method, strip(rows));
    try { return await W(path, method, rows); }
    catch (e) {
      if (!missing(e)) throw e;
      has = false;
      try { onMissing && onMissing(); } catch (_) {}
      return W(path, method, strip(rows));
    }
  }
  return { write, get has() { return has; } };
}
/* 주문 출처 표기: 'auto'(전략 지정 없음) 또는 'auto:<전략ID>'. 그 밖의 값은 버림(사람이 낸 주문 = null) */
const cleanOrigin = v => (typeof v === 'string' && /^auto(:[A-Za-z0-9_-]{1,40})?$/.test(v) ? v : null);

module.exports = { createOptCol, cleanOrigin };
