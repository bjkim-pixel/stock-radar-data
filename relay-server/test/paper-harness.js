'use strict';
const http = require('http');
const { createTrade, hashPin } = require('../trade');

const ORIGIN = 'https://bjkim-pixel.github.io';
const GOOD = 'good-token-0123456789abcdef';
const T0 = Date.parse('2027-01-13T10:00:00+09:00');     // 수요일 10:00 KST

/* 메모리 DB: relay 가 쓰는 PostgREST 호출(sbGet/sbWrite) 흉내 */
function fakeDb() {
  const t = { paper_orders: new Map(), paper_fills: new Map(), paper_positions: new Map(), paper_book_snaps: [], paper_events: [], trade_audit: [], deleted: [], live_orders: new Map(), live_fills: new Map(), live_plans: new Map(), live_events: [],
    // 종목 구분(8단계): 005930 은 KRX 전용(기존 시나리오 = 정규장 기준), 000660 은 NXT 가능
    stocks: new Map([['005930', { code: '005930', nxt_ok: false, security_type: 'STOCK' }], ['000660', { code: '000660', nxt_ok: true, security_type: 'STOCK' }]]) };
  const pk = { paper_orders: 'id', paper_fills: 'id', paper_positions: 'code', live_orders: 'id', live_fills: 'id', live_plans: 'code' };
  let snapId = 0, fail = null;
  return {
    t, setFail: f => { fail = f; },
    sbGet: async path => {
      if (fail && fail.get) throw new Error(fail.get);
      const [tbl, qs = ''] = path.split('?'); const p = new URLSearchParams(qs);
      if (tbl === 'trade_audit') return [];
      if (tbl === 'stocks') { const c = (p.get('code') || '').replace('eq.', ''); return t.stocks.has(c) ? [{ ...t.stocks.get(c) }] : []; }
      let rows = tbl === 'paper_book_snaps' ? t.paper_book_snaps : tbl === 'live_events' ? t.live_events : [...t[tbl].values()];
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
        if (tbl === 'live_plans') t.live_plans.delete(qs.replace('code=eq.', ''));
        return;
      }
      for (const r of rows) {
        if (tbl === 'trade_audit') t.trade_audit.push(r);
        else if (tbl === 'paper_book_snaps') t.paper_book_snaps.push({ id: ++snapId, ...r });
        else if (tbl === 'paper_events') t.paper_events.push(r);
        else if (tbl === 'live_events') t.live_events.push(r);
        else t[tbl].set(r[pk[tbl]], JSON.parse(JSON.stringify(r)));
      }
    },
  };
}

async function boot(db, { envExtra = {}, clock: c0 = T0, kx = null } = {}) {
  const st = { clock: c0, price: 10000, vol: 100000, low: 9900, high: 10100, warnings: [], vi: false, hourOverride: null, alerts: [] };
  st.asks = [[10010, 100], [10020, 200], [10030, 300], [10040, 400], [10050, 500], [10060, 100], [10070, 100], [10080, 100], [10090, 100], [10100, 100]];
  st.bids = [[10000, 500], [9990, 400], [9980, 300], [9970, 200], [9960, 100], [9950, 100], [9940, 100], [9930, 100], [9920, 100], [9910, 100]];
  const hhmmss = () => { const d = new Date(st.clock + 9 * 3600e3); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + String(d.getUTCSeconds()).padStart(2, '0'); };
  st.mkts = [];
  const kisGet = async (path, trId, params) => {
    if (params && params.FID_COND_MRKT_DIV_CODE) st.mkts.push(params.FID_COND_MRKT_DIV_CODE);
    if (trId === 'FHKST01010100') return { output: { stck_prpr: st.price, prdy_vrss: 0, prdy_ctrt: 0, prdy_vrss_sign: '3', stck_oprc: 10000, stck_hgpr: st.high, stck_lwpr: st.low, stck_sdpr: 10000, stck_mxpr: 13000, stck_llam: 7000, acml_vol: st.vol, acml_tr_pbmn: 1e9, aspr_unit: 10, temp_stop_yn: st.warnings.includes('거래정지') ? 'Y' : 'N', vi_cls_code: st.vi ? 'Y' : 'N' } };
    if (trId === 'FHKST01010200') {
      const o1 = { aspr_acpt_hour: st.hourOverride || hhmmss(), total_askp_rsqn: 1, total_bidp_rsqn: 1 };
      st.asks.forEach(([p, q], i) => { o1['askp' + (i + 1)] = p; o1['askp_rsqn' + (i + 1)] = q; });
      st.bids.forEach(([p, q], i) => { o1['bidp' + (i + 1)] = p; o1['bidp_rsqn' + (i + 1)] = q; });
      return { output1: o1, output2: {} };
    }
    if (trId === 'FHKST01010300') return { output: [{ tday_rltv: '100' }] };
    if (kx && (trId === 'TTTC0081R' || trId === 'TTTC8434R')) return kx.get(trId);
    if (trId === 'CTCA0903R') return { output: [{ bass_dt: '20270113', opnd_yn: st.closedDay ? 'N' : 'Y' }] };
    throw new Error('unexpected ' + trId);
  };
  const pinHash = await hashPin('123456', 100000);
  const env = { ALLOWED_EMAIL: 'owner@example.com', SUPABASE_ANON_KEY: 'anon', TRADE_PIN_HASH: pinHash, TRADING_ENABLED: '1', TRADE_HOURS: '08:00-20:00', ...envExtra };
  const fakeFetch = async url => String(url).includes('/auth/v1/user')
    ? { ok: true, status: 200, json: async () => ({ id: 'uid-1', email: 'owner@example.com' }) } : { ok: true, status: 200 };
  const t = createTrade({ env, now: () => st.clock, fetch: fakeFetch, allowedOrigins: [ORIGIN], clientIp: () => '1.1.1.1', sbGet: db.sbGet, sbWrite: db.sbWrite, kisGet, kisPost: kx ? kx.post : undefined, skipLoop: true, notify: async (text) => { st.alerts.push(text); } });
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
  if (kx) kx.st = st;
  return { t, st, call, login, order, close: () => new Promise(r => server.close(r)) };
}


