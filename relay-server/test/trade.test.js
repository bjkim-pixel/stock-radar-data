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
  const env = { ALLOWED_EMAIL: 'Owner@Example.com', SUPABASE_ANON_KEY: 'anon', TRADE_PIN_HASH: pinHash, TRADING_ENABLED: '1', ...envExtra };
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
  const call = async (method, path, { token = GOOD, session, body, origin = ORIGIN, ip, raw } = {}) => {
    const headers = { 'content-type': 'application/json' };
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
  clock += 10 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session })).status, 200);
  clock += 10 * 60000;   // 마지막 사용 후 10분 → 아직 유효(연장됨)
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session })).status, 200);
  clock += 16 * 60000;
  assert.equal((await c.call('GET', '/trade/ping', { session: body.session })).status, 401);
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
