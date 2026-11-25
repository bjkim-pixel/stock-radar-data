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
/* 2026-11-25: 익절 단계가 하나라도 있는 모든 매도계획에 손절 올리기를 항상 적용(plan.ratchet 가 없어도 기본값 floorPct 0.35) */
const DEF_FLOOR = 0.35;
/* plan.ratchet === false 는 내부 시험용 끄기(화면·전략·자동매매는 보내지 않음) */
const active = plan => !!(plan && plan.ratchet !== false && ((plan.ratchet && typeof plan.ratchet === 'object') || (Array.isArray(plan.steps) && plan.steps.length)));
const floorOf = plan => (plan && plan.ratchet && +plan.ratchet.floorPct >= 0 ? +plan.ratchet.floorPct : DEF_FLOOR);
/* peak = 보유 후 본 최고가(없으면 0) */
function ratchetStop(plan, avg, peak, floorTick) {
  const base = baseStop(plan, avg, floorTick);
  if (!active(plan) || !(base > 0) || !(avg > 0)) return base;
  const R = (1 - base / avg) * 100;                    // 처음 손절폭 %
  if (!(R > 0)) return base;
  const fl = floorOf(plan);
  const pk = peak > 0 ? (peak / avg - 1) * 100 : 0, from = R * 0.5, to = R;
  let pct = pk <= from ? -R : pk >= to ? fl : -R + (pk - from) * (fl + R) / (to - from);
  let line = avg * (1 + pct / 100);
  const core = (plan.steps || []).filter(s => !s.runner).sort((a, b) => a.n - b.n);
  const k = core.filter(isFired).length;
  if (k >= 1) line = Math.max(line, avg * (1 + fl / 100));
  if (k >= 2) line = Math.max(line, core[k - 2].p);
  line = pct <= -R + 1e-9 && k === 0 ? base : ceilTick(line);
  return Math.max(base, line, +plan.curStop > 0 && +plan.curStop <= avg * 3 ? +plan.curStop : 0);   // 한 번 올라간 손절선(매도계획에 저장된 값)은 내려가지 않음
}
const HIST_MAX = 30;
/* 손절선 변경 이력(매도계획 plan.hist 에 저장): 올라갈 때마다 { t, from, to, why } 를 쌓고 plan.curStop 을 갱신. 바뀐 게 있으면 그 항목을, 없으면 null.
   처음 호출 때는 매수 시 설정한 손절가를 첫 항목으로 남김. 최고가 상승에 따른 연속 램프는 0.3%p 이상 올랐을 때만 기록(잦은 기록 방지) */
function track(plan, avg, peak, floorTick, ts) {
  if (!active(plan) || !(avg > 0)) return null;
  const base = baseStop(plan, avg, floorTick);
  if (!(base > 0)) return null;
  plan.hist = Array.isArray(plan.hist) ? plan.hist : [];
  if (!plan.hist.length || !(+plan.curStop > 0)) {
    const first = !plan.hist.length;
    const sp0 = ratchetStop({ ...plan, curStop: 0 }, avg, peak, floorTick);
    plan.curStop = Math.max(base, sp0 || 0);
    if (first) { plan.hist.push({ t: ts, from: null, to: base, why: '매수 시 설정한 손절' }); if (plan.curStop > base) plan.hist.push({ t: ts, from: base, to: plan.curStop, why: '재시작·계획 수정 후 이어받음' }); return plan.hist[plan.hist.length - 1]; }
    return null;
  }
  const sp = ratchetStop(plan, avg, peak, floorTick), last = +plan.curStop;
  if (!(sp > last)) return null;
  const core = (plan.steps || []).filter(s => !s.runner).sort((a, b) => a.n - b.n), k = core.filter(isFired).length, fl = floorOf(plan);
  let why, step = false;
  if (k >= 2) { why = `익절 ${k}단계 체결 → 손절을 ${k - 1}단계 익절가로 올림`; step = true; }
  else if (k === 1) { why = `익절 1단계 체결 → 손절을 매수가(수수료 ${fl}% 포함)로 올림`; step = true; }
  else why = `최고 수익 ${(((peak || 0) / avg - 1) * 100).toFixed(1)}% 도달 → 손절선 상향`;
  if (!step && sp < last + avg * 0.003 && sp < avg * (1 + fl / 100) - 1e-9) return null;
  const e = { t: ts, from: last, to: sp, why };
  plan.hist.push(e); if (plan.hist.length > HIST_MAX) plan.hist.splice(1, plan.hist.length - HIST_MAX);
  plan.curStop = sp;
  return e;
}
module.exports = { active, track, DEF_FLOOR, ratchetStop, swingWidth, baseStop, SWING_TIERS };
