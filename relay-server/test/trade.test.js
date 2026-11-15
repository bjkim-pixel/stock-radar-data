'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createTrade, hashPin, verifyHash, checkLimits, loadConfig, scrub } = require('../trade');

const ORIGIN = 'https://bjkim-pixel.github.io';
const GOOD = 'good-token-0123456789abcdef', OTHER = 'other-token-0123456789abcdef';
let clock = 1_800_000_000_000;

async function boot(envExtra = {}, opts = {}) {
  const pinHash = await hashPin('123456', 100000);
  const audits = [], alerts = [], supaCalls = [];
  const env = { ALLOWED_EMAIL: 'Owner@Example.com', SUPABASE_ANON_KEY: 'anon', TRADE_PIN_HASH: pinHash, TRADING_ENABLED: '1', TRADE_APPROVAL: '0', TRADE_MAX_SESSIONS: '3', ...envExtra };
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/auth/v1/user')) {
      supaCalls.push(init.headers.Authorization);
      const tok = init.headers.Authorization.replace('Bearer ', '');
      if (tok === GOOD) return { ok: true, status: 200, json: async () => ({ id: 'uid-1', email: 'owner@example.com' }) };
      if (tok === OTHER) return { ok: true, status: 200, json: async () => ({ id: 'uid-2', email: 'x@example.com' }) };
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200 };
  };
  const t = createTrade({
    env, now: () => clock, fetch: fakeFetch, allowedOrigins: [ORIGIN],
    clientIp: req => req.headers['x-test-ip'] || '1.1.1.1',
    sbWrite: async (tbl, m, rows) => { audits.push(...rows); },
    notify: async (text) => { alerts.push(text); },
    ...opts,
  });
  const server = http.createServer((req, res) => { if (!t.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const call = async (method, path, { token = GOOD, session, body, origin = ORIGIN, ip, raw, h } = {}) => {
    const headers = { 'content-type': 'application/json', ...(h || {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (session) headers['x-trade-session'] = session;
    if (origin) headers.origin = origin;
    if (ip) headers['x-test-ip'] = ip;
    let b;
    if (method === 'POST') b = raw !== undefined ? raw : JSON.stringify({ nonce: 'n' + (++n) + 'abcdefghijkl', ts: clock, ...body });
    const r = await fetch(base + path, { method, headers, body: b });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { t, call, audits, alerts, supaCalls, close: () => new Promise(r => server.close(r)) };
}
const open = async (c, pin = '123456') => (await c.call('POST', '/trade/session', { body: { pin } }));

test('PIN 해시: 맞는 PIN만 통과, 형식 이상은 거부', async () => {
  const h = await hashPin('987654', 100000);
  assert.equal(await verifyHash('987654', h), true);
  assert.equal(await verifyHash('987655', h), false);
  assert.equal(await verifyHash('987654', 'plain'), false);
  assert.equal(await verifyHash('987654', 'pbkdf2$5$AAAA$BBBB'), false);
});

test('로그인 토큰 없음/가짜/다른 계정은 거부, 본인만 통과', async () => {
  const c = await boot();
  assert.equal((await c.call('GET', '/trade/status', { token: null })).status, 401);
  assert.equal((await c.call('GET', '/trade/status', { token: 'short' })).status, 401);
  assert.equal((await c.call('GET', '/trade/status', { token: 'fake-token-0123456789abcdef' })).status, 401);
  const w = await c.call('GET', '/trade/status', { token: OTHER });
  assert.equal(w.status, 403);
  assert.ok(c.alerts.some(a => /허용되지 않은 계정/.test(a)));
  const ok = await c.call('GET', '/trade/status');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enabled, true);
  assert.equal(ok.body.realEnabled, false);
  assert.equal(ok.body.session.active, false);
  await c.close();
});

test('ALLOWED_EMAIL 미설정이면 전부 거부', async () => {
  const c = await boot({ ALLOWED_EMAIL: '' });
  assert.equal((await c.call('GET', '/trade/status')).status, 503);
  await c.close();
});

test('토큰 검증 결과는 60초 캐시(Supabase 호출 1회)', async () => {
  const c = await boot();
  await c.call('GET', '/trade/status'); await c.call('GET', '/trade/status');
  assert.equal(c.supaCalls.length, 1);
  clock += 61000;
  await c.call('GET', '/trade/status');
  assert.equal(c.supaCalls.length, 2);
  await c.close();
});

test('PIN: 맞으면 세션 발급, 세션 없이 ping/resume은 거부', async () => {
  const c = await boot();
  assert.equal((await c.call('GET', '/trade/ping')).status, 401);
  assert.equal((await c.call('POST', '/trade/resume')).status, 401);
  const r = await open(c);
  assert.equal(r.status, 200);
  assert.match(r.body.session, /^[0-9a-f]{64}$/);
  assert.equal(r.body.ttlSec, 900);
  const p = await c.call('GET', '/trade/ping', { session: r.body.session });
  assert.equal(p.status, 200);
  assert.equal((await c.call('GET', '/trade/ping', { session: 'a'.repeat(64) })).status, 401);
  assert.ok(c.audits.some(a => a.event === 'session_open' && a.ok));
  await c.close();
});

test('PIN 5회 틀리면 30분 잠금(맞는 PIN도 거부) → 시간이 지나면 해제, 알림 발송', async () => {
  const c = await boot();
  for (let i = 0; i < 4; i++) { const r = await open(c, '000000'); assert.equal(r.status, 401); assert.equal(r.body.left, 4 - i); }
  const l = await open(c, '000000');
  assert.equal(l.status, 423);
  assert.equal((await open(c, '123456')).status, 423);
  assert.ok(c.alerts.some(a => /잠겼습니다/.test(a)));
  clock += 31 * 60000;
  assert.equal((await open(c, '123456')).status, 200);
  await c.close();
});

test('PIN 동시 시도로 횟수 제한을 우회할 수 없음', async () => {
  const c = await boot();
  const rs = await Promise.all(Array.from({ length: 12 }, () => open(c, '000000')));
  assert.equal(rs.filter(r => r.status === 401).length, 4);
  assert.ok(rs.filter(r => r.status === 423).length >= 8);
  await c.close();
});

test('세션: 15분 지나면 만료, 사용하면 연장, 다른 사용자 불가', async () => {
  const c = await boot();
  const { body } = await open(c);
  const act = { 'x-active': '1' };
  clock += 4 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session, h: act })).status, 200);
  clock += 4 * 60000;   // 마지막 사용 후 4분 → 아직 유효(연장됨)
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session, h: act })).status, 200);
  clock += 16 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session, h: act })).status, 401);
  await c.close();
});