/* 모의 KIS 거래소: 주문·취소·일별 체결조회·잔고. 시장가는 즉시 최우선 호가로 전량 체결 */
function fakeKis() {
  const kx = { orders: new Map(), hold: new Map(), seq: 1000, posts: [], next: null, lostAccepted: false, cancelFail: false, st: null };
  const hhmmss = () => { const d = new Date(kx.st.clock + 9 * 3600e3); return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(x => String(x).padStart(2, '0')).join(''); };
  kx.fill = (odno, q, p) => {
    const o = kx.orders.get(odno); o.filled += q; o.amt += q * p;
    const h = kx.hold.get(o.code) || { qty: 0, avg: 0 };
    if (o.side === 'buy') { h.avg = (h.avg * h.qty + p * q) / (h.qty + q); h.qty += q; } else h.qty -= q;
    kx.hold.set(o.code, h);
  };
  const accept = (body, tr) => {
    const o = { odno: String(++kx.seq).padStart(10, '0'), code: body.PDNO, side: tr === 'TTTC0012U' ? 'buy' : 'sell', qty: +body.ORD_QTY, price: +body.ORD_UNPR, type: body.ORD_DVSN === '01' ? 'market' : 'limit', filled: 0, amt: 0, cancelled: false, tmd: hhmmss(), excg: body.EXCG_ID_DVSN_CD };
    kx.orders.set(o.odno, o);
    if (o.type === 'market') kx.fill(o.odno, o.qty, o.side === 'buy' ? kx.st.asks[0][0] : kx.st.bids[0][0]);
    return o;
  };
  kx.post = async (path, tr, body) => {
    kx.posts.push({ path, tr, body });
    if (kx.next) {
      const nx = kx.next; kx.next = null;
      if (nx === 'REJECT') { const e = new Error('주문가능금액을 초과 했습니다 (APBK0952)'); e.code = 'REJECT'; throw e; }
      if (nx === 'UNKNOWN') { if (kx.lostAccepted) accept(body, tr); const e = new Error('KIS 응답 없음'); e.code = 'UNKNOWN'; throw e; }
    }
    if (path.endsWith('order-cash')) {
      const h = kx.hold.get(body.PDNO);
      if (tr === 'TTTC0011U') {
        const reserved = [...kx.orders.values()].filter(o => o.code === body.PDNO && o.side === 'sell' && !o.cancelled).reduce((a, o) => a + o.qty - o.filled, 0);
        if (!h || +body.ORD_QTY > h.qty - reserved) { const e = new Error('주문가능수량을 초과 했습니다 (APBK0400)'); e.code = 'REJECT'; throw e; }
      }
      const o = accept(body, tr);
      return { rt_cd: '0', output: { ODNO: o.odno, KRX_FWDG_ORD_ORGNO: '91252', ORD_TMD: o.tmd } };
    }
    if (path.endsWith('order-rvsecncl')) {
      if (kx.cancelFail) { const e = new Error('정정취소가능수량이 없습니다 (APBK0918)'); e.code = 'REJECT'; throw e; }
      const o = kx.orders.get(body.ORGN_ODNO); o.cancelled = true;
      return { rt_cd: '0', output: { odno: String(++kx.seq) } };
    }
    throw new Error('unexpected post ' + path);
  };
  kx.get = async tr => {
    if (tr === 'TTTC0081R') return { rt_cd: '0', output1: [...kx.orders.values()].map(o => ({ odno: o.odno, orgn_odno: '', pdno: o.code, prdt_name: '삼성전자', sll_buy_dvsn_cd: o.side === 'sell' ? '01' : '02',
      ord_qty: String(o.qty), ord_unpr: String(o.price), tot_ccld_qty: String(o.filled), tot_ccld_amt: String(o.amt), avg_prvs: String(o.filled ? o.amt / o.filled : 0), rmn_qty: String(o.cancelled ? 0 : o.qty - o.filled),
      rjct_qty: '0', cncl_yn: o.cancelled ? 'Y' : 'N', ord_tmd: o.tmd })) };
    const reserved = c => [...kx.orders.values()].filter(o => o.code === c && o.side === 'sell' && !o.cancelled).reduce((a, o) => a + o.qty - o.filled, 0);
    return { rt_cd: '0', output1: [...kx.hold.entries()].filter(([, h]) => h.qty > 0).map(([c, h]) => ({ pdno: c, prdt_name: c === '005930' ? '삼성전자' : 'SK하이닉스', hldg_qty: String(h.qty), ord_psbl_qty: String(h.qty - reserved(c)), pchs_avg_pric: String(h.avg), prpr: String(kx.st.price) })),
      output2: [{ dnca_tot_amt: '1000000', tot_evlu_amt: '2000000' }] };
  };
  return kx;
}

module.exports = { fakeDb, boot, T0, fakeKis };
