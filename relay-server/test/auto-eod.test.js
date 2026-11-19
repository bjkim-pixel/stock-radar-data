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

/* ── 실제 가상매매 엔진: 10:16 승인·체결 → 15:00 판정 → 20:00 전환 → 다음 날 아침 매도 ── */
const MIN = 60e3, DAY = 864e5;
async function setup({ flow = { fq: 10, oq: 0 }, idx = { 코스피: 0.3, 코스닥: 0.1 }, code = '005930' } = {}) {
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
  runs[date] = { trade_date: date, status: 'noticed', payload: { picks: [{ code, name: code === '005930' ? '삼성전자' : 'SK하이닉스', price: 10000, score: 80, cb: true }], noticeSent: true, approved: [], decision: null } };
  c.st.clock += 16 * MIN;
  await A.handleApproval('/매수 1');
  c.st.clock += 5000; c.st.vol += 700; await c.t.paper.tick();   // 100주 @10,000 체결
  await A.tick();
  assert.equal(db.t.paper_positions.get(code).qty, 100);
  const at = (hh, mm, dayOff = 0) => { const d0 = Date.parse(`${date}T00:00:00+09:00`); c.st.clock = d0 + dayOff * DAY + (hh * 60 + mm) * MIN; };
  const px = p => { c.st.price = p; c.st.high = Math.max(c.st.high, p); c.st.low = Math.min(c.st.low, p); c.st.bids = Array.from({ length: 10 }, (_, i) => [p - (i + 1) * 10, 1000]); c.st.asks = Array.from({ length: 10 }, (_, i) => [p + i * 10, 1000]); };
  return { db, c, A, runs, cfg, sent, date, at, px };
}

test('자격 있는 종목: 14:45 판정만 알림 → 20:00 익절 끄고(손절 유지) 넘김 → 다음 날 09:05·09:10·09:15 1/3씩 매도', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup();
  at(14, 46); px(10100); c.st.high = 10150;
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
test('다음 날 갭 하락(−3%)이어도 현재가가 매수가보다 낮으면 즉시 팔지 않고 장중 전환(아침 보류)', async () => {
  const { db, c, A, cfg, sent, at, px } = await setup();
  at(14, 46); px(10100); c.st.high = 10150; await A.tick();
  at(20, 1); await A.tick();
  at(9, 1, 1); px(9700); await A.tick();                                             // 전일 종가(10,000) 대비 −3%
  assert.equal(db.t.paper_positions.has('005930'), true);
  assert.equal(cfg.carry.items['005930'].state, 'intra');
  await c.close();
});
test('자격 없는 종목: 14:45 알림 → /정리 1 → 시장가 전량 매도, 20시 넘길 게 없음', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup();
  at(14, 46); px(9950); await A.tick();                                              // 매수가 아래
  assert.ok(sent.some(t => /넘길 자격이 없는 종목/.test(t) && /1\. 삼성전자/.test(t)), sent.join('|'));
  at(14, 55); const r = await A.handleEod('/정리 1');
  assert.match(r, /100주 평균/);
  assert.equal(db.t.paper_positions.has('005930'), false);
  assert.match(await A.handleEod('/정리 1'), /이미 처리/);
  at(20, 1); await A.tick();
  assert.ok(!cfg.carry || !cfg.carry.items['005930']);
  assert.ok(runs[date].payload.carryDone);
  await c.close();
});
test('자격 없는데 15:00까지 답이 없음 → 정리하지 않고 20시까지 보유 → 전환', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup({ flow: { fq: -1, oq: -1 } });
  at(14, 46); px(10100); c.st.high = 10150; await A.tick();
  assert.equal(runs[date].payload.eod.weak.length, 1);
  at(15, 1); await A.tick();
  assert.equal(runs[date].payload.eod.decision.kind, 'keep');
  assert.ok(sent.some(t => /15:00 — 답이 없어/.test(t)));
  assert.match(await A.handleEod('/정리 1'), /이미 처리|마감/);
  assert.equal(db.t.paper_positions.get('005930').qty, 100);
  at(20, 2); await A.tick();
  assert.equal(cfg.carry.items['005930'].q0, 100);
  await c.close();
});
test('20시에 서버가 자고 있었으면 다음 날 08:30 에 전환을 보완', async () => {
  const { db, c, A, runs, cfg, date, at, px } = await setup();
  at(14, 46); px(10100); c.st.high = 10150; await A.tick();
  at(8, 30, 1); await A.tick();
  assert.ok(runs[date].payload.carryDone);
  assert.equal(cfg.carry.items['005930'].q0, 100);
  assert.equal(db.t.paper_positions.get('005930').plan.steps.length, 0);
  await c.close();
});
test('손절로 이미 다 팔린 종목은 전환·아침 매도에서 빠짐', async () => {
  const { db, c, A, cfg, at, px } = await setup();
  at(14, 46); px(10100); c.st.high = 10150; await A.tick();
  at(15, 15); px(9400); await c.t.paper.tick();                                    // 손절선(9,500) 아래 → 엔진이 손절
  assert.equal(db.t.paper_positions.has('005930'), false);
  at(20, 1); await A.tick();
  assert.ok(!cfg.carry || !cfg.carry.items['005930']);
  await c.close();
});

