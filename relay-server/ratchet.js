'use strict';
/* 손절선 올리기(래칫) · 러너 트레일링 (2026-11-16) — 순수 함수. 가상(paper.js)·실전(live.js)이 같이 씀.
   plan.ratchet = { floorPct } 가 있을 때만 동작. 1R = 처음 손절폭(%).
   손절선 = 아래 세 값 중 가장 높은 것(내려가지 않음 — 고점·체결 단계는 늘기만 하므로 자연히 단조)
     ① 처음 손절가
     ② 연속 램프: 최고수익이 0.5R 이하면 처음 손절, 0.5R→1R 구간에서 본전(+floorPct)까지 선형 상승, 1R 이상이면 본전
     ③ 단계 규칙: 익절 1단계 체결 → 본전, n단계 체결(n≥2) → (n−1)단계 익절가 (러너 제외)
   러너 = steps 중 runner:true 인 단계. 목표가 없이 목표가 도달 후 스윙형 트레일링(고점수익 15% 미만 −5%, 15~30% −4%, 30%↑ −3%)으로만 팜 */
const { tickOf } = require('./paper-engine');
const ceilTick = p => { const t = tickOf(p); return Math.ceil(p / t - 1e-9) * t; };
const SWING_TIERS = [[30, 3], [15, 4], [0, 5]];   // [고점수익 % 이상, 고점 대비 폭 %]
function swingWidth(peakPct) { for (const [from, w] of SWING_TIERS) if (peakPct >= from) return w; return 5; }
const isFired = s => !!s.fired || ((s.q || 0) > 0 && (s.sold || 0) >= s.q);
function baseStop(plan, avg, floorTick) {
  if (!plan) return null;
  return plan.stopPct > 0 ? floorTick(avg * (1 - plan.stopPct / 100)) : (plan.stop > 0 ? plan.stop : null);
}
/* peak = 보유 후 본 최고가(없으면 0) */
function ratchetStop(plan, avg, peak, floorTick) {
  const base = baseStop(plan, avg, floorTick);
  if (!plan || !plan.ratchet || !(base > 0) || !(avg > 0)) return base;
  const R = (1 - base / avg) * 100;                    // 처음 손절폭 %
  if (!(R > 0)) return base;
  const fl = +plan.ratchet.floorPct >= 0 ? +plan.ratchet.floorPct : 0.35;
  const pk = peak > 0 ? (peak / avg - 1) * 100 : 0, from = R * 0.5, to = R;
  let pct = pk <= from ? -R : pk >= to ? fl : -R + (pk - from) * (fl + R) / (to - from);
  let line = avg * (1 + pct / 100);
  const core = (plan.steps || []).filter(s => !s.runner).sort((a, b) => a.n - b.n);
  const k = core.filter(isFired).length;
  if (k >= 1) line = Math.max(line, avg * (1 + fl / 100));
  if (k >= 2) line = Math.max(line, core[k - 2].p);
  line = pct <= -R + 1e-9 && k === 0 ? base : ceilTick(line);
  return Math.max(base, line);
}
module.exports = { ratchetStop, swingWidth, baseStop, SWING_TIERS };
