'use strict';
/* 0단계: 주문 권한 잠금 · /health/engine 판정 · 엔진 감시 표시 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderLock, evalHealth } = require('../engine-guard');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

/* PostgREST 흉내: engine_lock 한 줄. 조건부 PATCH(or=(holder.eq.X,expires_at.lt.ISO)) · 중복 무시 POST · GET */
function fakeRest(clock) {
  const st = { row: null, fail: null, calls: 0 };
  const rest = async (path, method, body, prefer) => {
    st.calls++;
    if (st.fail) throw new Error(typeof st.fail === 'string' ? st.fail : 'x');
    if (method === 'GET') return st.row ? [{ holder: st.row.holder, expires_at: st.row.expires_at }] : [];
    if (method === 'POST') { if (st.row) return []; st.row = { ...body[0] }; return [{ ...st.row }]; }
    const m = /holder\.eq\.([A-Za-z0-9_-]+),expires_at\.lt\.([^)]+)\)/.exec(path), m2 = /&holder=eq\.([A-Za-z0-9_-]+)$/.exec(path);
    if (m) { if (st.row && (st.row.holder === m[1] || Date.parse(st.row.expires_at) < Date.parse(decodeURIComponent(m[2])))) { st.row = { ...st.row, ...body }; return [{ ...st.row }]; } return []; }
    if (m2) { if (st.row && st.row.holder === m2[1]) { st.row = { ...st.row, ...body }; } return []; }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  return { st, rest };
}
const mk = (clock, fr, id, extra = {}) => createOrderLock({ now: () => clock.t, rest: fr.rest, instanceId: id, ttlMs: 30000, log: () => {}, ...extra });

test('잠금: 먼저 잡은 쪽만 권한, 두 번째는 대기', async () => {
  const clock = { t: Date.parse('2026-11-18T01:00:00Z') }, fr = fakeRest(clock), got = [];
  const A = mk(clock, fr, 'A', { onAcquire: () => got.push('A') }), B = mk(clock, fr, 'B', { onAcquire: () => got.push('B') });
  assert.equal(A.hasAuthority(), false);               // 첫 확인 전에는 권한 없음(안전 쪽)
  await A.attempt(); await B.attempt();
  assert.equal(A.hasAuthority(), true); assert.equal(B.hasAuthority(), false);
  assert.deepEqual(got, ['A']);
  assert.equal(B.status().holder, 'A');
  clock.t += 5000; await A.attempt(); await B.attempt();          // 연장해도 그대로, onAcquire 는 다시 안 불림
  assert.equal(A.hasAuthority(), true); assert.equal(B.hasAuthority(), false); assert.deepEqual(got, ['A']);
});

test('잠금: 정상 종료(반납)하면 새 인스턴스가 바로 이어받는다', async () => {
  const clock = { t: Date.parse('2026-11-18T01:00:00Z') }, fr = fakeRest(clock), got = [];
  const A = mk(clock, fr, 'A'), B = mk(clock, fr, 'B', { onAcquire: () => got.push('B') });
  await A.attempt(); await B.attempt(); assert.equal(B.hasAuthority(), false);
  assert.equal(await A.release(), true);
  assert.equal(A.hasAuthority(), false);
  await B.attempt();
  assert.equal(B.hasAuthority(), true); assert.deepEqual(got, ['B']);
});

test('잠금: 옛 인스턴스가 갱신을 못 하고 죽으면 임대 만료 뒤 이어받는다 · 옛 쪽은 만료 전에 스스로 권한을 내려놓는다', async () => {
  const clock = { t: Date.parse('2026-11-18T01:00:00Z') }, fr = fakeRest(clock);
  const A = mk(clock, fr, 'A'), B = mk(clock, fr, 'B');
  await A.attempt(); await B.attempt();
  clock.t += 20000; await B.attempt(); assert.equal(B.hasAuthority(), false);   // 아직 유효
  clock.t += 6000;                                                              // A 의 로컬 유효(25초)는 지남 — 서버 만료(30초)보다 먼저
  assert.equal(A.hasAuthority(), false, '옛 인스턴스는 서버 만료 전에 스스로 멈춘다');
  assert.equal(B.hasAuthority(), false);
  clock.t += 6000; await B.attempt(); assert.equal(B.hasAuthority(), true);
});