test('세션 잠금(lock) 후 사용 불가', async () => {
  const c = await boot();
  const { body } = await open(c);
  assert.equal((await c.call('POST', '/trade/lock', { session: body.session })).status, 200);
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session })).status, 401);
  await c.close();
});

test('재전송 방어: 같은 nonce 재사용·오래된 ts·nonce 없음 거부', async () => {
  const c = await boot();
  const body = JSON.stringify({ nonce: 'abcdefghijkl1234', ts: clock, pin: '123456' });
  assert.equal((await c.call('POST', '/trade/session', { raw: body })).status, 200);
  assert.equal((await c.call('POST', '/trade/session', { raw: body })).body.error, 'replay');
  const old = JSON.stringify({ nonce: 'zzzzzzzzzzzz9999', ts: clock - 31000, pin: '123456' });
  assert.equal((await c.call('POST', '/trade/session', { raw: old })).body.error, 'expired');
  assert.equal((await c.call('POST', '/trade/session', { raw: JSON.stringify({ pin: '123456' }) })).body.error, 'bad request');
  assert.equal((await c.call('POST', '/trade/session', { raw: 'not json' })).status, 400);
  await c.close();
});

test('긴급 정지: kill은 로그인만으로, resume은 PIN 세션 필요, guard 반영', async () => {
  const c = await boot({ TRADE_HOURS: '00:00-23:59' });
  assert.equal(c.t.guard('buy', 'VIRTUAL').ok, true);
  assert.equal((await c.call('POST', '/trade/kill')).status, 200);
  assert.equal(c.t.guard('buy', 'VIRTUAL').error, 'halted');
  assert.equal(c.t.guard('sell', 'VIRTUAL').ok, true);        // 정지 중에도 매도·취소 가능
  assert.equal((await c.call('POST', '/trade/resume')).status, 401);
  const { body } = await open(c);
  assert.equal((await c.call('POST', '/trade/resume', { session: body.session })).status, 200);
  assert.equal(c.t.guard('buy', 'VIRTUAL').ok, true);
  assert.ok(c.alerts.some(a => /긴급 정지/.test(a)));
  await c.close();
});

