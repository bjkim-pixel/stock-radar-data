'use strict';
/* 자동매매 일지(2026-11-16 개편) — 오늘 탭 내용(uiState)을 하루에 한 번(20:30) 날짜별로 통째로 저장하고,
   일지에서는 날짜를 골라 그날 오늘 탭을 그대로 복기한다. 직접 매매는 오늘 탭에 없으므로 저장 대상이 아니다.
   용량: 목록은 가벼운 요약(sum)만 읽고, 날짜를 고를 때만 snap 을 읽는다. 기록 줄은 건수·길이를 잘라 하루 한 행을 작게 유지한다. */

const SAVE_AT = 20 * 60 + 30, MEMO_MAX = 300, SNAP_MAX = 250 * 1024;
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isMissing = e => !!e && /auto_daylog|PGRST205|42P01|does not exist|schema cache/i.test(String(e.message || e));

/* 오늘 탭 데이터에서 저장하지 않을 것(과거 이력·실시간 호가 등)을 빼고 크기를 줄인다 */
function slim(state, strategies) {
  const st = { ...state };
  delete st.history; delete st.totals; delete st.quotes;
  const cut = (arr, n) => Array.isArray(arr) && arr.length > n ? arr.slice(-n) : arr;
  const slimRun = r => {
    if (!r || typeof r !== 'object') return r;
    const o = { ...r };
    if (Array.isArray(o.log)) o.log = cut(o.log, 120).map(l => (l && typeof l.text === 'string' && l.text.length > 240) ? { ...l, text: l.text.slice(0, 240) } : l);
    return o;
  };
  if (st.today) st.today = slimRun(st.today);
  if (Array.isArray(st.todays)) st.todays = st.todays.map(slimRun);
  const act = new Set([...(strategies.active && strategies.active.intraday || []), strategies.active && strategies.active.closing].filter(Boolean));
  const strat = {
    ok: true, active: strategies.active || {}, schema: undefined,
    strategies: (strategies.strategies || []).filter(s => act.has(s.id)).map(s => ({ id: s.id, name: s.name, kind: s.kind, version: s.version, params: s.params, desc: s.desc, enabled: s.enabled })),
    times: strategies.times, timesBy: strategies.timesBy,
  };
  return { state: st, strat };
}
/* 목록용 요약 */
function summary(state) {
  const todays = state.todays || [];
  const picks = todays.reduce((a, t) => a + ((t.picks || []).length), 0);
  const trades = state.trades || [];
  const buys = trades.filter(f => f.side === 'buy').length, sells = trades.filter(f => f.side === 'sell').length;
  const d = state.dayTot || {};
  return { picks, buys, sells, holds: (state.positions || []).length, carry: (state.carry || []).length, net: d.net != null ? d.net : (d.realized != null ? d.realized : null), strategies: todays.length };
}

