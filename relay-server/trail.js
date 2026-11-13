'use strict';
/* 트레일링 익절(2026-11-13) — 순수 함수. 가상(paper.js)·실전(live.js)이 같이 씀.
   단계 st = { n, p(익절가), q, sold, armed, peak, fired }
   · 현재가(또는 지난 확인 이후 새로 찍은 고가)가 익절가 p 이상 → 감시 시작(armed), 그때부터 최고가 peak 추적
   · 감시 중 현재가 ≤ peak × (1 − trail%) → 발동(fired) — 그 단계 수량을 매도(한 번 발동하면 가격이 돌아와도 끝까지 팜)
   반환 { changed, armedNow, fire, trigger } */
function trailUpdate(st, price, newHigh, trail) {
  let changed = false, armedNow = false;
  const top = Math.max(+price || 0, +newHigh || 0);
  if (!st.armed) {
    if (!(top >= st.p)) return { changed, armedNow, fire: false, trigger: null };
    st.armed = true; st.peak = top; changed = armedNow = true;
  }
  if (top > (st.peak || 0)) { st.peak = top; changed = true; }
  const trigger = st.peak * (1 - trail / 100);
  if (!st.fired && price > 0 && price <= trigger) { st.fired = true; changed = true; }
  return { changed, armedNow, fire: !!st.fired, trigger };
}
/* 계획을 다시 저장할 때 같은 단계(번호·가격 동일)의 감시 상태는 이어받음 */
function keepTrail(prevSteps, steps) {
  const old = new Map((prevSteps || []).map(s => [s.n + '|' + s.p, s]));
  return steps.map(s => { const o = old.get(s.n + '|' + s.p); return o ? { ...s, armed: !!o.armed, peak: o.peak || null, fired: !!o.fired } : s; });
}
module.exports = { trailUpdate, keepTrail };
