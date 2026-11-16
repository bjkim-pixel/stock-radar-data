'use strict';
/* KIS REST 호출 간격 제한 + 실패 통계 (2026-11-16)
   원인: 예전 kisRestThrottle 은 "마지막 호출 시각"을 대기가 끝난 뒤에야 기록해서, 동시에 들어온 호출 N개가
   모두 같은 시간만큼 기다린 뒤 한꺼번에 나갔다(보유 종목·상따 후보·실시간 화면이 동시에 호출 → 순간 버스트 →
   KIS 초당 한도(EGW00201)·타임아웃). 여기서는 호출마다 '자기 차례 시각'을 즉시 예약해 일렬로 세운다. */

/* 우선순위(작을수록 먼저): 0 = 가상·실전매매 감시, 1 = 자동매매(1조↑ 후보 풀 등), 2 = 화면 조회(사용자가 페이지를 열었을 때만).
   슬롯은 intervalMs 마다 하나씩 나가고, 슬롯이 나갈 때마다 가장 높은 우선순위의 가장 오래 기다린 호출이 가져간다.
   화면 조회(2)는 대기열이 maxQueue[2] 를 넘으면 바로 거절해 대기열이 끝없이 쌓이지 않게 한다. */
function createThrottle({ intervalMs = 200, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), maxQueue = { 2: 40 } } = {}) {
  let next = 0, pumping = false;
  const queues = [[], [], []];
  async function pump() {
    if (pumping) return; pumping = true;
    try {
      while (queues.some(q => q.length)) {
        const d = next - now();
        if (d > 0) await sleep(d);
        const q = queues.find(x => x.length); if (!q) break;
        const w = q.shift();
        next = now() + intervalMs;
        w.resolve(now() - w.t);
      }
    } finally { pumping = false; }
  }
  /* 반환: 실제로 기다린 ms. prio 기본 2(화면) */
  function wait(prio = 2) {
    const p = prio < 0 ? 0 : prio > 2 ? 2 : prio;
    const cap = maxQueue[p];
    if (cap != null && queues[p].length >= cap) { const e = new Error('KIS 대기열 포화(화면 조회 잠시 제한)'); e.busy = true; return Promise.reject(e); }
    return new Promise(resolve => { queues[p].push({ resolve, t: now() }); pump(); });
  }
  return { wait, queued: () => queues.map(q => q.length), backlogMs: () => Math.max(0, next - now()) + queues.reduce((a, q) => a + q.length, 0) * intervalMs };
}

/* 실패 원인 분류 — 로그·알림에 그대로 쓴다 */
function classify(err) {
  const m = String((err && err.message) || err || '');
  if (/EGW00201|초당|rate/i.test(m)) return 'ratelimit';
  if (/EGW00123|EGW00121|토큰|token/i.test(m)) return 'token';
  if (/timeout|timed out|TimeoutError|aborted/i.test(m)) return 'timeout';
  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket/i.test(m)) return 'network';
  if (/KIS \S+ (5\d\d)/.test(m)) return 'http5xx';
  if (/KIS \S+ 429/.test(m)) return 'ratelimit';
  return 'other';
}
/* 잠깐 뒤 다시 하면 풀릴 가능성이 있는 종류(읽기 전용 호출에만 쓴다) */
const retryable = kind => kind === 'ratelimit' || kind === 'timeout' || kind === 'network' || kind === 'http5xx';

/* 60초 요약: 호출 수·실패 종류별 수·최대/평균 대기·최대 응답시간 */
function createStats({ log = console.log, now = Date.now, windowMs = 60000 } = {}) {
  let s = fresh(); let t0 = now();
  function fresh() { return { calls: 0, fail: 0, retried: 0, kinds: {}, trIds: {}, waitMax: 0, waitSum: 0, msMax: 0, last: null }; }
  function record({ trId, ok, kind, waitMs = 0, ms = 0, retried = false, msg }) {
    s.calls++; s.waitSum += waitMs; s.waitMax = Math.max(s.waitMax, waitMs); s.msMax = Math.max(s.msMax, ms);
    if (retried) s.retried++;
    if (!ok) { s.fail++; s.kinds[kind || 'other'] = (s.kinds[kind || 'other'] || 0) + 1; s.trIds[trId] = (s.trIds[trId] || 0) + 1; s.last = msg || null; }
  }
  /* 호출하는 쪽이 주기적으로(예: 5초마다) 부른다. 창이 지났고 호출이 있었으면 한 줄 남김 */
  function flush(force) {
    if (!force && now() - t0 < windowMs) return null;
    const x = s; s = fresh(); t0 = now();
    if (!x.calls) return null;
    const kinds = Object.entries(x.kinds).map(([k, v]) => `${k}:${v}`).join(',') || '-';
    const line = `[KIS요약] ${Math.round(windowMs / 1000)}초 호출 ${x.calls}건 · 실패 ${x.fail}건(${kinds}) · 재시도 ${x.retried}건 · 대기 최대 ${x.waitMax}ms 평균 ${Math.round(x.waitSum / x.calls)}ms · 응답 최대 ${x.msMax}ms` + (x.last ? ` · 마지막 실패: ${x.last}` : '');
    log(line);
    return line;
  }
  return { record, flush };
}

module.exports = { createThrottle, createStats, classify, retryable };
