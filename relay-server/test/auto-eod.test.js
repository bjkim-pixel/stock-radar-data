'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../auto-eod');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

test('넘길 자격: 매수가 위 · 고가 −2% 이내 · 외/기 중 하나 순매수 · 지수 −1% 초과', () => {
  const ok = { price: 10200, avg: 10000, high: 10300, flow: { fq: 5, oq: -1 }, idx: { 코스피: -0.5, 코스닥: 0.3 } };
  assert.deepEqual(X.carryCheck(ok), []);
  assert.match(X.carryCheck({ ...ok, price: 9990 }).join(), /매수가 이하/);
  assert.match(X.carryCheck({ ...ok, high: 10500 }).join(), /고가 대비/);
  assert.match(X.carryCheck({ ...ok, flow: { fq: -5, oq: 0 } }).join(), /외국인·기관/);
  assert.match(X.carryCheck({ ...ok, flow: { err: 'x' } }).join(), /외국인·기관/);
  assert.match(X.carryCheck({ ...ok, idx: { 코스피: -1.0 } }).join(), /코스피 -1\.00%/);
});
test('아침 3분할 누적 목표: 09:05 1/3 · 09:10 2/3 · 09:15 전량', () => {
  assert.equal(X.sliceTarget(100, 9 * 60 + 4), 0);
  assert.equal(X.sliceTarget(100, 9 * 60 + 5), 33);
  assert.equal(X.sliceTarget(100, 9 * 60 + 12), 66);
  assert.equal(X.sliceTarget(100, 9 * 60 + 15), 100);
  assert.equal(X.sliceTarget(2, 9 * 60 + 5), 0);
  assert.equal(X.sliceTarget(2, 9 * 60 + 10), 1);
});
test('/정리 · /유지 파싱', () => {
  assert.deepEqual(X.parseEodCmd('/정리 1 2', 3), { kind: 'sell', nums: [1, 2] });
  assert.deepEqual(X.parseEodCmd('/정리 전체', 2), { kind: 'sell', nums: [1, 2] });
  assert.deepEqual(X.parseEodCmd('/유지', 2), { kind: 'keep' });
  assert.deepEqual(X.parseEodCmd('/정리 5', 2), { kind: 'bad' });
  assert.equal(X.parseEodCmd('/매수 1', 2), null);
});

/* ── 실제 가상매매 엔진: 10:16 승인·체결 → 15:10 판정 → 20:00 전환 → 다음 날 아침 매도 ── */
const MIN = 60e3, DAY = 864e5;
async function setup({ flow = { fq: 10, oq: 0 }, idx = { 코스피: 0.3, 코스닥: 0.1 } } = {}) {
  const db = fakeDb(), c = await boot(db);
  const runs = {}, cfg = { main: { on: true, perStockKrw: 1000000 } }, sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: 1e9 }));
  rows.push({ close: 10000, high: 10100, low: 9900, trade_amount: 5e10, individual_net: 1e9 });
  const A = createAuto({
    sbGet: async p => {
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) { const d = (p.match(/eq\.([\d-]+)/) || [])[1]; return runs[d] ? [JSON.parse(JSON.stringify(runs[d]))] : []; }
      return [];
    },
    sbWrite: async (p, m, b) => { b.forEach(x => { if (p.startsWith('auto_runs')) runs[x.trade_date] = JSON.parse(JSON.stringify(x)); else cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); },
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => rows,
    livePool: async () => [], fetchFlow: async () => flow, fetchPower: async () => ({}), fetchCttr: async () => ({}), marketState: async () => null, marketIdx: async () => idx,
  });
  const { date } = kst();
  runs[date] = { trade_date: date, status: 'noticed', payload: { picks: [{ code: '005930', name: '삼성전자', price: 10000, score: 80 }], noticeSent: true, approved: [], decision: null } };
  c.st.clock += 16 * MIN;
  await A.handleApproval('/매수 1');
  c.st.clock += 5000; c.st.vol += 700; await c.t.paper.tick();   // 100주 @10,000 체결
  await A.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 100);
  const at = (hh, mm, dayOff = 0) => { const d0 = Date.parse(`${date}T00:00:00+09:00`); c.st.clock = d0 + dayOff * DAY + (hh * 60 + mm) * MIN; };
  const px = p => { c.st.price = p; c.st.high = Math.max(c.st.high, p); c.st.low = Math.min(c.st.low, p); c.st.bids = Array.from({ length: 10 }, (_, i) => [p - (i + 1) * 10, 1000]); c.st.asks = Array.from({ length: 10 }, (_, i) => [p + i * 10, 1000]); };
  return { db, c, A, runs, cfg, sent, date, at, px };
}

