'use strict';
/* 시세 조회 실패 수정(2026-11-16): 호출 간격 예약·실패 분류·연속 실패 알림 */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../kis-throttle');
const { createQuoteWatch } = require('../quote-watch');

test('동시에 온 호출도 200ms 간격으로 일렬로 선다(버스트 없음)', async () => {
  let clock = 1000;
  const th = T.createThrottle({ intervalMs: 200, now: () => clock, sleep: ms => new Promise(r => setImmediate(() => { clock += ms; r(); })) });
  const ws = await Promise.all([th.wait(), th.wait(), th.wait(), th.wait()]);
  assert.deepEqual(ws, [0, 200, 400, 600]);          // 예전 구현은 [0,200,200,200] 처럼 겹쳤다
});
test('우선순위: 매매(0) > 자동매매(1) > 화면(2), 같은 순위는 먼저 온 순서', async () => {
  let clock = 0; const order = [];
  const th = T.createThrottle({ intervalMs: 100, now: () => clock, sleep: ms => new Promise(r => setImmediate(() => { clock += ms; r(); })) });
  const run = (name, p) => th.wait(p).then(() => order.push(name));
  await th.wait(2);                       // 첫 슬롯 소진 → 이후 호출은 대기열에서 경쟁
  await Promise.all([run('화면1', 2), run('화면2', 2), run('자동', 1), run('매매', 0), run('매매2', 0)]);
  assert.deepEqual(order, ['매매', '매매2', '자동', '화면1', '화면2']);
});
test('화면 조회 대기열이 가득 차면 거절(매매·자동은 거절 없음)', async () => {
  let clock = 0; const th = T.createThrottle({ intervalMs: 100, now: () => clock, sleep: ms => new Promise(r => setImmediate(() => { clock += ms; r(); })), maxQueue: { 2: 2 } });
  await th.wait(2);
  const a = th.wait(2), b = th.wait(2);
  await assert.rejects(th.wait(2), e => e.busy === true);
  await assert.doesNotReject(Promise.all([th.wait(0), th.wait(1)]));
  await Promise.all([a, b]);
});
test('한가하면 기다리지 않는다', async () => {
  let clock = 0; const th = T.createThrottle({ intervalMs: 200, now: () => clock, sleep: ms => new Promise(r => setImmediate(() => { clock += ms; r(); })) });
  assert.equal(await th.wait(), 0); clock = 500; assert.equal(await th.wait(), 0);
});
test('실패 분류·재시도 대상', () => {
  assert.equal(T.classify(new Error('KIS FHKST01010100 EGW00201 초당 거래건수를 초과')), 'ratelimit');
  assert.equal(T.classify(new Error('The operation was aborted due to timeout')), 'timeout');
  assert.equal(T.classify(new Error('fetch failed')), 'network');
  assert.equal(T.classify(new Error('KIS X 503')), 'http5xx');
  assert.equal(T.classify(new Error('KIS X OPSQ0002')), 'other');
  assert.ok(T.retryable('network') && !T.retryable('other'));
});
test('요약 로그: 창이 지나야 한 줄, 실패 종류별 집계', () => {
  let clock = 0; const lines = [];
  const st = T.createStats({ log: m => lines.push(m), now: () => clock, windowMs: 60000 });
  st.record({ trId: 'A', ok: true, waitMs: 100, ms: 50 });
  st.record({ trId: 'A', ok: false, kind: 'timeout', waitMs: 300, ms: 8000, msg: 'A 005930 timeout' });
  assert.equal(st.flush(), null); clock = 61000;
  const l = st.flush();
  assert.match(l, /호출 2건 · 실패 1건\(timeout:1\)/); assert.match(l, /대기 최대 300ms/); assert.equal(lines.length, 1);
  assert.equal(st.flush(true), null);   // 비었으면 남기지 않음
});
test('연속 실패: 6번째에야 알림, 원인 포함, 복구 시 복구 알림', () => {
  let clock = 0; const alerts = [], logs = [];
  const w = createQuoteWatch({ threshold: 6, log: m => logs.push(m), notify: (t, k) => alerts.push([t, k]), now: () => clock });
  for (let i = 0; i < 5; i++) { clock += 5000; w.fail('064400', new Error('KIS FHKST01010100 EGW00201')); }
  assert.equal(alerts.length, 0);
  w.fail('064400', new Error('KIS FHKST01010100 EGW00201'));
  assert.equal(alerts.length, 1); assert.match(alerts[0][0], /6번 연속.*064400.*EGW00201/s);
  w.fail('064400', new Error('x')); assert.equal(alerts.length, 1);   // 같은 중단에서 또 알리지 않음
  w.ok('064400'); assert.equal(alerts.length, 2); assert.match(alerts[1][0], /복구/);
  assert.ok(logs.some(l => /복구/.test(l)) && logs.some(l => /연속 1회/.test(l)));
});
test('중간에 성공하면 연속 횟수가 처음부터', () => {
  const alerts = []; const w = createQuoteWatch({ threshold: 3, log: () => {}, notify: t => alerts.push(t) });
  w.fail('A', 'e'); w.fail('A', 'e'); w.ok('A'); w.fail('A', 'e'); w.fail('A', 'e');
  assert.equal(alerts.length, 0);
});
