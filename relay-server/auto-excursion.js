'use strict';
/* 자동매매 보강 E2-3(2026-11-16): 보유 중 최고가·최저가 기록(MFE 최대 평가이익 · MAE 최대 평가손실)
   · 자동매매가 든 종목의 현재가를 30초마다 훑어 그 종목의 최고·최저를 갱신 → 매수가 대비 %로 환산(보유 기간 전체, 이월 포함)
   · 매수한 날은 시세 사이의 짧은 고저를 놓칠 수 있고(훑는 간격), 서버가 꺼져 있던 구간은 빠짐 → 일지에는 "기록"과 "근사(일봉 고저)"를 구분해 표시
   · 이월 후 다음 날부터는 시세의 당일 고저(dayHigh·dayLow)도 반영 — 매수 전 시간대가 섞이지 않는 날만
   저장: auto_config 'excursion' = { pos: { code: {avg, since, hi, lo, n} }, done: [{code, since, to, avg, hi, lo}] } */

const MAX_DONE = 80;
/* 실전매매 자동매매(2026-11-19): 가상·드라이런·실전 장부가 같은 종목을 각자 보유할 수 있어 기록 키에 장부를 붙임(가상은 예전처럼 종목코드만) */
const keyOf = (code, kind) => (!kind || kind === 'paper' ? code : `${code}@${kind}`);
const fresh = () => ({ pos: {}, done: [] });
const pct = (v, base) => (v > 0 && base > 0 ? +((v / base - 1) * 100).toFixed(2) : null);

/* positions: 엔진 상태의 positions(kind 포함), watch: 자동매매 종목 키 집합(keyOf), today: 'YYYY-MM-DD'. 반환 { store, changed } (store 를 직접 고침) */
function update(store, positions, watch, today) {
  store.pos = store.pos || {}; store.done = store.done || [];
  let changed = false;
  const seen = new Set();
  for (const p of positions || []) {
    const k = keyOf(p.code, p.kind);
    if (!watch.has(k) || !(p.qty > 0) || !(p.avg > 0)) continue;
    seen.add(k);
    let r = store.pos[k];
    if (!r) { r = store.pos[k] = { avg: p.avg, since: today, hi: null, lo: null, n: 0, ...(k !== p.code ? { code: p.code, kind: p.kind } : {}) }; changed = true; }
    if (r.avg !== p.avg) { r.avg = p.avg; changed = true; }
    const cand = [p.last];
    if (r.since < today) { cand.push(p.dayHigh, p.dayLow); }   // 매수한 날은 매수 전 시간대가 섞이므로 당일 고저는 쓰지 않음
    for (const v of cand) {
      if (!(v > 0)) continue;
      if (r.hi == null || v > r.hi) { r.hi = v; changed = true; }
      if (r.lo == null || v < r.lo) { r.lo = v; changed = true; }
    }
    r.n++;
  }
  for (const k of Object.keys(store.pos)) {   // 더는 안 들고 있는 종목 → 완료 기록으로 이동
    if (seen.has(k)) continue;
    const r = store.pos[k];
    store.done.push({ code: r.code || k, ...(r.kind ? { kind: r.kind } : {}), since: r.since, to: today, avg: r.avg, hi: r.hi, lo: r.lo });
    delete store.pos[k]; changed = true;
  }
  if (store.done.length > MAX_DONE) store.done = store.done.slice(-MAX_DONE);
  return { store, changed };
}

/* date 에 산 종목의 기록(없으면 null). 진행 중인 기록과 완료 기록 모두 */
function find(store, code, date, kind) {
  if (!store) return null;
  const a = store.pos && store.pos[keyOf(code, kind)];
  if (a && a.since === date) return { ...a, open: true };
  const kd = !kind || kind === 'paper' ? null : kind;
  const d = (store.done || []).filter(x => x.code === code && (x.kind || null) === kd && x.since === date).pop();
  return d || null;
}

/* 일지 한 종목의 MFE·MAE(%): 기록 우선, 없으면 그날 일봉 고저(근사). 둘 다 없으면 null */
function excursionFor(store, daily, code, date, buyAvg, kind) {
  const rec = find(store, code, date, kind);
  if (rec && rec.hi > 0 && rec.lo > 0 && buyAvg > 0) return { mfe: Math.max(0, pct(rec.hi, buyAvg)), mae: Math.min(0, pct(rec.lo, buyAvg)), src: 'live' };
  const d = daily && daily[code];
  if (d && d.high > 0 && d.low > 0 && buyAvg > 0) return { mfe: Math.max(0, pct(d.high, buyAvg)), mae: Math.min(0, pct(d.low, buyAvg)), src: 'daily' };
  return null;
}

module.exports = { update, find, excursionFor, fresh, keyOf, MAX_DONE };