test('잠금: 네트워크 오류는 임대 만료 시각까지만 권한 유지, 첫 확인도 못 했으면 권한 없음', async () => {
  const clock = { t: Date.parse('2026-11-18T01:00:00Z') }, fr = fakeRest(clock);
  const A = mk(clock, fr, 'A'); fr.st.fail = 'fetch failed';
  await A.attempt(); assert.equal(A.hasAuthority(), false);
  fr.st.fail = null; await A.attempt(); assert.equal(A.hasAuthority(), true);
  fr.st.fail = 'fetch failed'; clock.t += 10000; await A.attempt();
  assert.equal(A.hasAuthority(), true);
  clock.t += 20000; await A.attempt();
  assert.equal(A.hasAuthority(), false);
  assert.match(A.status().lastErr, /fetch failed/);
});

test('잠금: 테이블이 없으면 잠금 없이 동작하고 한 번만 알린다 · 만들어지면 정상 전환', async () => {
  const clock = { t: Date.parse('2026-11-18T01:00:00Z') }, fr = fakeRest(clock), notes = [];
  const A = mk(clock, fr, 'A', { notify: t => notes.push(t) });
  fr.st.fail = 'POST engine_lock 404 {"code":"PGRST205","message":"Could not find the table"}';
  await A.attempt(); await A.attempt();
  assert.equal(A.status().mode, 'unavailable'); assert.equal(A.hasAuthority(), true); assert.equal(notes.length, 1);
  assert.match(notes[0], /engine_lock/);
  fr.st.fail = null; await A.attempt();
  assert.equal(A.status().mode, 'ok'); assert.equal(A.hasAuthority(), true);
});

test('잠금: rest 가 없으면(로컬·시험) 항상 권한 있음', () => {
  const A = createOrderLock({ instanceId: 'x' });
  assert.equal(A.hasAuthority(), true); assert.equal(A.status().mode, 'disabled');
});

/* ── 판정 ── */
const base = { now: Date.parse('2026-11-18T01:30:00Z'), bootAt: Date.parse('2026-11-18T00:00:00Z'), tradingDay: true, held: 0, token: { ok: true }, authority: { mode: 'ok', held: true } };
const eng = (age, extra = {}) => ({ enabled: true, lastTick: age == null ? 0 : base.now - age, closedToday: false, ...extra });
test('판정: 장중 5초 루프가 살아 있으면 정상', () => {
  const r = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(4000), live: null } });
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.equal(r.phase, 'active');
});
test('판정: 마지막 점검이 60초보다 오래되면 실패(손절 감시 멈춤)', () => {
  const r = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(75000), live: null } });
  assert.equal(r.ok, false); assert.equal(r.status, 'down'); assert.match(r.reasons[0], /75초째/);
});
test('판정: 시작 후 한 번도 안 돌았으면 실패 — 90초 안이면 warming', () => {
  const a = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(null) } });
  assert.equal(a.ok, false); assert.match(a.reasons[0], /한 번도/); assert.equal(a.status, 'down');
  const b = evalHealth({ ...base, bootAt: base.now - 30000, min: 10 * 60, engines: { paper: eng(null) } });
  assert.equal(b.status, 'warming'); assert.equal(b.ok, false);
});
test('판정: 실전 엔진이 켜져 있으면 그것도 요구, 꺼져 있으면 무시', () => {
  const on = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(3000), live: eng(120000) } });
  assert.equal(on.ok, false); assert.match(on.reasons.join(), /실전매매/);
  const off = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(3000), live: eng(120000, { enabled: false }) } });
  assert.equal(off.ok, true);
});
test('판정: 장 밖·주말·휴장은 정상(idle) — 07:50~08:00 은 깨우기용 pre', () => {
  assert.equal(evalHealth({ ...base, min: 7 * 60 + 55, engines: { paper: eng(null) } }).phase, 'pre');
  assert.equal(evalHealth({ ...base, min: 7 * 60 + 55, engines: { paper: eng(null) } }).ok, true);
  assert.equal(evalHealth({ ...base, min: 20 * 60, engines: { paper: eng(null) } }).status, 'idle');
  const wk = evalHealth({ ...base, tradingDay: false, min: 10 * 60, engines: { paper: eng(null) } });
  assert.equal(wk.ok, true); assert.equal(wk.phase, 'closed');
  const hol = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(null, { closedToday: true }) } });
  assert.equal(hol.ok, true);
});
test('판정: 다른 인스턴스가 주문 권한을 쥐면 standby(정상)', () => {
  const r = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(null) }, authority: { mode: 'ok', held: false, holder: 'other' } });
  assert.equal(r.ok, true); assert.equal(r.status, 'standby');
});
test('판정: 보유 종목이 있는데 KIS 토큰이 없으면 실패, 보유가 없으면 통과 · 잠금 테이블 없음은 경고', () => {
  const a = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(3000) }, held: 2, token: { ok: false } });
  assert.equal(a.ok, false); assert.match(a.reasons[0], /토큰/);
  assert.equal(evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(3000) }, held: 0, token: { ok: false } }).ok, true);
  const w = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(3000) }, authority: { mode: 'unavailable', held: true } });
  assert.equal(w.ok, true); assert.match(w.warning, /잠금/);
});
test('판정: 응답에 종목 코드를 담지 않는다(개수만)', () => {
  const r = evalHealth({ ...base, min: 10 * 60, engines: { paper: eng(3000) }, held: 3 });
  assert.equal(r.held, 3); assert.ok(!/\d{6}/.test(JSON.stringify(r)));
});