test('guard: TRADING_ENABLED 꺼짐/실전 스위치/시간대', async () => {
  let c = await boot({ TRADING_ENABLED: '0' });
  assert.equal(c.t.guard('sell', 'VIRTUAL').error, 'trading disabled'); await c.close();
  c = await boot({ TRADE_HOURS: '00:00-23:59' });
  assert.equal(c.t.guard('buy', 'REAL').error, 'real trading disabled');
  assert.equal(c.t.guard('buy', 'VIRTUAL').ok, true); await c.close();
  c = await boot({ REAL_TRADING_ENABLED: '1', TRADE_HOURS: '09:00-15:30' });
  clock = Date.UTC(2027, 0, 5, 0, 30);   // KST 09:30
  assert.equal(c.t.guard('buy', 'REAL').ok, true);
  clock = Date.UTC(2027, 0, 5, 12, 0);   // KST 21:00
  assert.equal(c.t.guard('buy', 'REAL').error, 'outside trading hours');
  assert.equal(c.t.guard('sell', 'REAL').ok, true);
  await c.close();
});

test('한도: 1회·1일·보유 종목 수', () => {
  const L = loadConfig({}).limits;
  assert.equal(L.REAL.order, 500000); assert.equal(L.REAL.day, 2000000); assert.equal(L.REAL.positions, 5);
  assert.equal(checkLimits(L, { mode: 'REAL', orderKrw: 500000 }).ok, true);
  assert.match(checkLimits(L, { mode: 'REAL', orderKrw: 500001 }).error, /1회/);
  assert.match(checkLimits(L, { mode: 'REAL', orderKrw: 400000, dayKrw: 1700000 }).error, /1일/);
  assert.match(checkLimits(L, { mode: 'REAL', orderKrw: 100000, positions: 5 }).error, /보유/);
  assert.equal(checkLimits(L, { mode: 'REAL', orderKrw: 100000, positions: 5, isNewPosition: false }).ok, true);
  assert.equal(checkLimits(L, { mode: 'REAL', orderKrw: NaN }).ok, false);
  assert.equal(checkLimits(L, { mode: 'REAL', orderKrw: -5 }).ok, false);
});

test('허용되지 않은 Origin의 POST 거부 + 감사 기록에 PIN 원문 없음', async () => {
  const c = await boot();
  assert.equal((await c.call('POST', '/trade/session', { origin: 'https://evil.example', body: { pin: '123456' } })).status, 403);
  await open(c, '999999');
  const dump = JSON.stringify(c.audits);
  assert.ok(!dump.includes('999999') && !dump.includes('123456') && !dump.includes(GOOD));
  assert.deepEqual(scrub({ pin: '1', token: 'x', a: { appkey: 'y', ok: 1 } }), { pin: '[숨김]', token: '[숨김]', a: { appkey: '[숨김]', ok: 1 } });
  await c.close();
});

