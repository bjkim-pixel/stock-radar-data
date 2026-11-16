'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGhCron } = require('../gh-cron');

const kstMs = (iso) => Date.parse(iso + '+09:00');
function rig({ at, runs = [], status = 204, token = 't' }) {
  const calls = []; let t = kstMs(at);
  const fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET' });
    if (o.method === 'POST') return { status };
    return { ok: true, json: async () => ({ workflow_runs: runs }) };
  };
  const g = createGhCron({ token, fetch, now: () => t, log: () => {} });
  return { g, calls, set: v => { t = kstMs(v); } };
}
const posts = c => c.filter(x => x.method === 'POST').map(x => x.url.match(/workflows\/([^/]+)\//)[1]);

test('16:05 정각에 상시1 실행 요청, 같은 슬롯 중복 없음', async () => {
  const r = rig({ at: '2026-11-16T16:05:10' });          // 월
  await r.g.tick(); await r.g.tick();
  assert.deepEqual(posts(r.calls), ['daily_collect.yml']);
});
test('시각 전/주말에는 요청 없음', async () => {
  const r = rig({ at: '2026-11-16T16:04:00' }); await r.g.tick();
  const w = rig({ at: '2026-11-15T16:05:10' }); await w.g.tick();   // 일
  assert.equal(posts(r.calls).length + posts(w.calls).length, 0);
});
test('늦게 깨어나도 150분 안이면 실행, 넘으면 건너뜀', async () => {
  const a = rig({ at: '2026-11-16T17:30:00' }); await a.g.tick();
  const b = rig({ at: '2026-11-16T21:30:00' }); await b.g.tick();
  assert.deepEqual(posts(a.calls), ['daily_collect.yml']);
  assert.deepEqual(posts(b.calls), []);
});
test('이미 그 시각 이후 실행이 있으면 건너뜀(취소된 건 무시)', async () => {
  const a = rig({ at: '2026-11-16T16:06:00', runs: [{ conclusion: 'success' }] }); await a.g.tick();
  const b = rig({ at: '2026-11-16T16:06:00', runs: [{ conclusion: 'cancelled' }] }); await b.g.tick();
  assert.equal(posts(a.calls).length, 0); assert.equal(posts(b.calls).length, 1);
});
test('미국 마감 후 06:30은 화~토만, 18:05 두 번째 슬롯도 동작', async () => {
  const mon = rig({ at: '2026-11-16T06:31:00' }); await mon.g.tick();    // 월 → 없음(08:15 전)
  const tue = rig({ at: '2026-11-17T06:31:00' }); await tue.g.tick();
  const ev = rig({ at: '2026-11-16T18:06:00' }); await ev.g.tick();
  assert.deepEqual(posts(mon.calls), []); assert.deepEqual(posts(tue.calls), ['global_collect.yml']); assert.ok(posts(ev.calls).includes('daily_collect.yml'));
});
test('요청 실패 시 다음 틱에 재시도, 토큰 없으면 아무것도 안 함', async () => {
  const r = rig({ at: '2026-11-16T16:05:10', status: 403 }); await r.g.tick(); await r.g.tick();
  assert.equal(posts(r.calls).length, 2);
  const n = rig({ at: '2026-11-16T16:05:10', token: '' }); await n.g.tick();
  assert.equal(n.calls.length, 0);
});