/* ── 엔진 연동: 권한 없으면 주문·감시 모두 멈추고, 권한을 얻으면 기록을 다시 읽는다 ── */
test('엔진: 권한이 없으면 감시 루프·주문이 멈춘다(주문은 403)', async () => {
  let auth = false;
  const c = await boot(fakeDb(), { extraDeps: { authority: () => auth } });
  await c.login();
  await c.t.paper.tick();
  assert.equal(c.t.paper.health().lastTick, 0, '권한 없이는 감시 루프가 돌지 않는다');
  const r = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r.status, 403); assert.match(r.body.error, /authority/);
  assert.equal(c.t.sweepReady(), false);
  auth = true;
  await c.t.paper.tick();
  assert.ok(c.t.paper.health().lastTick > 0);
  const r2 = await c.order({ code: '005930', side: 'buy', type: 'market', qty: 1 });
  assert.equal(r2.status, 200);
  await c.close();
});
test('엔진: 재시작 직후 첫 한 바퀴(손절 점검)를 마치기 전에는 sweepReady 가 false, 권한 재획득(reload) 때도 다시 false', async () => {
  const c = await boot(fakeDb(), {});
  await c.login();
  assert.equal(c.t.engineHealth().paper.inSession, true);
  assert.equal(c.t.sweepReady(), false);
  await c.t.paper.tick();
  assert.equal(c.t.sweepReady(), true);
  assert.ok(c.t.engineHealth().paper.lastTick > 0);
  c.t.reloadEngines();
  assert.equal(c.t.sweepReady(), false);
  await c.t.paper.tick();
  assert.equal(c.t.sweepReady(), true);
  await c.close();
});

test('엔진: 실전 엔진도 같은 규칙 — 켜져 있으면 점검 표시·sweepReady 에 반영, 권한 없으면 멈춤', async () => {
  let auth = false;
  const kx = fakeKis();
  const c = await boot(fakeDb(), { envExtra: { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' }, kx, extraDeps: { authority: () => auth } });
  await c.login();
  assert.equal(c.t.engineHealth().live.enabled, true);
  await c.t.live.tick();
  assert.equal(c.t.engineHealth().live.lastTick, 0);
  auth = true; await c.t.paper.tick(); await c.t.live.tick();
  assert.ok(c.t.engineHealth().live.lastTick > 0);
  assert.equal(c.t.sweepReady(), true);
  c.t.reloadEngines();
  assert.equal(c.t.engineHealth().live.swept, false);
  await c.close();
});