test('IP당 분당 120회 초과 시 429', async () => {
  const c = await boot();
  let last;
  for (let i = 0; i < 125; i++) last = await c.call('GET', '/trade/status', { token: null, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
  await c.close();
});

/* ── 검토(2026-11-12) 이후 추가 ── */
async function bootWith(rowsByQuery, extra = {}) {
  return boot({ TRADE_HOURS: '00:00-23:59' }, {
    sbGet: async (q) => {
      for (const [k, v] of Object.entries(rowsByQuery)) if (q.includes(k)) { if (v instanceof Error) throw v; return v; }
      return [];
    },
    ...extra,
  });
}

test('재시작 복구: 마지막 기록이 kill이면 정지 상태로 시작', async () => {
  const c = await bootWith({ 'in.(kill,resume)': [{ event: 'kill', ts: new Date(clock).toISOString() }] });
  await c.t.ready();
  assert.equal(c.t.guard('buy', 'VIRTUAL').error, 'halted');
  await c.close();
});

test('재시작 복구: 30분 안의 PIN 5회 실패는 잠금 유지', async () => {
  const ts = new Date(clock - 5 * 60000).toISOString();
  const c = await bootWith({ 'in.(pin_fail,session_open)': Array.from({ length: 5 }, () => ({ event: 'pin_fail', ts })) });
  await c.t.ready();
  assert.equal((await open(c)).status, 423);
  await c.close();
});

test('재시작 복구: 실패 3회 기록 후 재시작해도 남은 시도는 2회', async () => {
  const ts = new Date(clock - 60000).toISOString();
  const c = await bootWith({ 'in.(pin_fail,session_open)': [{ event: 'pin_fail', ts }, { event: 'pin_fail', ts }, { event: 'pin_fail', ts }] });
  await c.t.ready();
  const r = await open(c, '000000');
  assert.equal(r.body.left, 1);
  await c.close();
});

test('재시작 복구 실패(DB 오류)면 안전하게 신규 매수 정지 + 알림', async () => {
  const c = await bootWith({ 'in.(kill,resume)': new Error('db 500') });
  await c.t.ready();
  assert.equal(c.t.guard('buy', 'VIRTUAL').error, 'halted');
  assert.ok(c.alerts.some(a => /정지했습니다/.test(a)));
  await c.close();
});

test('해제(resume) 기록을 못 남기면 해제하지 않음', async () => {
  let fail = false;
  const c = await boot({ TRADE_HOURS: '00:00-23:59' }, { sbWrite: async () => { if (fail) throw new Error('db down'); } });
  assert.equal((await c.call('POST', '/trade/kill')).status, 200);
  const { body } = await open(c);
  fail = true;
  assert.equal((await c.call('POST', '/trade/resume', { session: body.session })).status, 503);
  assert.equal(c.t.guard('buy', 'VIRTUAL').error, 'halted');
  await c.close();
});

test('IP: cf-connecting-ip 우선, 없으면 X-Forwarded-For 맨 오른쪽(앞쪽 위조 무시)', async () => {
  const seen = [];
  const ipOf = (h) => createTrade({ env: {}, sbWrite: async (_t, _m, rows) => seen.push(rows[0].ip) }).audit('x', true, {}, { headers: h });
  await ipOf({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' });
  await ipOf({ 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6' });
  assert.deepEqual(seen, ['1.2.3.4', '5.5.5.5']);
});

/* ── 2단계: 시세·호가 조회 ── */
function fakeKis(calls) {
  return async (path, trId, params) => {
    calls.push(trId);
    if (trId === 'FHKST01010100') return { output: { stck_prpr: '206,500', prdy_vrss: '500', prdy_ctrt: '0.24', prdy_vrss_sign: '2', stck_oprc: '208500', stck_hgpr: '214000', stck_lwpr: '206000', stck_sdpr: '206000', stck_mxpr: '267500', stck_llam: '144500', acml_vol: '19721557', acml_tr_pbmn: '4126896638615', aspr_unit: '500', vi_cls_code: 'N', temp_stop_yn: 'N', mrkt_warn_cls_code: '02', short_over_yn: 'Y', iscd_stat_cls_code: '55' } };
    if (trId === 'FHKST01010200') {
      const o1 = { aspr_acpt_hour: '200000', total_askp_rsqn: '178320', total_bidp_rsqn: '119718' };
      for (let i = 1; i <= 10; i++) { o1['askp' + i] = String(206500 + (i - 1) * 500); o1['bidp' + i] = String(206000 - (i - 1) * 500); o1['askp_rsqn' + i] = String(100 * i); o1['bidp_rsqn' + i] = String(1000 - 50 * i); }
      return { output1: o1, output2: { vi_cls_code: 'Y' } };
    }
    return { output: [{ tday_rltv: '114.83' }] };
  };
}
test('시세: 로그인 필요, 코드 형식 검증, 필드 변환', async () => {
  const calls = [];
  const c = await boot({}, { kisGet: fakeKis(calls) });
  assert.equal((await c.call('GET', '/trade/quote?code=005930', { token: null })).status, 401);
  assert.equal((await c.call('GET', '/trade/quote?code=abc')).status, 400);
  assert.equal((await c.call('GET', '/trade/quote')).status, 400);
  const r = await c.call('GET', '/trade/quote?code=005930');
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.price, 206500); assert.equal(b.upper, 267500); assert.equal(b.lower, 144500); assert.equal(b.tick, 500);
  assert.equal(b.strength, 114.83); assert.equal(b.vi, true);
  assert.deepEqual(b.warnings.sort(), ['단기과열', '투자경고']);
  assert.equal(b.asks.length, 10); assert.equal(b.bids.length, 10);
  assert.deepEqual(b.asks[0], { p: 206500, q: 100 }); assert.deepEqual(b.bids[0], { p: 206000, q: 950 });
  assert.equal(b.totalAsk, 178320); assert.equal(b.totalBid, 119718);
  await c.close();
});

test('시세: 1.5초 캐시·동시 요청 1번, 체결강도는 5초 캐시, KIS 오류는 502', async () => {
  const calls = [];
  const c = await boot({}, { kisGet: fakeKis(calls) });
  await Promise.all([c.call('GET', '/trade/quote?code=005930'), c.call('GET', '/trade/quote?code=005930')]);
  assert.equal(calls.filter(x => x === 'FHKST01010200').length, 1);
  clock += 2000;
  await c.call('GET', '/trade/quote?code=005930');
  assert.equal(calls.filter(x => x === 'FHKST01010200').length, 2);
  assert.equal(calls.filter(x => x === 'FHKST01010300').length, 1);   // 5초 안이라 체결강도는 재조회 안 함
  await c.close();
  const c2 = await boot({}, { kisGet: async () => { throw new Error('KIS down'); } });
  assert.equal((await c2.call('GET', '/trade/quote?code=005930')).status, 502);
  await c2.close();
});

/* ── 2026-11-15: 접속 기기·IP 식별, 알림 강화, 보안 로그 ── */
const DEV = (id, n, m) => ({ 'x-device-id': id, 'x-device-info': encodeURIComponent(JSON.stringify({ n, m })) });
const PHONE = DEV('a1b2c3d4e5f60718a1b2c3d4e5f60718', '갤럭시 S26 울트라', 'SM-S948N');
const PAD = DEV('b1b2c3d4e5f60718a1b2c3d4e5f60718', 'iPlay 50 mini Pro', 'iPlay 50 mini Pro');

test('세션 열림 알림에 기기·IP·실전 스위치 표시, 감사 기록에 기기 정보 저장', async () => {
  const c = await boot();
  const r = await open2(c, PHONE, '9.9.9.9');
  assert.equal(r.status, 200);
  const a = c.alerts.find(x => /거래 세션 열림/.test(x));
  assert.match(a, /갤럭시 S26 울트라 \(SM-S948N\)/); assert.match(a, /9\.9\.9\.9/); assert.match(a, /실전 스위치 OFF/);
  const row = c.audits.find(x => x.event === 'session_open');
  assert.equal(row.detail.dev.n, '갤럭시 S26 울트라'); assert.equal(row.detail.dev.m, 'SM-S948N'); assert.equal(row.detail.dev.id, PHONE['x-device-id']);
  assert.equal(row.detail.real, false);
  await c.close();
});
async function open2(c, h, ip, pin = '123456') { return c.call('POST', '/trade/session', { body: { pin }, h, ip }); }

test('이력이 로드된 뒤 처음 보는 기기·IP는 경고, 본 기기는 경고 없음', async () => {
  const hist = [{ ip: '9.9.9.9', detail: { dev: { id: PHONE['x-device-id'], n: '갤럭시 S26 울트라' } } }];
  const c = await boot({}, { sbGet: async q => (/session_open/.test(q) ? hist : []) });
  await c.t.ready();
  await open2(c, PHONE, '9.9.9.9');
  assert.ok(!c.alerts.some(x => /새 기기|새 IP/.test(x)), '본 기기·IP는 경고 없음');
  c.alerts.length = 0;
  await open2(c, DEV('c1b2c3d4e5f60718a1b2c3d4e5f60718', '모르는 폰', 'Pixel 9'), '7.7.7.7');
  const a = c.alerts.find(x => /거래 세션 열림/.test(x));
  assert.match(a, /🚨 .*새 기기/); assert.match(a, /새 IP/);
  assert.deepEqual(c.audits.filter(x => x.event === 'session_open').at(-1).detail.flags, ['새 기기', '새 IP']);
  await c.close();
});

test('태블릿(iPlay)은 집 IP 대역 밖이면 🚨 경고', async () => {
  const c = await boot({ HOME_IP_PREFIXES: '125.241.' }, { sbGet: async () => [] });
  await c.t.ready();
  await open2(c, PAD, '125.241.1.2');
  assert.ok(!c.alerts.some(x => /집 밖/.test(x)));
  c.alerts.length = 0;
  await open2(c, PAD, '211.1.1.1');
  assert.match(c.alerts.find(x => /거래 세션 열림/.test(x)), /집 밖 접속/);
  await c.close();
});

test('기기 헤더 없으면 "기기 정보 없음" 경고, 잘못된 헤더는 무시', async () => {
  const c = await boot();
  await open2(c, { 'x-device-id': 'zz', 'x-device-info': '%E0%A4%A' }, '1.2.3.4');
  assert.match(c.alerts.find(x => /거래 세션 열림/.test(x)), /기기 정보 없음/);
  await c.close();
});

test('PIN 오류·잠금·kill·잠그기 알림에도 기기·IP 포함', async () => {
  const c = await boot();
  await open2(c, PHONE, '9.9.9.9', '000000');
  assert.match(c.alerts.find(x => /PIN 오류/.test(x)), /9\.9\.9\.9/);
  const s = await open2(c, PHONE, '9.9.9.9');
  await c.call('POST', '/trade/kill', { h: PHONE, ip: '9.9.9.9' });
  assert.match(c.alerts.find(x => /긴급 정지/.test(x)), /갤럭시 S26 울트라/);
  await c.call('POST', '/trade/lock', { session: s.body.session, h: PHONE, ip: '9.9.9.9' });
  assert.match(c.alerts.find(x => /세션 잠금/.test(x)), /9\.9\.9\.9/);
  await c.close();
});

test('텔레그램 관리 API: 상태·전체 세션 종료·긴급 정지', async () => {
  const c = await boot();
  const s = await open2(c, PHONE, '9.9.9.9');
  assert.match(c.t.adminStatus(), /열린 거래 세션 1개/);
  assert.equal(await c.t.adminLock('telegram'), 1);
  assert.equal((await c.call('GET', '/trade/ping', { session: s.body.session })).status, 401);
  await c.t.adminKill('telegram');
  assert.equal((await c.call('GET', '/trade/status')).body.halted, true);
  assert.ok(c.audits.some(x => x.event === 'session_close_all' && x.detail.via === 'telegram'));
  assert.ok(c.audits.some(x => x.event === 'kill' && x.detail.via === 'telegram'));
  await c.close();
});

test('GET /trade/audit: 로그인 필요, 기록 반환', async () => {
  const rows = [{ ts: '2026-11-14T14:05:16Z', event: 'session_open', ok: true, ip: '9.9.9.9', detail: {} }];
  const c = await boot({}, { sbGet: async q => (/trade_audit\?select=ts/.test(q) ? rows : []) });
  assert.equal((await c.call('GET', '/trade/audit', { token: null })).status, 401);
  const r = await c.call('GET', '/trade/audit?days=7');
  assert.equal(r.status, 200); assert.equal(r.body.rows.length, 1); assert.equal(r.body.realEnabled, false);
  await c.close();
});

test('보안 요약: 세션·기기·실패·로그인 기록 집계', async () => {
  const rows = [
    { ts: '2026-11-14T14:05:16Z', event: 'session_open', ip: '9.9.9.9', detail: { dev: { n: '갤럭시 S26 울트라' }, flags: ['새 IP'] } },
    { ts: '2026-11-14T14:06:16Z', event: 'pin_fail', ip: '9.9.9.9', detail: {} }];
  const c = await boot({}, { sbGet: async q => (/auth_audit/.test(q) ? [{ ts: 'x', action: 'login', ip: '9.9.9.9' }] : rows) });
  const t = await c.t.securitySummary(24);
  assert.match(t, /세션 열림 1회/); assert.match(t, /갤럭시 S26 울트라 1/); assert.match(t, /실패\/거부 1건/); assert.match(t, /사이트 로그인 1회/); assert.match(t, /새 IP/);
  await c.close();
});

const DEV3 = { 'x-device-id': 'aaaaaaaaaaaaaaaaaaaa', 'x-device-info': encodeURIComponent(JSON.stringify({ n: '폰', m: 'SM-S948N' })) };
const sess = (c, h) => c.call('POST', '/trade/session', { body: { pin: '123456' }, h });

test('무조작 5분이면 자동 잠금, 조작(x-active)이 있으면 유지', async () => {
  const c = await boot();
  const { body } = await open(c);
  clock += 4 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session })).status, 200);   // 조작 표시 없는 조회는 활동으로 안 침
  clock += 2 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session })).status, 401);
  const b2 = (await open(c)).body;
  clock += 4 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: b2.session, h: { 'x-active': '1' } })).status, 200);
  clock += 4 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: b2.session })).status, 200);
  await c.close();
});

