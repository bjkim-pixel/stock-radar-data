'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createTrade, hashPin } = require('../trade');

const ORIGIN = 'https://bjkim-pixel.github.io';
const GOOD = 'good-token-0123456789abcdef';
const T0 = Date.parse('2027-01-13T10:00:00+09:00');     // 수요일 10:00 KST

/* 메모리 DB: relay 가 쓰는 PostgREST 호출(sbGet/sbWrite) 흉내 */
function fakeDb() {
  const t = { paper_orders: new Map(), paper_fills: new Map(), paper_positions: new Map(), paper_book_snaps: [], trade_audit: [], deleted: [] };
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
        else t[tbl].set(r[pk[tbl]], JSON.parse(JSON.stringify(r)));
      }
    },
  };
}

async function boot(db, { envExtra = {}, clock: c0 = T0 } = {}) {
  const st = { clock: c0, price: 10000, vol: 100000, low: 9900, high: 10100, warnings: [], vi: false, hourOverride: null };
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
  const t = createTrade({ env, now: () => st.clock, fetch: fakeFetch, allowedOrigins: [ORIGIN], clientIp: () => '1.1.1.1', sbGet: db.sbGet, sbWrite: db.sbWrite, kisGet, skipLoop: true, notify: async () => {} });
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

test('세션 없이는 가상매매 API 거부', async () => {
  const db = fakeDb(), c = await boot(db);
  assert.equal((await c.call('GET', '/trade/paper/state')).status, 401);
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 401);
  await c.close();
});

test('시장가 매수: 호가 소진 체결 · 보유·체결·감사 기록 · 주문 전 DB 저장', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 250, plan: { stopPct: 5, stop: 9500, target: 10500, steps: [{ n: 1, p: 10300, q: 50 }] } });
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'filled'); assert.equal(r.body.order.filled, 250);
  assert.deepEqual(r.body.fills.map(f => [f.price, f.qty]), [[10010, 100], [10020, 150]]);
  assert.equal(db.t.paper_orders.size, 1);
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.qty, 250); assert.ok(Math.abs(pos.avg_price - (10010 * 100 + 10020 * 150) / 250) < 1e-6);
  assert.equal(pos.plan.stop, 9500); assert.equal(pos.plan.steps.length, 1);
  assert.equal(db.t.paper_fills.size, 2);
  assert.ok(db.t.paper_book_snaps.some(s => s.kind === 'fill' && s.code === '005930' && s.asks.length === 10 && s.bids.length === 10));
  assert.ok(db.t.trade_audit.some(a => a.event === 'paper_order' && a.ok && a.mode === 'VIRTUAL'));
  const s = await c.call('GET', '/trade/paper/state');
  assert.equal(s.body.positions[0].qty, 250); assert.equal(s.body.fills.length, 2);
  assert.equal(s.body.dayBuyKrw, Math.round(10010 * 100 + 10020 * 150));
  await c.close();
});

test('입력 검증: 종목·호가단위·상하한·수량', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const bad = async (b) => (await c.order({ code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 1, ...b })).status;
  assert.equal(await bad({ code: '12' }), 400);
  assert.equal(await bad({ side: 'short' }), 400);
  assert.equal(await bad({ qty: 0 }), 400);
  assert.equal(await bad({ qty: 1.5 }), 400);
  assert.equal(await bad({ price: 10005 }), 400);     // 호가단위(10원) 위반
  assert.equal(await bad({ price: 13010 }), 400);     // 상한가 초과
  assert.equal(await bad({ price: 6990 }), 400);      // 하한가 미만
  assert.equal(db.t.paper_orders.size, 0);
  await c.close();
});

test('한도: 1회 주문 한도 초과 거부', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: { VIRTUAL_MAX_ORDER_KRW: '1000000' } }); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 101 });
  assert.equal(r.status, 403); assert.match(r.body.error, /한도/);
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 100 })).status, 200);
  await c.close();
});

test('긴급 정지: 매수 거부 · 매도는 허용', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  await c.call('POST', '/trade/kill');
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 403);
  assert.equal((await c.order({ code: '005930', side: 'sell', type: 'market', qty: 10 })).status, 200);
  await c.close();
});

test('TRADING_ENABLED=0 이면 전부 거부', async () => {
  const db = fakeDb(), c = await boot(db, { envExtra: { TRADING_ENABLED: '0' } }); await c.login();
  assert.equal((await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 })).status, 403);
  await c.close();
});

test('매도: 보유 수량·미체결 매도 예약분을 넘으면 거부, 실현손익 기록', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  assert.equal((await c.order({ code: '005930', side: 'sell', type: 'market', qty: 1 })).status, 400);   // 보유 없음
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 100 });                               // 10010 x100
  const lim = await c.order({ code: '005930', side: 'sell', type: 'limit', price: 10200, qty: 60 });
  assert.equal(lim.body.order.status, 'open');
  assert.equal((await c.order({ code: '005930', side: 'sell', type: 'limit', price: 10300, qty: 50 })).status, 400);   // 100-60=40 만 가능
  const s = await c.order({ code: '005930', side: 'sell', type: 'market', qty: 40 });                     // 매수호가 10000 x40
  assert.equal(s.status, 200);
  const sold = [...db.t.paper_fills.values()].filter(f => f.side === 'sell');
  assert.equal(sold.length, 1); assert.equal(sold[0].realized, (10000 - 10010) * 40);
  await c.close();
});