function createDayLog(D) {
  const now = D.now || Date.now;
  const S = { done: {}, last: null, missing: 0, at: {} };
  const due = (k, ms) => { const t = now(); if (S.at[k] && t - S.at[k] < ms) return false; S.at[k] = t; return true; };

  async function save(date, { force = false } = {}) {
    if (!isDate(date)) return { ok: false, status: 400, error: '날짜가 올바르지 않습니다' };
    const [state, strategies] = await Promise.all([D.uiState(date), D.strategies()]);
    if (state.date !== date) return { ok: false, status: 400, error: '그 날짜를 저장할 수 없습니다' };
    const hasRun = (state.todays || []).length > 0;
    if (state.rebuilt && !hasRun) return { ok: false, status: 404, error: '그날 자동매매 실행 기록이 없습니다' };
    if (!hasRun && !force) return { ok: true, skipped: 'no-run', date };
    const { state: st, strat } = slim(state, strategies);
    let snap = { v: 1, savedAt: now(), rebuilt: !!state.rebuilt, state: st, strat };
    let json = JSON.stringify(snap);
    if (json.length > SNAP_MAX) {   // 그래도 크면 기록 줄을 더 줄인다
      const lite = r => r && Array.isArray(r.log) ? { ...r, log: r.log.slice(-30) } : r;
      snap.state.todays = (snap.state.todays || []).map(lite); if (snap.state.today) snap.state.today = lite(snap.state.today);
      json = JSON.stringify(snap);
    }
    const row = { trade_date: date, sum: summary(state), snap, size: json.length, updated_at: new Date().toISOString() };
    // memo 는 보내지 않는다 → 다시 저장해도 기존 메모가 유지된다(처음엔 기본값 '')
    await D.sbWrite('auto_daylog?on_conflict=trade_date', 'POST', [row]);
    S.done[date] = true;
    return { ok: true, date, size: json.length, sum: row.sum };
  }

  async function tick(date, min) {
    if (S.missing && now() - S.missing < 10 * 60e3) return { ok: true, idle: 'no-table' };
    if (min < SAVE_AT || S.done[date] || !(D.isTradingDay ? D.isTradingDay(date) : true)) return { ok: true, idle: true };
    if (!due('save|' + date, 5 * 60e3)) return { ok: true, idle: 'wait' };
    try {
      const ex = await D.sbGet(`auto_daylog?select=trade_date&trade_date=eq.${date}&limit=1`);
      if (ex && ex.length) { S.done[date] = true; return { ok: true, exists: true }; }
      const r = await save(date);
      S.missing = 0; return r;
    } catch (e) {
      if (isMissing(e)) { S.missing = now(); S.last = '일지 테이블이 없습니다(DB 설정 auto_daylog 필요)'; return { ok: false, err: S.last }; }
      S.last = e.message; return { ok: false, err: e.message };
    }
  }

  async function list(limit) {
    const n = Math.min(Math.max(+limit || 400, 1), 1000);
    try {
      const r = await D.sbGet(`auto_daylog?select=trade_date,sum,size,memo&order=trade_date.desc&limit=${n}`);
      return { ok: true, rows: (r || []).map(x => ({ date: x.trade_date, sum: x.sum || {}, size: x.size || 0, memo: !!x.memo })) };
    } catch (e) { if (isMissing(e)) return { ok: true, missing: true, rows: [] }; throw e; }
  }
  async function get(date) {
    if (!isDate(date)) return { ok: false, status: 400, error: '날짜가 올바르지 않습니다' };
    try {
      const r = await D.sbGet(`auto_daylog?select=trade_date,snap,memo,size&trade_date=eq.${date}&limit=1`);
      if (!r || !r.length) return { ok: false, status: 404, error: '그 날짜의 일지가 없습니다' };
      return { ok: true, date, snap: r[0].snap, memo: r[0].memo || '', size: r[0].size || 0 };
    } catch (e) { if (isMissing(e)) return { ok: true, missing: true }; throw e; }
  }
  async function memo(date, text) {
    if (!isDate(date)) return { ok: false, status: 400, error: '날짜가 올바르지 않습니다' };
    if (typeof text !== 'string') return { ok: false, status: 400, error: '메모가 올바르지 않습니다' };
    const t = text.replace(/\r/g, '').slice(0, MEMO_MAX);
    const r = await D.sbGet(`auto_daylog?select=trade_date&trade_date=eq.${date}&limit=1`);
    if (!r || !r.length) return { ok: false, status: 404, error: '그 날짜의 일지가 없습니다' };
    await D.sbWrite(`auto_daylog?trade_date=eq.${date}`, 'PATCH', { memo: t });
    return { ok: true, memo: t, truncated: text.length > MEMO_MAX };
  }
  return { tick, save, list, get, memo, status: () => ({ last: S.last, missing: !!S.missing }) };
}

module.exports = { createDayLog, slim, summary, SAVE_AT, MEMO_MAX };