test('동시 세션 1개: 새로 열면 기존 세션 종료', async () => {
  const c = await boot({ TRADE_MAX_SESSIONS: '1' });
  const a = (await open(c)).body, b = (await open(c)).body;
  assert.equal((await c.call('GET', '/trade/ping', { session: a.session, h: { 'x-active': '1' } })).status, 401);
  assert.equal((await c.call('GET', '/trade/ping', { session: b.session, h: { 'x-active': '1' } })).status, 200);
  await c.close();
});

test('새 기기: PIN 통과해도 텔레그램 승인 전엔 세션 없음 → 승인하면 열림·기기 등록', async () => {
  const c = await boot({ TRADE_APPROVAL: '1' });
  const r = await sess(c, DEV3);
  assert.equal(r.status, 202); assert.ok(r.body.pending && r.body.reqId && !r.body.session);
  const code = /\/승인 (\d{4})/.exec(c.alerts.join('\n'))[1];
  assert.equal((await c.call('POST', '/trade/session/poll', { body: { reqId: r.body.reqId }, h: DEV3 })).status, 202);
  assert.equal((await c.call('POST', '/trade/session/poll', { body: { reqId: r.body.reqId } })).status, 404);   // 다른 기기는 확인 불가
  assert.match(await c.t.adminDecide('0000', true), /없어요/);
  assert.match(await c.t.adminDecide(code, true), /승인/);
  const p = await c.call('POST', '/trade/session/poll', { body: { reqId: r.body.reqId }, h: DEV3 });
  assert.equal(p.status, 200); assert.ok(p.body.session);
  const again = await sess(c, DEV3);   // 등록된 기기 → 바로 열림
  assert.equal(again.status, 200); assert.ok(again.body.session);
  await c.close();
});