test('자격 있는 종목: 15:10 판정만 알림 → 20:00 익절 끄고(손절 유지) 넘김 → 다음 날 09:05·09:10·09:15 1/3씩 매도', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup();
  at(15, 10); px(10100); c.st.high = 10150;
  await A.tick();
  assert.ok(sent.some(t => /넘길 자격 있음/.test(t)), sent.join('|'));
  assert.equal(runs[date].payload.eod.weak.length, 0);
  at(20, 1); await A.tick();
  const pos = db.t.paper_positions.get('005930');
  assert.equal(pos.plan.steps.length, 0); assert.equal(pos.plan.stopPct, 5);        // 익절 해제 · 손절 유지
  assert.equal(cfg.carry.items['005930'].q0, 100);
  assert.ok(sent.some(t => /종가 베팅 전환/.test(t)));
  at(9, 1, 1); px(10050); await A.tick();                                            // 09:01 갭 정상 → 아직 안 팜
  assert.equal(db.t.paper_positions.get('005930').qty, 100);
  at(9, 5, 1); await A.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 67);
  at(9, 10, 1); await A.tick();
  assert.equal(db.t.paper_positions.get('005930').qty, 34);
  at(9, 15, 1); await A.tick();
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.equal(cfg.carry.items['005930'].state, 'done');
  assert.equal(sent.filter(t => /🔔 삼성전자/.test(t)).length, 3);
  await c.close();
});
test('다음 날 시가가 전일 종가 대비 −3% 이하 → 09:05 기다리지 않고 즉시 전량', async () => {
  const { db, c, A, cfg, sent, at, px } = await setup();
  at(15, 10); px(10100); c.st.high = 10150; await A.tick();
  at(20, 1); await A.tick();
  at(9, 1, 1); px(9700); await A.tick();                                             // 전일 종가(10,000) 대비 −3%
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.ok(sent.some(t => /⚡ 삼성전자: 100주/.test(t)), sent.join('|'));
  assert.equal(cfg.carry.items['005930'].state, 'done');
  await c.close();
});
test('자격 없는 종목: 15:10 알림 → /정리 1 → 시장가 전량 매도, 20시 넘길 게 없음', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup();
  at(15, 10); px(9950); await A.tick();                                              // 매수가 아래
  assert.ok(sent.some(t => /넘길 자격이 없는 종목/.test(t) && /1\. 삼성전자/.test(t)), sent.join('|'));
  at(15, 12); const r = await A.handleEod('/정리 1');
  assert.match(r, /100주 평균/);
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.match(await A.handleEod('/정리 1'), /이미 처리/);
  at(20, 1); await A.tick();
  assert.ok(!cfg.carry || !cfg.carry.items['005930']);
  assert.ok(runs[date].payload.carryDone);
  await c.close();
});
test('자격 없는데 15:18까지 답이 없음 → 정리하지 않고 20시까지 보유 → 전환', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup({ flow: { fq: -1, oq: -1 } });
  at(15, 10); px(10100); c.st.high = 10150; await A.tick();
  assert.equal(runs[date].payload.eod.weak.length, 1);
  at(15, 19); await A.tick();
  assert.equal(runs[date].payload.eod.decision.kind, 'keep');
  assert.ok(sent.some(t => /15:18 — 답이 없어/.test(t)));
  assert.match(await A.handleEod('/정리 1'), /이미 처리|마감/);
  assert.equal(db.t.paper_positions.get('005930').qty, 100);
  at(20, 2); await A.tick();
  assert.equal(cfg.carry.items['005930'].q0, 100);
  await c.close();
});
test('20시에 서버가 자고 있었으면 다음 날 08:30 에 전환을 보완', async () => {
  const { db, c, A, runs, cfg, date, at, px } = await setup();
  at(15, 10); px(10100); c.st.high = 10150; await A.tick();
  at(8, 30, 1); await A.tick();
  assert.ok(runs[date].payload.carryDone);
  assert.equal(cfg.carry.items['005930'].q0, 100);
  assert.equal(db.t.paper_positions.get('005930').plan.steps.length, 0);
  await c.close();
});
test('손절로 이미 다 팔린 종목은 전환·아침 매도에서 빠짐', async () => {
  const { db, c, A, cfg, at, px } = await setup();
  at(15, 10); px(10100); c.st.high = 10150; await A.tick();
  at(15, 15); px(9400); await c.t.paper.tick();                                    // 손절선(9,500) 아래 → 엔진이 손절
  assert.equal(db.t.paper_positions.has('005930'), false);
  at(20, 1); await A.tick();
  assert.ok(!cfg.carry || !cfg.carry.items['005930']);
  await c.close();
});