/* ── 2026-11-16 개편: 정규장 종목은 14:45, NXT 거래 종목은 18:30 에 따로 판정 · 정리는 승인 후에만 ── */
test('NXT 종목은 14:45 에 판정하지 않고 18:30 으로 미룸(알림에 안내)', async () => {
  const { c, A, runs, sent, date, at, px } = await setup({ code: '000660' });
  at(14, 46); px(9950); await A.tick();
  assert.equal(runs[date].payload.eod.items.length, 0); assert.equal(runs[date].payload.eod.other.length, 1);
  assert.ok(sent.some(t => /NXT 거래 가능 1종목\(SK하이닉스\)은 18:30에 따로 판정/.test(t)), sent.join('|'));
  assert.equal(runs[date].payload.eodN, undefined);
  at(15, 1); await A.tick();
  assert.equal(runs[date].payload.eodN, undefined);                                   // 15시대에는 NXT 판정 없음
  await c.close();
});
test('18:30 NXT 판정: 약한 종목은 자동으로 팔지 않고 알림 → /정리 1 → 지정가(매수 호가)로 매도', async () => {
  const { db, c, A, runs, sent, date, at, px } = await setup({ code: '000660' });
  at(14, 46); px(9950); await A.tick();
  at(18, 31); px(9950); await A.tick();
  const EN = runs[date].payload.eodN;
  assert.equal(EN.weak.length, 1); assert.equal(EN.decision, null);
  assert.ok(sent.some(t => /NXT 종가 판정/.test(t) && /자동으로 팔지 않아요/.test(t) && /19:00/.test(t)), sent.join('|'));
  assert.equal(db.t.paper_positions.get('000660').qty, 100);                          // 승인 전에는 그대로
  at(18, 50); await A.tick();
  assert.equal(db.t.paper_positions.get('000660').qty, 100);
  at(18, 45); const r = await A.handleEod('/정리 1');
  assert.match(r, /NXT 종가 전 정리\(지정가/); assert.match(r, /100주 평균 9,940원/);
  assert.equal(db.t.paper_positions.has('000660'), false);
  assert.match(await A.handleEod('/정리 1'), /이미 처리|지금 정리할지/);
  await c.close();
});
test('19:00 까지 답이 없으면 정리하지 않고 유지 → 20:00 이월', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await setup({ code: '000660' });
  at(18, 31); px(9950); await A.tick();
  assert.equal(runs[date].payload.eodN.weak.length, 1);
  at(19, 1); await A.tick();
  assert.equal(runs[date].payload.eodN.decision.kind, 'keep'); assert.equal(runs[date].payload.eodN.decision.timeout, true);
  assert.ok(sent.some(t => /19:00 — 답이 없어 '유지'로 자동 결정/.test(t)));
  assert.equal(db.t.paper_positions.get('000660').qty, 100);
  at(20, 1); await A.tick();
  assert.equal(cfg.carry.items['000660'].q0, 100);
  await c.close();
});
test('사이트 정리 승인은 이월 전환을 앞당기지 않음(20:00 에 전환) · 18:30 판정 전에는 NXT 승인 불가', async () => {
  const { db, c, A, runs, cfg, date, at, px } = await setup({ code: '000660' });
  at(18, 31); px(9950); await A.tick();
  const r = await A.siteEod('keep', [], runs[date].strategy_id || 'intraday-default', 'nxt');
  assert.equal(r.ok, true); assert.doesNotMatch(r.reply, /다음 단계/);
  assert.equal(runs[date].payload.carryDone, undefined);
  assert.equal(cfg.carry, undefined);
  at(20, 1); await A.tick();
  assert.ok(runs[date].payload.carryDone);
  await c.close();
});
test('정규장 종목과 NXT 종목이 섞이면 14:45·18:30에 각각 판정', async () => {
  const { c, A, runs, date, at, px } = await setup();                                  // 005930(정규장)
  at(14, 46); px(9950); await A.tick();
  assert.equal(runs[date].payload.eod.items.length, 1); assert.equal(runs[date].payload.eod.items[0].name, '삼성전자');
  at(18, 31); await A.tick();
  assert.equal(runs[date].payload.eodN.items.length, 0); assert.equal(runs[date].payload.eodN.other.length, 1);   // 19시에는 NXT 종목만
  await c.close();
});
test('NXT 지정가 매도 가격: 수량이 다 걸리는 매수 호가까지 내려서', () => {
  const q = { bids: [{ p: 10000, q: 30 }, { p: 9990, q: 50 }, { p: 9980, q: 500 }, { p: 0, q: 0 }] };
  assert.equal(X.limitSellPrice(q, 20), 10000);
  assert.equal(X.limitSellPrice(q, 70), 9990);
  assert.equal(X.limitSellPrice(q, 300), 9980);
  assert.equal(X.limitSellPrice(q, 9999), 9980);                                      // 호가가 모자라면 보이는 가장 낮은 호가
  assert.equal(X.limitSellPrice({ bids: [] }, 10), null);
});

test('답 받을 시간대: 정규장이 먼저 · NXT 는 NXT 판정 시각 이후에만(시각 전 /유지 가 NXT 종목을 처리하지 않음)', () => {
  const { createEod } = require('../auto-eod');
  const e = createEod({ now: () => 0 });
  const both = { eod: { weak: ['a'], decision: null }, eodN: { weak: ['b'], decision: null } };
  assert.equal(e.pendingPhase(both, 14 * 60 + 50, 18 * 60 + 30), 'reg');
  const regDone = { eod: { weak: ['a'], decision: { kind: 'keep' } }, eodN: { weak: ['b'], decision: null } };
  assert.equal(e.pendingPhase(regDone, 15 * 60 + 20, 18 * 60 + 30), null);          // NXT 판정 시각 전: 아무것도 처리 안 함
  assert.equal(e.pendingPhase(regDone, 18 * 60 + 31, 18 * 60 + 30), 'nxt');
});
