'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDayLog, slim, summary, SAVE_AT, MEMO_MAX } = require('../auto-daylog');

function rig({ rows = {}, state, strategies, trading = true } = {}) {
  const db = { auto_daylog: { ...rows } }, writes = [];
  let t = 1e12;
  const D = {
    now: () => t, isTradingDay: () => trading,
    uiState: async () => state || { date: '2026-11-16', todays: [{ sid: 'intraday-a', picks: [{ code: 'A' }], log: Array.from({ length: 300 }, (_, i) => ({ text: 'x'.repeat(500) + i })) }], trades: [{ side: 'buy' }, { side: 'sell' }, { side: 'buy' }], positions: [{ code: 'A' }], carry: [], dayTot: { net: 1234 }, history: [1, 2, 3], totals: { a: 1 }, quotes: { A: {} } },
    strategies: async () => strategies || { active: { intraday: ['intraday-a'], closing: 'closing-b' }, strategies: [{ id: 'intraday-a', name: 'A', kind: 'intraday', version: 1, params: { perStockKrw: 1 } }, { id: 'old', name: 'x', kind: 'intraday', params: {} }], times: { a: 1 }, timesBy: {} },
    sbGet: async q => {
      const m = q.match(/trade_date=eq\.(\d{4}-\d{2}-\d{2})/);
      if (m) return db.auto_daylog[m[1]] ? [db.auto_daylog[m[1]]] : [];
      return Object.values(db.auto_daylog);
    },
    sbWrite: async (q, method, body) => {
      writes.push({ q, method, body });
      if (method === 'POST') body.forEach(r => { db.auto_daylog[r.trade_date] = { ...(db.auto_daylog[r.trade_date] || { memo: '' }), ...r }; });
      else { const d = q.match(/trade_date=eq\.([\d-]+)/)[1]; Object.assign(db.auto_daylog[d], body); }
    },
  };
  return { D, db, writes, dl: createDayLog(D), tickT: n => { t += n; } };
}

test('저장: 오늘 탭 데이터에서 이력·호가를 빼고 기록 줄을 자르며, 활성 전략만 남긴다', async () => {
  const k = rig();
  const r = await k.dl.save('2026-11-16');
  assert.equal(r.ok, true);
  const row = k.db.auto_daylog['2026-11-16'];
  assert.equal(row.snap.state.history, undefined); assert.equal(row.snap.state.quotes, undefined); assert.equal(row.snap.state.totals, undefined);
  assert.equal(row.snap.state.todays[0].log.length, 120); assert.equal(row.snap.state.todays[0].log[0].text.length, 240);
  assert.deepEqual(row.snap.strat.strategies.map(s => s.id), ['intraday-a']);
  assert.deepEqual(row.sum, { picks: 1, buys: 2, sells: 1, holds: 1, carry: 0, net: 1234, strategies: 1 });
  assert.ok(row.size > 0 && row.size < 250 * 1024);
});
test('20:30 전에는 저장하지 않고, 20:30 이후 한 번만 저장(이미 있으면 다시 쓰지 않음)', async () => {
  const k = rig();
  assert.equal((await k.dl.tick('2026-11-16', SAVE_AT - 1)).idle, true); assert.equal(k.writes.length, 0);
  assert.equal((await k.dl.tick('2026-11-16', SAVE_AT)).ok, true); assert.equal(k.writes.length, 1);
  await k.dl.tick('2026-11-16', SAVE_AT + 5); assert.equal(k.writes.length, 1);
  const k2 = rig({ rows: { '2026-11-16': { trade_date: '2026-11-16', memo: '' } } });
  assert.equal((await k2.dl.tick('2026-11-16', SAVE_AT)).exists, true); assert.equal(k2.writes.length, 0);
});
test('휴장일이거나 그날 자동매매 기록이 없으면 저장하지 않음 · 날짜가 오늘이 아니면 거절', async () => {
  assert.equal((await rig({ trading: false }).dl.tick('2026-11-16', SAVE_AT + 1)).idle, true);
  const k = rig({ state: { date: '2026-11-16', todays: [] } });
  assert.equal((await k.dl.save('2026-11-16')).skipped, 'no-run'); assert.equal(k.writes.length, 0);
  assert.equal((await rig().dl.save('2026-11-13')).ok, false);
});
test('목록은 요약만, 상세는 snap 포함 · 메모는 300자 제한이고 다시 저장해도 유지', async () => {
  const k = rig(); await k.dl.save('2026-11-16');
  const ls = await k.dl.list(); assert.equal(ls.rows[0].date, '2026-11-16'); assert.equal(ls.rows[0].snap, undefined); assert.equal(ls.rows[0].sum.buys, 2);
  const m = await k.dl.memo('2026-11-16', 'a'.repeat(400)); assert.equal(m.memo.length, MEMO_MAX); assert.equal(m.truncated, true);
  await k.dl.save('2026-11-16');
  assert.equal(k.db.auto_daylog['2026-11-16'].memo.length, MEMO_MAX);
  const g = await k.dl.get('2026-11-16'); assert.equal(g.ok, true); assert.ok(g.snap.state);
  assert.equal((await k.dl.get('2026-11-01')).status, 404); assert.equal((await k.dl.memo('2026-11-01', 'x')).status, 404);
});

test('지난 날짜 재구성(rebuilt) 저장: 실행 기록이 있으면 저장하고 표시, 없으면 거절', async () => {
  const r = rig({ state: { date: '2026-11-16', rebuilt: true, todays: [{ sid: 'intraday-a', picks: [{ code: 'A' }], log: [] }], trades: [], positions: [], carry: [], dayTot: { realized: 5 } } });
  const ok = await r.dl.save('2026-11-16', { force: true });
  assert.equal(ok.ok, true);
  assert.equal(r.db.auto_daylog['2026-11-16'].snap.rebuilt, true);
  const e = rig({ state: { date: '2026-11-16', rebuilt: true, todays: [] } });
  const no = await e.dl.save('2026-11-16', { force: true });
  assert.equal(no.ok, false); assert.equal(no.status, 404);
});
