'use strict';
/* 손절선 자동 상향(모든 매도계획 공통) + 매도계획에 변경 이력 저장 (2026-11-25) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, boot } = require('./paper-harness');
const RT = require('../ratchet');
const { floorTick } = require('../paper-engine');

function move(c, price, { vol = 1000 } = {}) {
  const st = c.st; st.clock += 5000; st.price = price; st.vol += vol;
  st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]);
  st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]);
  st.low = Math.min(st.low, price); st.high = Math.max(st.high, price);
}
const PLAN2 = { stopPct: 3, trail: 2, steps: [{ n: 1, p: 10600, q: 5 }, { n: 2, p: 10900, q: 5 }] };   // ratchet 를 안 보내도 항상 적용

test('ratchet.js: 익절 단계가 있으면 plan.ratchet 이 없어도 적용, 1단계 체결 → 본전, 2단계 → 1단계 가격, 한 번 올라간 손절은 내려가지 않음', () => {
  const plan = { stopPct: 3, steps: [{ n: 1, p: 10600, q: 3 }, { n: 2, p: 10900, q: 3 }, { n: 3, p: 11200, q: 4 }] };
  assert.ok(RT.active(plan)); assert.ok(!RT.active({ stopPct: 3, steps: [] })); assert.ok(!RT.active({ ratchet: false, steps: plan.steps }));
  assert.equal(RT.ratchetStop(plan, 10000, 10000, floorTick), 9700);
  plan.steps[0].sold = 3;                                  // 1단계 체결
  assert.equal(RT.ratchetStop(plan, 10000, 10650, floorTick), 10040);   // 본전 + 수수료 0.35% → 호가 단위 올림
  plan.steps[1].sold = 3;                                  // 2단계 체결
  assert.equal(RT.ratchetStop(plan, 10000, 10950, floorTick), 10600);
  const t = []; const p2 = { stopPct: 3, steps: [{ n: 1, p: 10600, q: 3 }, { n: 2, p: 10900, q: 3 }] };
  t.push(RT.track(p2, 10000, 10000, floorTick, 1));          // 첫 호출: 매수 시 손절을 첫 이력으로
  assert.equal(p2.hist.length, 1); assert.equal(p2.hist[0].to, 9700); assert.equal(p2.curStop, 9700);
  p2.steps[0].sold = 3;
  const e = RT.track(p2, 10000, 10650, floorTick, 2);
  assert.equal(e.to, 10040); assert.equal(e.from, 9700); assert.match(e.why, /1단계/);
  assert.equal(RT.track(p2, 10000, 10650, floorTick, 3), null);   // 변화 없으면 기록 안 함
  assert.equal(p2.hist.length, 2);
  p2.steps[0].sold = 0;                                           // 어떤 이유로 체결 표시가 사라져도 손절은 내려가지 않음
  assert.equal(RT.ratchetStop(p2, 10000, 10650, floorTick), 10040);
});

test('가상매매: 1단계 익절 체결 → 손절이 매수가 근처로 올라가 매도계획에 저장되고 이력이 남음, 이후 횡보하다 떨어지면 손실 없이 정리', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  const r = await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: PLAN2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pos = () => db.t.paper_positions.get('005930');
  move(c, 10000); await c.t.paper.tick();
  assert.equal(pos().plan.hist[0].why, '매수 시 설정한 손절');
  const base = pos().plan.curStop;
  move(c, 10650); await c.t.paper.tick();                    // 1단계 도달 → 감시
  move(c, 10400); await c.t.paper.tick();                    // 고점 −2% 아래 → 1단계 5주 매도
  assert.equal(pos().qty, 5);
  assert.ok(pos().plan.curStop >= 10000, `손절이 매수가 위로: ${pos().plan.curStop}`);
  assert.ok(pos().plan.hist.some(h => /1단계 체결|최고 수익/.test(h.why) && h.to === pos().plan.curStop), JSON.stringify(pos().plan.hist));
  assert.ok(pos().plan.curStop > base);
  assert.ok(c.st.alerts.some(a => /손절선 상향/.test(a)));
  move(c, 10020); await c.t.paper.tick();                    // 횡보 후 되돌림 — 새 손절선 아래 → 남은 수량 정리(원래 손절 −3%까지 안 내려감)
  assert.equal(db.t.paper_positions.has('005930'), false);
  await c.close();
});

test('매도계획 직접 수정해도 이력은 이어지고 수정 기록이 남음', async () => {
  const db = fakeDb(), c = await boot(db); await c.login();
  await c.order({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 10, plan: PLAN2 });
  move(c, 10000); await c.t.paper.tick();
  const e = await c.t.paper.editPlan({ code: '005930', stopPct: 4, steps: [{ n: 1, p: 10600, q: 5 }, { n: 2, p: 10900, q: 5 }] });
  assert.equal(e.ok, true, JSON.stringify(e));
  const h = db.t.paper_positions.get('005930').plan.hist;
  assert.equal(h[0].why, '매수 시 설정한 손절'); assert.equal(h.at(-1).why, '매도계획 직접 수정');
  assert.ok(db.t.paper_positions.get('005930').plan.ratchet);
  await c.close();
});