test('대기 주문: 거래량이 앞 잔량을 넘어야 체결되고 평균단가·보유 반영', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 100 });   // 9990 에 이미 400주 대기
  assert.equal(r.body.order.status, 'open'); assert.equal(r.body.order.queueAhead, 400);
  c.st.clock += 5000; c.st.price = 9990; c.st.vol += 300;                 // 300주 거래 → 앞 잔량 100 남음
  await c.t.paper.tick();
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'open');
  c.st.clock += 5000; c.st.vol += 250;                                      // 250 → 앞 100 소진 후 100 체결(전량)
  await c.t.paper.tick();
  const o = db.t.paper_orders.get(r.body.order.id);
  assert.equal(o.status, 'filled'); assert.equal(o.filled_qty, 100); assert.equal(+o.avg_price, 9990);
  assert.equal(db.t.paper_positions.get('005930').qty, 100);
  await c.close();
});

test('대기 주문 취소', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9900, qty: 10 });
  const x = await c.call('POST', '/trade/paper/cancel', { body: { id: r.body.order.id } });
  assert.equal(x.status, 200); assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'cancelled');
  assert.equal((await c.call('POST', '/trade/paper/cancel', { body: { id: r.body.order.id } })).status, 409);
  assert.equal((await c.call('POST', '/trade/paper/cancel', { body: { id: 'nope' } })).status, 404);
  await c.close();
});

test('장 밖·휴장일·오래된 시세·VI·거래정지는 주문 거부', async () => {
  let db = fakeDb(), c = await boot(db, { clock: Date.parse('2027-01-13T08:30:00+09:00') }); await c.login();
  const ord = { code: '005930', side: 'buy', type: 'market', qty: 1 };
  assert.equal((await c.order(ord)).status, 409);
  await c.close();
  db = fakeDb(); c = await boot(db, { clock: Date.parse('2027-01-16T10:00:00+09:00') }); await c.login();   // 토요일
  assert.equal((await c.order(ord)).status, 409); await c.close();
  db = fakeDb(); c = await boot(db); await c.login();
  c.st.closedDay = true; assert.match((await c.order(ord)).body.error, /휴장/);
  await c.close(); db = fakeDb(); c = await boot(db); await c.login();   // 휴장일 조회 결과는 하루 동안 캐시되므로 새로 시작
  c.st.hourOverride = '093000'; assert.match((await c.order(ord)).body.error, /갱신/); c.st.hourOverride = null; c.st.clock += 2000;   // 시세 캐시(1.5초) 지나게
  c.st.vi = true; assert.match((await c.order(ord)).body.error, /VI/); c.st.vi = false; c.st.clock += 2000;
  c.st.warnings = ['거래정지'];
  assert.match((await c.order(ord)).body.error, /거래정지/);
  assert.equal(db.t.paper_orders.size, 0);
  await c.close();
});

test('서버 재시작: 보유·미체결 복구, 재시작 사이 거래량은 체결로 인정하지 않음', async () => {
  const db = fakeDb(); let c = await boot(db); await c.login();
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  const r = await c.order({ code: '005930', side: 'buy', type: 'limit', price: 9990, qty: 50 });
  await c.close();
  const c2 = await boot(db, { clock: T0 + 60000 }); await c2.login();
  const s = await c2.call('GET', '/trade/paper/state');
  assert.equal(s.body.positions[0].qty, 10); assert.ok(s.body.orders.some(o => o.id === r.body.order.id && o.status === 'open'));
  c2.st.price = 9980; c2.st.vol += 100000; c2.st.low = 9000; c2.st.clock += 5000;   // 재시작 사이 크게 거래됨
  await c2.t.paper.tick();
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'open');            // 첫 시세는 기준만 잡음
  c2.st.vol += 2000; c2.st.clock += 5000; await c2.t.paper.tick();                 // 이후 거래량은 인정(가격이 내 가격 아래)
  assert.equal(db.t.paper_orders.get(r.body.order.id).status, 'filled');
  await c2.close();
});

test('호가 스냅: 09:00·12:00·15:10 은 보유·미체결 종목만, 슬롯당 한 번, 14일 지난 스냅 삭제', async () => {
  const db = fakeDb(), c = await boot(db, { clock: Date.parse('2027-01-13T09:00:10+09:00') }); await c.login();
  await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  const base = db.t.paper_book_snaps.length;                                       // 체결 시점 스냅 1건 포함
  await c.t.paper.tick(); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.filter(s => s.kind === 'open').length, 1);
  assert.ok(db.t.deleted.some(d => d.startsWith('paper_book_snaps?ts=lt.')));
  c.st.clock = Date.parse('2027-01-13T12:00:20+09:00'); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.filter(s => s.kind === 'noon').length, 1);
  c.st.clock = Date.parse('2027-01-13T15:10:05+09:00'); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.filter(s => s.kind === 'close').length, 1);
  c.st.clock = Date.parse('2027-01-13T11:00:00+09:00'); await c.t.paper.tick();
  assert.equal(db.t.paper_book_snaps.length, base + 3);                            // 다른 시각엔 안 쌓임
  await c.close();
});

test('테이블이 없으면 503(설정 안내), 주문 저장 실패 시 주문 안 만듦', async () => {
  let db = fakeDb(); db.setFail({ get: '42P01 relation does not exist' });
  let c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 503); assert.match(r.body.error, /missing/);
  await c.close();
  db = fakeDb(); c = await boot(db); await c.login();
  db.setFail({ write: 'paper_orders' });
  const r2 = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r2.status, 503); assert.equal((await c.call('GET', '/trade/paper/state')).body.orders.length, 0);
  await c.close();
});

test('체결 기록 저장이 실패하면 다음 주기에 다시 저장', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  db.setFail({ write: 'paper_fills' });
  const r = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 10 });
  assert.equal(r.status, 200); assert.equal(db.t.paper_fills.size, 0);
  db.setFail(null); c.st.clock += 5000; await c.t.paper.tick();
  assert.equal(db.t.paper_fills.size, 1);
  await c.close();
});
