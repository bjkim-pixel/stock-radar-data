'use strict';
const http = require('http');
const { createTrade, hashPin } = require('../trade');

const ORIGIN = 'https://bjkim-pixel.github.io';
const GOOD = 'good-token-0123456789abcdef';
const T0 = Date.parse('2027-01-13T10:00:00+09:00');     // 수요일 10:00 KST

/* 메모리 DB: relay 가 쓰는 PostgREST 호출(sbGet/sbWrite) 흉내 */
function fakeDb() {
  const t = { paper_orders: new Map(), paper_fills: new Map(), paper_positions: new Map(), paper_book_snaps: [], paper_events: [], trade_audit: [], deleted: [] };
  const pk = { paper_orders: 'id', paper_fills: 'id', paper_positions: 'code' };
  let snapId = 0, fail = null;
  return {
    t, setFail: f => { fail = f; },
    sbGet: async path => {
      if (fail && fail.get) throw new Error(fail.get);
      const [tbl, qs = ''] = path.split('?'); const p = new URLSearchParams(qs);
      if (tbl === 'trade_audit') return [];
      let rows = tbl === 'paper_book_snaps' ? t.paper_book_snaps : [...t[tbl].values()];
      const st = p.get('status'); if (st) { const set = st.replace(/^in\.\(|\)$/g, '').split(','); rows = rows.filter(r => set.includes(r.status)); }
      const ca = p.get('created_at'); if (ca) rows = rows.filter(r => Date.parse(r.created_at) >= Date.parse(ca.replace('gte.', '')));
      const ts = p.get('ts'); if (ts && ts.startsWith('gte.')) rows = rows.filter(r => Date.parse(r.ts) >= Date.parse(ts.slice(4)));
      const kd = p.get('kind'); if (kd) { const set = kd.replace(/^in\.\(|\)$/g, '').split(','); rows = rows.filter(r => set.includes(r.kind)); }
      return JSON.parse(JSON.stringify(rows));
    },
    sbWrite: async (path, method, rows) => {
      if (fail && fail.write && path.startsWith(fail.write)) throw new Error('write fail');
      const [tbl, qs = ''] = path.split('?');
      if (method === 'DELETE') {
        t.deleted.push(path);
        if (tbl === 'paper_positions') t.paper_positions.delete(qs.replace('code=eq.', ''));
        return;
      }
      for (const r of rows) {
        if (tbl === 'trade_audit') t.trade_audit.push(r);
        else if (tbl === 'paper_book_snaps') t.paper_book_snaps.push({ id: ++snapId, ...r });
        else if (tbl === 'paper_events') t.paper_events.push(r);
        else t[tbl].set(r[pk[tbl]], JSON.parse(JSON.stringify(r)));
      }
    },
  };
}

async function boot(db, { envExtra = {}, clock: c0 = T0 } = {}) {
  const st = { clock: c0, price: 10000, vol: 100000, low: 9900, high: 10100, warnings: [], vi: false, hourOverride: null, alerts: [] };
  st.asks = [[10010, 100], [10020, 200], [10030, 300], [10040, 400], [10050, 500], [10060, 100], [10070, 100], [10080, 100], [10090, 100], [10100, 100]];
  st.bids = [[10000, 500], [9990, 400], [9980, 300], [9970, 200], [9960, 100], [9950, 100], [9940, 100], [9930, 100], [9920, 100], [9910, 100]];
  const hhmmss = () => { const d = new Date(st.clock + 9 * 3600e3); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + String(d.getUTCSeconds()).padStart(2, '0'); };
  const kisGet = async (path, trId) => {
    if (trId === 'FHKST01010100') return { output: { stck_prpr: st.price, prdy_vrss: 0, prdy_ctrt: 0, prdy_vrss_sign: '3', stck_oprc: 10000, stck_hgpr: st.high, stck_lwpr: st.low, stck_sdpr: 10000, stck_mxpr: 13000, stck_llam: 7000, acml_vol: st.vol, acml_tr_pbmn: 1e9, aspr_unit: 10, temp_stop_yn: st.warnings.includes('거래정지') ? 'Y' : 'N', vi_cls_code: st.vi ? 'Y' : 'N' } };
    if (trId === 'FHKST01010200') {
      const o1 = { aspr_acpt_hour: st.hourOverride || hhmmss(), total_askp_rsqn: 1, total_bidp_rsqn: 1 };
      st.asks.forEach(([p, q], i) => { o1['askp' + (i + 1)] = p; o1['askp_rsqn' + (i + 1)] = q; });
      st.bids.forEach(([p, q], i) => { o1['bidp' + (i + 1)] = p; o1['bidp_rsqn' + (i + 1)] = q; });
      return { output1: o1, output2: {} };
    }
    if (trId === 'FHKST01010300') return { output: [{ tday_rltv: '100' }] };
    if (trId === 'CTCA0903R') return { output: [{ bass_dt: '20270113', opnd_yn: st.closedDay ? 'N' : 'Y' }] };
    throw new Error('unexpected ' + trId);
  };
  const pinHash = await hashPin('123456', 100000);
  const env = { ALLOWED_EMAIL: 'owner@example.com', SUPABASE_ANON_KEY: 'anon', TRADE_PIN_HASH: pinHash, TRADING_ENABLED: '1', TRADE_HOURS: '08:00-20:00', ...envExtra };
  const fakeFetch = async url => String(url).includes('/auth/v1/user')
    ? { ok: true, status: 200, json: async () => ({ id: 'uid-1', email: 'owner@example.com' }) } : { ok: true, status: 200 };
  const t = createTrade({ env, now: () => st.clock, fetch: fakeFetch, allowedOrigins: [ORIGIN], clientIp: () => '1.1.1.1', sbGet: db.sbGet, sbWrite: db.sbWrite, kisGet, skipLoop: true, notify: async (text) => { st.alerts.push(text); } });
  const server = http.createServer((req, res) => { if (!t.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0, sess = null;
  const call = async (method, path, { body, session = sess, token = GOOD } = {}) => {
    const headers = { 'content-type': 'application/json', origin: ORIGIN, authorization: `Bearer ${token}` };
    if (session) headers['x-trade-session'] = session;
    const r = await fetch(base + path, { method, headers, body: method === 'POST' ? JSON.stringify({ nonce: 'n' + (++n) + 'abcdefghijkl', ts: st.clock, ...body }) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await t.ready();
  const login = async () => { const r = await call('POST', '/trade/session', { body: { pin: '123456' } }); sess = r.body.session; return sess; };
  const order = (b) => call('POST', '/trade/paper/order', { body: b });
  return { t, st, call, login, order, close: () => new Promise(r => server.close(r)) };
}


module.exports = { fakeDb, boot, T0 };
