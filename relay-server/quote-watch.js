'use strict';
/* 시세 조회 실패 추적 (2026-11-16) — 가상매매(paper.js)·실전(live.js) 공용.
   예전에는 한 번만 실패해도(오류 내용도 버린 채) 곧바로 "감시가 멈춰 있습니다" 알림을 보냈다.
   · 연속 실패 횟수를 종목별로 센다(성공하면 0)
   · 실패 때마다 원인을 로그에 남긴다(첫 실패와 이후 N번째마다 — 로그 폭주 방지)
   · 알림은 연속 N번(기본 6번 ≈ 30초) 이어질 때만, 실패 원인을 함께 보낸다. 복구되면 로그(알렸다면 복구 알림도) */
function createQuoteWatch({ tag = 'paper', threshold = 6, logEvery = 6, log = m => console.log(m), notify, now = Date.now } = {}) {
  const st = new Map(); // code -> { n, since, alerted, last }
  function fail(code, err) {
    const s = st.get(code) || { n: 0, since: now(), alerted: false, last: '' };
    s.n++; s.last = String((err && err.message) || err || '알 수 없음').slice(0, 160); st.set(code, s);
    if (s.n === 1 || s.n % logEvery === 0) log(`[${tag}] 시세 조회 실패 ${code} 연속 ${s.n}회 (${Math.round((now() - s.since) / 1000)}초째) — ${s.last}`);
    if (s.n >= threshold && !s.alerted) { s.alerted = true; if (notify) notify(`시세 조회가 ${s.n}번 연속 실패했습니다: ${code}\n원인: ${s.last}`, 'quotefail|' + code); }
    return s.n;
  }
  function ok(code) {
    const s = st.get(code); if (!s) return;
    st.delete(code);
    if (s.n >= 2) log(`[${tag}] 시세 조회 복구 ${code} — 연속 ${s.n}회·${Math.round((now() - s.since) / 1000)}초 만에`);
    if (s.alerted && notify) notify(`시세 조회가 복구됐습니다: ${code} (${Math.round((now() - s.since) / 1000)}초 중단)`, 'quoteok|' + code);
  }
  return { fail, ok, state: () => [...st.entries()].map(([code, s]) => ({ code, n: s.n, alerted: s.alerted, last: s.last })) };
}
module.exports = { createQuoteWatch };
