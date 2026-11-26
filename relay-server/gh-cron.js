'use strict';
// GitHub Actions 정시 실행기.
// GitHub의 cron(schedule)은 큐가 밀리면 몇 시간씩 늦거나 아예 건너뜁니다(실측: 16:05 예약이 밤 0시경 실행, 18:05 예약은 미실행).
// 항상 켜져 있는 이 서버가 정해진 KST 시각에 workflow_dispatch API를 직접 호출해 시간을 지킵니다.
// 필요 환경변수: GH_DISPATCH_TOKEN (이 저장소 전용 fine-grained 토큰, Actions: Read and write). 없으면 꺼진 채 안내만 남깁니다.
// 같은 시각에 GitHub 예약이 뒤늦게 또 실행돼도 upsert라 안전합니다.

const SLOTS = [
  { wf: 'daily_collect.yml', label: '상시1', at: '16:05', days: [1, 2, 3, 4, 5] },
  { wf: 'daily_collect.yml', label: '상시1', at: '18:05', days: [1, 2, 3, 4, 5] },   // 상시2·4·5는 상시1이 이어서 실행
  { wf: 'global_collect.yml', label: '상시3', at: '06:30', days: [2, 3, 4, 5, 6] },  // 미국 마감 후(화~토)
  { wf: 'market_regime.yml', label: '상시5', at: '08:15', days: [1, 2, 3, 4, 5] },
];
const CATCHUP_MIN = 150;   // 서버가 잠들었다 깨어났을 때 이 시간 안이면 늦게라도 실행

function kst(ms) {
  const d = new Date(ms + 9 * 3600e3);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function createGhCron({ token, repo = 'bjkim-pixel/stock-radar-data', ref = 'main', fetch: F = globalThis.fetch, now = Date.now, log = console.log, slots = SLOTS, notify = null } = {}) {
  const fired = new Set();
  const alerted = new Set();   // 같은 날 같은 사유 알림은 1번만
  const alert = async (key, msg) => { if (!notify || alerted.has(key)) return; alerted.add(key); try { await notify(msg); } catch (_) {} };
  let warned = false;
  const H = { Accept: 'application/vnd.github+json', 'User-Agent': 'stock-radar-relay', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  async function alreadyRan(wf, sinceMs) {
    try {
      const since = new Date(sinceMs).toISOString().slice(0, 19) + 'Z';
      const r = await F(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/runs?created=%3E%3D${since}&per_page=10`, { headers: H });
      if (!r.ok) return false;
      const j = await r.json();
      return (j.workflow_runs || []).some(x => x.conclusion !== 'cancelled');
    } catch (_) { return false; }
  }

  async function dispatch(wf) {
    const r = await F(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) });
    if (r.status !== 204) throw new Error(`HTTP ${r.status}`);
  }

  async function tick() {
    const t = now(), k = kst(t), out = [];
    if (!token) {
      if (!warned) { warned = true; log('[gh-cron] GH_DISPATCH_TOKEN 없음 — GitHub 정시 실행기 꺼짐(예약 지연 문제 그대로)'); }
      const due = slots.some(s => s.days.includes(k.dow) && k.min >= toMin(s.at) && k.min <= toMin(s.at) + 30);
      if (due) await alert(`${k.date}|notoken`, '⚠️ GitHub 정시 실행기 꺼짐: Render 환경변수 GH_DISPATCH_TOKEN이 없어 상시1(16:05·18:05) 정시 실행을 못 합니다. 토큰을 설정해 주세요.');
      return [];
    }
    for (const s of slots) {
      if (!s.days.includes(k.dow)) continue;
      const at = toMin(s.at), key = `${k.date}|${s.wf}|${s.at}`;
      if (fired.has(key) || k.min < at || k.min > at + CATCHUP_MIN) continue;
      fired.add(key);
      const slotMs = t - (k.min - at) * 60e3;
      if (await alreadyRan(s.wf, slotMs - 120e3)) { log(`[gh-cron] ${s.label} ${s.at} 이미 실행됨 — 건너뜀`); continue; }
      try { await dispatch(s.wf); out.push(key); log(`[gh-cron] ${s.label} ${s.wf} ${s.at} 실행 요청${k.min - at > 3 ? ` (${k.min - at}분 늦게)` : ''}`); }
      catch (e) { fired.delete(key); log(`[gh-cron] ${s.label} ${s.wf} 실행 요청 실패: ${e.message}`); await alert(`${key}|fail`, `⚠️ GitHub 정시 실행 요청 실패(${s.label} ${s.at}): ${e.message} — 토큰 만료·권한(Actions: Read and write)을 확인하세요.`); }
    }
    return out;
  }
  return { tick, SLOTS: slots };
}

module.exports = { createGhCron, SLOTS, kst };