test('승인 거부·만료, 실전 스위치 ON 이면 등록 기기도 승인 필요', async () => {
  const c = await boot({ TRADE_APPROVAL: '1' });
  const r = await sess(c, DEV3);
  const code = /\/승인 (\d{4})/.exec(c.alerts.join('\n'))[1];
  await c.t.adminDecide(code, false);
  assert.equal((await c.call('POST', '/trade/session/poll', { body: { reqId: r.body.reqId }, h: DEV3 })).status, 403);
  const r2 = await sess(c, DEV3);
  clock += 4 * 60000;
  assert.equal((await c.call('POST', '/trade/session/poll', { body: { reqId: r2.body.reqId }, h: DEV3 })).status, 403);   // 만료
  await c.close();
  const d = await boot({ TRADE_APPROVAL: '1', REAL_TRADING_ENABLED: '1' });
  const code2 = (async () => { const q = await sess(d, DEV3); return [q, /\/승인 (\d{4})/.exec(d.alerts.join('\n'))[1]]; })();
  const [q, cd] = await code2;
  await d.t.adminDecide(cd, true);
  assert.equal((await d.call('POST', '/trade/session/poll', { body: { reqId: q.body.reqId }, h: DEV3 })).status, 200);
  assert.equal((await sess(d, DEV3)).status, 202);   // 이제 등록된 기기지만 실전 ON → 또 승인 필요
  await d.close();
});
