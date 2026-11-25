'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const S = require('../auto-strategy');
const A = require('../auto');
const X = require('../auto-exec');
const E = require('../auto-eod');

/* ── 스키마·검증 ── */
test('기본값은 검증을 통과하고, 165 SQL 에 심은 값과 같다', () => {
  for (const k of ['intraday', 'closing']) assert.deepEqual(S.validate(k, S.defaults(k)).val, S.defaults(k));
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', '165_auto_strategy.sql'), 'utf8');
  const js = [...sql.matchAll(/'(\{"[^']+\})'::jsonb/g)].map(m => JSON.parse(m[1]));
  const LATER = ['pbWMin', 'pbTouchPct', 'pbMaxAge', 'pbStopBelowPct', 'pbHoldDays', 'pbSmBuy', 'pbUpOnly', 'buyType', 'tp1Pct', 'tp2Pct', 'tp1Share', 'selector', 'capMaxEok', 'gapMaxPct', 'chgMaxPct', 'openRiseMin', 'riseWinMin', 'riseMinPct', 'amtSurge', 'minMinAmtKrw', 'pullbackMaxPct', 'optMin', 'flatOn', 'flatAt', 'chaseWaitMin', 'rrSlack', 'intentLostSec', 'smartBuy', 'smartCttr', 'smartRise', 'q1GapPct', 'chaseAsk', 'chasePct', 'regimeMode', 'regimeCaution', 'regimeDefense', 'totalCapKrw', 'repriceTo', 'cancelWaitMin', 'unfilledEnd', 'roundMin', 'roundEnd', 'maxBuys', 'retryUnfilled', 'maxTries', 'minRr', 'tpStyle', 'runnerPct', 'ratchet', 'kwOn', 'kwMax', 'execMode', 'liveAutoOk', 'dryDays', 'amtMinEok', 'sizeMode', 'sizePct', 'paperCapitalKrw', 'minOrderKrw', 'maxOrdersDay', 'rejectStop', 'unsureStop', 'smxWin'];   // 165 이후 추가(E1·F1) — 저장된 전략에 없으면 검증에서 기본값으로 채움
  const I0 = Object.fromEntries(Object.entries(S.defaults('intraday')).filter(([k]) => !LATER.includes(k)));
  I0.weights = { flow: 40, cttr: 15, rise: 15, amt: 15, trend: 15 };               // 165 의 예전 기본 배점 → 검증에서 새 기본 배점(개인 물량 항목 포함)으로 올라감
  I0.eodTimeout = 'keep';                                                           // 165 에는 있었지만 지금은 없는 설정(무응답이면 항상 유지) — 저장돼 있어도 검증이 버림
  assert.deepEqual(js[0], I0);
  assert.deepEqual(S.validate('intraday', js[0]).val, S.defaults('intraday'));
  const LATER_C = ['nxtJudgeAt', 'nxtReplyMin', 'closeBuyOn', 'closeBuyAt', 'closeBuyEnd', 'closeBuyMax', 'closeBuyHighPct', 'closeBuyPenaltyFrom', 'closeBuyPenaltyMax', 'closeBuyApproval', 'closeBuyWatchFrom', 'closeBuyWatchMin', 'closeBuyBonus', ...S.CLOSE_COPY], C0 = Object.fromEntries(Object.entries(S.defaults('closing')).filter(([k]) => !LATER_C.includes(k)));
  assert.deepEqual({ ...js[1], judgeAt: '14:45', replyMin: 15 }, C0);                 // 165 의 15:10 판정은 171 에서 15:00 으로, 2026-11-16 에 다시 14:45·답 15분(기본값)으로 바뀜
  assert.deepEqual(S.validate('closing', js[1]).val.nxtJudgeAt, '18:30');
});
test('기본 시각(선정 10:05 · 알림 10:15 · 마감 10:30 · 정규장 판정 14:45~15:00 · NXT 판정 18:30~19:00 · 전환 20:00)', () => {
  const T = S.timesOf(S.defaults('intraday'), S.defaults('closing'));
  assert.deepEqual(T, { sel: 605, notice: 615, deadline: 630, selEnd: 660, judge: 885, reply: 900, njudge: 1110, nreply: 1140, cbWatch: [1080, 1110, 1140], cbAt: 1170, cbEnd: 1190, convert: 1200, slices: [545, 550, 555] });
});
test('검증: 범위·단위·배점 합계·교차 조건·시각 순서·선택지', () => {
  const v = (k, p) => S.validate(k, p);
  assert.ok(v('intraday', { cttrMin: 79 }).errs);
  assert.ok(v('intraday', { stopPct: 4.3 }).errs);                                   // 0.5 단위
  assert.equal(v('intraday', { stopPct: '4.5' }).val.stopPct, 4.5);                  // 문자열 숫자 허용
  const wk = v('intraday', { weights: { flow: 25, cttr: 15, rise: 15, amt: 30, trend: 15 } });   // 개인 물량 항목이 없는 사용자 조정 배점은 그대로(kw 0점)
  assert.deepEqual(wk.val.weights, { flow: 25, cttr: 15, rise: 15, amt: 30, trend: 15, kw: 0 });
  assert.ok(v('intraday', { weights: { flow: 50, cttr: 15, rise: 15, amt: 15, trend: 15 } }).errs);
  assert.ok(v('intraday', { notifyTop: 8, poolTop: 5 }).errs);
  assert.match(v('intraday', { selectAt: '14:00', noticeAfter: 30, approveWindow: 60 }).errs[0].msg, /14:30/);
  assert.ok(v('intraday', { selectAt: '9:05' }).errs);
  assert.ok(v('intraday', { buyPick: 'mid' }).errs);
  assert.ok(v('intraday', { maTrend: 'yes' }).errs);
  assert.ok(v('closing', { slices: ['09:10', '09:05'] }).errs);
  assert.ok(v('closing', { slices: [] }).errs);
  assert.deepEqual(v('closing', { slices: ['09:20', '09:40'] }).val.slices, ['09:20', '09:40']);
  assert.equal(v('intraday', { junk: 1 }).val.junk, undefined);                       // 모르는 키는 버림
  assert.equal(S.validate('intraday', { cttrMin: 120 }, { ...S.defaults('intraday'), stopPct: 6 }).val.stopPct, 6);   // 빠진 키는 base
  assert.ok(v('nope', {}).errs);
});
test('변경점: 바뀐 항목만, 화면에 보일 문자열로', () => {
  const a = S.defaults('intraday'), b = { ...a, cttrMin: 120, flowProgram: 'bonus', perStockKrw: 2000000 };
  const d = S.diff('intraday', a, b);
  assert.deepEqual(d.map(x => x.key), ['flowProgram', 'cttrMin', 'perStockKrw']);
  assert.equal(d[1].from, '100%'); assert.equal(d[1].to, '120%');
  assert.equal(d[0].to, '가점만'); assert.equal(d[2].to, '2,000,000원');
});

/* ── 저장소 ── */
function fakeDb(rows) {
  const db = { auto_strategies: rows ? rows.map(r => ({ ...r })) : null, versions: [], writes: 0 };
  return {
    db,
    sbGet: async p => {
      if (p.startsWith('auto_strategies')) { if (!db.auto_strategies) throw new Error('auto_strategies 404 PGRST205'); return JSON.parse(JSON.stringify(db.auto_strategies)); }
      if (p.startsWith('auto_strategy_versions')) return db.versions.slice().reverse();
      return [];
    },
    sbWrite: async (p, m, b) => {
      db.writes++;
      if (p.startsWith('auto_strategies')) b.forEach(x => { const i = db.auto_strategies.findIndex(r => r.id === x.id); if (i >= 0) db.auto_strategies[i] = { ...db.auto_strategies[i], ...x }; else db.auto_strategies.push(x); });
      else db.versions.push(...b);
    },
  };
}
const row = (id, kind, extra = {}) => ({ id, name: id, kind, enabled: true, builtin: id.endsWith('default'), version: 1, params: S.defaults(kind), ...extra });

test('저장소: 테이블이 없으면 기본 전략으로 동작하고 저장은 거부', async () => {
  const f = fakeDb(null), st = S.createStore(f);
  const L = await st.list();
  assert.deepEqual(L.map(r => r.id).sort(), ['closing-default', 'ignite-default', 'intraday-default', 'pullback-default']);   // 장초 상승 포착(시동)은 꺼진 기본 전략
  assert.equal(st.isMissing(), true);
  const P = await st.pair();
  assert.equal(P.I.enabled, true); assert.equal(P.T.sel, 605);
  const r = await st.save('intraday-default', { params: { cttrMin: 110 } });
  assert.equal(r.ok, false); assert.equal(r.status, 503);
});
test('저장소: 저장하면 버전 +1, 바뀐 항목 기록, 같은 값이면 쓰지 않음, 잘못된 값은 거부', async () => {
  const f = fakeDb([row('intraday-default', 'intraday'), row('closing-default', 'closing')]), st = S.createStore(f);
  const r = await st.save('intraday-default', { params: { cttrMin: 120, stopPct: 4 } }, 'site');
  assert.equal(r.ok, true); assert.equal(r.strategy.version, 2);
  assert.deepEqual(r.changed.map(c => c.key), ['cttrMin', 'stopPct']);
  assert.equal(f.db.auto_strategies[0].params.cttrMin, 120);
  assert.equal(f.db.auto_strategies[0].params.trail, 2);                 // 안 보낸 값은 그대로
  assert.equal(f.db.versions[0].version, 2); assert.equal(f.db.versions[0].who, 'site');
  const w = f.db.writes;
  assert.equal((await st.save('intraday-default', { params: { cttrMin: 120 } })).unchanged, true);
  assert.equal(f.db.writes, w);
  const bad = await st.save('intraday-default', { params: { cttrMin: 500 } });
  assert.equal(bad.ok, false); assert.equal(bad.status, 400); assert.match(bad.error, /체결강도/);
  assert.equal((await st.save('nope', { enabled: false })).status, 404);
  const off = await st.save('closing-default', { enabled: false });
  assert.equal(off.ok, true); assert.deepEqual(off.changed.map(c => c.key), ['enabled']);
  const P = await st.pair();
  assert.equal(P.C.enabled, false);                                      // 켜진 종가 전략 없음 → 꺼짐으로
  assert.equal(P.I.params.cttrMin, 120);
});
test('저장소: DB의 조건값이 깨져 있으면 기본값으로 쓰고 표시', async () => {
  const f = fakeDb([row('intraday-default', 'intraday', { params: { cttrMin: 9999 } })]), st = S.createStore(f);
  const I = (await st.list()).find(r => r.id === 'intraday-default');
  assert.equal(I.params.cttrMin, 100); assert.ok(I.invalid.length);
});

/* ── 엔진이 조건값을 따르는지 ── */
const P0 = S.defaults('intraday');
const cand = { code: '000001', name: '가', price: 10500, open: 10000, changePct: 3, amt: 5e10, sector: '반도체', rs20: 80 };
test('수급 필수/가점/무시', () => {
  const flow = { fq: 100, oq: 50 }, power = { pgQty: -10 }, cttr = { cttr: 130 };
  assert.equal(A.evalFlow(cand, flow, power, cttr).pass, false);                                   // 기본: 프로그램 필수
  assert.equal(A.evalFlow(cand, flow, power, cttr, { ...P0, flowProgram: 'ignore' }).pass, true);
  assert.equal(A.evalFlow(cand, flow, power, cttr, { ...P0, flowProgram: 'bonus' }).pass, true);
  assert.equal(A.evalFlow(cand, flow, { err: 'x' }, cttr, { ...P0, flowProgram: 'bonus' }).pass, true);   // 가점은 자료 없어도 통과
  assert.equal(A.evalFlow(cand, flow, { pgQty: 5 }, { cttr: 110 }, { ...P0, cttrMin: 120 }).pass, false);
  const m = A.evalFlow(cand, flow, { pgQty: 40 }, cttr).m;
  const small = { ...cand, amt: 2e7 }, sReq = A.scoreOne(small, m, 0.5), sIgn = A.scoreOne(small, m, 0.5, { ...P0, flowProgram: 'ignore' });
  assert.ok(sIgn.parts.flow < sReq.parts.flow);
});
test('기본값으로 부른 결과 = 인자 없이 부른 결과(기존 동작 그대로)', () => {
  const m = A.evalFlow(cand, { fq: 300, oq: 200 }, { pgQty: 100, w52: 11000 }, { cttr: 140 }).m;
  assert.deepEqual(A.scoreOne(cand, m, 0.7, P0), A.scoreOne(cand, m, 0.7));
  assert.equal(A.scoreOne(cand, m, 0.7).total, A.scoreOne(cand, m, 0.7, { ...P0, weights: { ...P0.weights } }).total);
});
test('배점을 바꾸면 해당 항목 비중이 바뀐다', () => {
  const m = A.evalFlow(cand, { fq: 300, oq: 200 }, { pgQty: 100, w52: 11000 }, { cttr: 150 }).m;
  const s = A.scoreOne(cand, m, 1, { ...P0, weights: { flow: 0, cttr: 100, rise: 0, amt: 0, trend: 0 } });
  assert.equal(s.parts.cttr, 100); assert.equal(s.parts.flow, 0); assert.equal(s.total, 100);
});
test('대상 조건: 이평선 끄기 · 매집 지속만 · 시가 대비 상한 · 업종당 수', () => {
  const pool = [{ code: 'A', name: '가', price: 10500, open: 10000, changePct: 2, amt: 2e10 }, { code: 'B', name: '나', price: 10500, open: 10000, changePct: 2, amt: 2e10 }];
  const scr = { A: { close: 10000, ma60: 11000, ma120: 9000, sector: 'x' }, B: { close: 12000, ma60: 11000, ma120: 9000, sector: 'x' } };
  const smx = { A: 'CONT', B: 'STALL' };
  assert.deepEqual(A.baseFilter(pool, scr, smx, null).map(r => r.code), ['B']);
  assert.deepEqual(A.baseFilter(pool, scr, smx, null, { ...P0, maTrend: false }).map(r => r.code), ['A', 'B']);
  assert.deepEqual(A.baseFilter(pool, scr, smx, null, { ...P0, maTrend: false, smx: 'cont' }).map(r => r.code), ['A']);
  assert.deepEqual(A.baseFilter(pool, scr, {}, null, { ...P0, smx: 'off' }).map(r => r.code), ['B']);
  assert.deepEqual(A.baseFilter(pool, scr, smx, null, { ...P0, openRiseMax: 4 }).map(r => r.code), []);
  const L = ['a', 'b', 'c'].map((c, i) => ({ code: c, sector: 's', score: { total: 90 - i } }));
  assert.equal(A.rankAndPick(L, 10, 1).pick.length, 1);
  assert.equal(A.rankAndPick(L, 10, 3).pick.length, 3);
});
test('매수가: 최우선 매수 호가 선택', () => {
  const q = { price: 10050, bids: [{ p: 10000, q: 10 }, { p: 9990, q: 900 }, { p: 9980, q: 5 }], upper: 13000, amt: 5e10 };
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, trade_amount: 5e10, individual_net: 1e9 }));
  assert.equal(X.makeOrder({ q, rows, perStockKrw: 1e6 }).buy, 9990);                          // 기본: 잔량 최다
  const o = X.makeOrder({ q, rows, perStockKrw: 1e6, opt: { buyPick: 'bid1', stopPct: 4 } });
  assert.equal(o.buy, 10000); assert.equal(o.pick, 'bid1'); assert.equal(o.plan.stopPct, 4);
});
test('넘길 자격: 평균가 조건 끄기 · 수급 둘 다/무시 · 고가 범위', () => {
  const ok = { price: 10200, avg: 10000, high: 10300, flow: { fq: 5, oq: -1 }, idx: { 코스피: -0.5 } };
  const R = { ...E.RULE };
  assert.deepEqual(E.carryCheck(ok, R), []);
  assert.match(E.carryCheck(ok, { ...R, carryFlow: 'both' }).join(), /기관 순매수 아님/);
  assert.deepEqual(E.carryCheck({ ...ok, flow: { fq: -1, oq: -1 } }, { ...R, carryFlow: 'ignore' }), []);
  assert.deepEqual(E.carryCheck({ ...ok, price: 9990, high: 10000 }, { ...R, needAboveAvg: false }), []);
  assert.ok(E.carryCheck({ ...ok, high: 10500 }, { ...R, highNear: 0.95 }).length === 0);
});
test('아침 분할: 시각 2개면 절반씩', () => {
  assert.equal(E.sliceTarget(100, 9 * 60 + 19, [560, 580]), 0);
  assert.equal(E.sliceTarget(100, 9 * 60 + 25, [560, 580]), 50);
  assert.equal(E.sliceTarget(100, 9 * 60 + 40, [560, 580]), 100);
});

/* ── 15:10 판정의 약한 종목 처리 방식 · 종가베팅 꺼짐 ── */
function eodRig(rule) {
  const run = { trade_date: 'D', payload: { picks: [{ code: 'A', name: '가', cb: true }], orders: { A: { st: 'filled', filled: 10 } } } };
  const sold = [], sent = [];
  const eod = E.createEod({
    paper: { state: async () => ({ ok: true, positions: [{ code: 'A', name: '가', qty: 10, avg: 10000, avail: 10 }] }),
      place: async o => { sold.push(o); return { ok: true, fills: [{ qty: o.qty, amount: o.qty * 9800 }] }; }, editPlan: async () => ({ ok: true }) },
    getQuote: async () => ({ price: 9800, high: 10300 }), fetchFlow: async () => ({ fq: 1, oq: 1 }), marketIdx: async () => ({}),
    readRun: async () => JSON.parse(JSON.stringify(run)), mutateRun: async (d, fn) => { fn(run); }, mutateCarry: async () => {}, readCarry: async () => ({ items: {} }),
    sendTelegram: async t => sent.push(t), now: () => Date.parse('2026-11-16T06:10:00Z'), rule: async () => rule,
  });
  return { eod, run, sold, sent };
}
test('약한 종목: 예전 자동 정리 설정이어도 자동으로 팔지 않고 승인을 기다린다', async () => {
  const g = eodRig({ eodWeak: 'auto_sell' });
  await g.eod.judge('D');
  assert.equal(g.sold.length, 0); assert.equal(g.run.payload.eod.decision, null);
  assert.match(g.sent[0], /자동으로 팔지 않아요/);
  assert.equal(S.validate('intraday', { eodWeak: 'auto_sell' }).val.eodWeak, 'ask');   // 저장돼 있던 값도 승인 후 정리로 읽음
  assert.equal(S.validate('intraday', { eodTimeout: 'sell' }).val.eodTimeout, undefined);
});
test('약한 종목: 유지 설정이면 묻지 않고 유지, 무응답이면 마감 때 정리하지 않고 유지', async () => {
  const k = eodRig({ eodWeak: 'keep' });
  await k.eod.judge('D');
  assert.equal(k.sold.length, 0); assert.equal(k.run.payload.eod.decision.kind, 'keep');
  const t = eodRig({ eodTimeout: 'sell' });                                          // 예전 '무응답이면 정리' 값이 남아 있어도 무시
  await t.eod.judge('D');
  assert.equal(t.run.payload.eod.decision, null); assert.match(t.sent[0], /15:00까지 답이 없으면 '유지'로 자동 결정/);
  assert.equal(await t.eod.timeout('D'), true);
  assert.equal(t.sold.length, 0); assert.equal(t.run.payload.eod.decision.kind, 'keep'); assert.equal(t.run.payload.eod.decision.timeout, true);
});
test('종가베팅 꺼짐: 이월·정리 판단 없이(묻지도 팔지도 않음) 매도 계획대로만, 20시에도 이월하지 않음', async () => {
  const g = eodRig({ closingOn: false });
  const r0 = await g.eod.judge('D'), r1 = await g.eod.judge('D', 'nxt');
  assert.equal(r0.off, true); assert.equal(r1.off, true);
  assert.equal(g.sold.length, 0); assert.equal(g.sent.length, 0, '정리 질문 알림 없음');
  assert.equal(g.run.payload.eod.none, true); assert.deepEqual(g.run.payload.eod.weak || [], []);
  const r = await g.eod.convert('D');
  assert.equal(r.off, true); assert.equal(g.run.payload.carryDone.off, true);
});

test('장중 전략이 산 종목은 종가베팅 켜져 있어도 판정·정리·이월 대상이 아님(완전 분리) — 매도 계획·직접 매도로만', async () => {
  const g = eodRig({ closingOn: true });
  g.run.payload.picks[0].cb = false;                                   // 장중 전략 매수(종가베팅 후보 아님)
  let edits = 0; g.eod.paper = null;
  const r0 = await g.eod.judge('D'), r1 = await g.eod.judge('D', 'nxt'), c = await g.eod.convert('D');
  assert.equal(r0.n, 0); assert.equal(r1.n, 0); assert.equal(c.n, 0);
  assert.equal(g.sold.length, 0); assert.equal(g.sent.length, 0, '알림 없음(정리 질문·빈 전환 알림 모두)');
  assert.deepEqual(g.run.payload.carryDone.codes, [], '이월 없음');
});

/* ── 시각 설정이 tick 에 반영 ── */
test('선정 시각을 09:30 으로 바꾸면 09:31 에 선정하고 풀은 설정한 시총 하한으로 조회', async () => {
  const I = { ...S.defaults('intraday'), selectAt: '09:30', capMinEok: 5000 }, C = S.defaults('closing');
  const strategies = { pair: async () => ({ I: { id: 'i', version: 3, name: 'x', enabled: true, params: I }, C: { id: 'c', version: 1, enabled: true, params: C }, T: S.timesOf(I, C) }), isMissing: () => false, list: async () => [] };
  let cap = null; const runs = {};
  const auto = A.createAuto({
    strategies, kstNow: () => ({ date: '2026-11-16', min: 9 * 60 + 31 }), isTradingDay: () => true, now: Date.now,
    sbGet: async p => { if (p.startsWith('auto_config')) return [{ key: 'main', value: { on: true } }]; if (p.startsWith('auto_runs')) { const d = (p.match(/eq\.([\d-]+)/) || [])[1]; return runs[d] ? [runs[d]] : []; } if (p.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2026-11-13' }]; return []; },
    sbWrite: async (p, m, b) => { b.forEach(x => { if (p.startsWith('auto_runs')) runs[x.trade_date] = JSON.parse(JSON.stringify(x)); }); },
    sendTelegram: async () => {}, livePool: async c => { cap = c; return []; }, fetchFlow: async () => ({}), fetchPower: async () => ({}), fetchCttr: async () => ({}), marketState: async () => null,
  });
  const r = await auto.tick();
  assert.equal(cap, 5000);
  assert.ok(r.sel && r.sel.ok);
  assert.equal(runs['2026-11-16'].payload.strategy.version, 3);
  assert.equal(runs['2026-11-16'].strategy_id, 'i');
});

/* ── 시장 상태 점수(E1) ── */
test('시장 상태: 기본은 표시만, 금액 조절은 보수·방어 단계만 줄이고 방어 ≤ 보수', () => {
  const A = require('../auto');
  const P = S.defaults('intraday');
  assert.equal(P.regimeMode, 'info');
  const rg = st => ({ date: '2026-11-13', score: 42, stage: st });
  assert.equal(A.regimeMult(P, rg('defense')), 1);
  const Q = { ...P, regimeMode: 'scale' };
  assert.equal(A.regimeMult(Q, rg('attack')), 1); assert.equal(A.regimeMult(Q, rg('normal')), 1);
  assert.equal(A.regimeMult(Q, rg('caution')), 0.5); assert.equal(A.regimeMult(Q, rg('defense')), 0.25);
  assert.equal(A.regimeMult(Q, null), 1);
  assert.match(A.regimeLine(rg('caution'), P), /시장 상태 보수 42점\(11\/13 종가 기준\) · 표시만/);
  assert.match(A.regimeLine(rg('defense'), Q, 250000), /종목당 금액 25%\(250,000원\)/);
  assert.equal(A.regimeLine(null, Q), null);
  assert.match(S.validate('intraday', { regimeCaution: 30, regimeDefense: 40 }).errs[0].msg, /방어 단계 금액/);
  assert.ok(S.validate('intraday', { regimeDefense: 0 }).errs);   // 0%(매수 중단)는 허용 안 함 — 결정: 방어도 줄이기만
  const m = A.formatMessage('2026-11-16', [{ code: 'A', name: '가', price: 1000, open: 990, changePct: 1, sector: 'x', reasons: [], m: { cttr: 120, fAmt: 1, oAmt: 1, pAmt: 1 }, score: { total: 80, ratio: 0.01 }, warns: [] }], { regime: A.regimeLine(rg('defense'), Q, 250000) });
  assert.match(m, /📊 시장 상태 방어 42점/);
});

test('종가베팅 관찰: 시작 시각은 최종 선정보다 빨라야 · 간격 0이면 관찰 없음 · 옛 기본 시각은 새 흐름으로 옮김', async () => {
  assert.ok(S.validate('closing', { closeBuyWatchFrom: '19:00', closeBuyAt: '19:00' }).errs);
  assert.ok(S.validate('closing', { closeBuyWatchMin: 0, closeBuyWatchFrom: '19:00', closeBuyAt: '19:00' }).val);
  assert.deepEqual(S.timesOf(S.defaults('intraday'), { ...S.defaults('closing'), closeBuyWatchMin: 0 }).cbWatch, []);
  assert.deepEqual(S.timesOf(S.defaults('intraday'), { ...S.defaults('closing'), closeBuyWatchFrom: '18:00', closeBuyWatchMin: 60 }).cbWatch, [1080, 1140]);
  const old = { ...S.defaults('closing'), closeBuyAt: '19:05', closeBuyEnd: '19:45' }; ['closeBuyWatchFrom', 'closeBuyWatchMin', 'closeBuyBonus'].forEach(k => delete old[k]);
  const store = S.createStore({ sbGet: async () => [{ id: 'closing-default', name: 'x', kind: 'closing', enabled: true, builtin: true, version: 3, params: old }], sbWrite: async () => {} });
  const L = await store.list(true), C = L.find(r => r.id === 'closing-default');
  assert.equal(C.params.closeBuyAt, '19:30'); assert.equal(C.params.closeBuyEnd, '19:50'); assert.equal(C.params.closeBuyWatchMin, 30);
  const mine = { ...S.defaults('closing'), closeBuyAt: '19:10', closeBuyEnd: '19:45' }; delete mine.closeBuyWatchMin;   // 직접 바꾼 시각은 그대로
  const s2 = S.createStore({ sbGet: async () => [{ id: 'closing-default', name: 'x', kind: 'closing', enabled: true, builtin: true, version: 3, params: mine }], sbWrite: async () => {} });
  assert.equal((await s2.list(true)).find(r => r.id === 'closing-default').params.closeBuyAt, '19:10');
});

test('예전 기본 판정 시각(15:00/20분 · 19:00/40분)을 저장해 둔 종가 전략은 새 기본(14:45→15:00 · 18:30→19:00)으로 읽힘', async () => {
  const old = { ...S.defaults('closing'), judgeAt: '15:00', replyMin: 20, nxtJudgeAt: '19:00', nxtReplyMin: 40 };
  const st = S.createStore({ now: () => 0, sbGet: async () => [{ id: 'closing-default', name: 'x', kind: 'closing', builtin: true, enabled: true, version: 1, params: old }], sbPost: async () => [], sbPatch: async () => [] });
  const r = (await st.list(true)).find(x => x.id === 'closing-default');
  assert.deepEqual([r.params.judgeAt, r.params.replyMin, r.params.nxtJudgeAt, r.params.nxtReplyMin], ['14:45', 15, '18:30', 30]);
});

test('드라이런 점검 기간: 기본 3거래일(1~10), 끝난 날 수·진행일 계산', () => {
  assert.equal(S.defaults('intraday').dryDays, 3);
  assert.equal(S.validate('intraday', { dryDays: 11 }).errs.length > 0, true);
  assert.equal(S.validate('intraday', { dryDays: 0 }).errs.length > 0, true);
  assert.equal(S.validate('intraday', { dryDays: 5 }).val.dryDays, 5);
  const P = S.dryProgress;
  // 시작 전(기록 없음)
  assert.deepEqual(P([], '2026-11-20', 600, 3), { n: 0, day: 0, total: 3, done: false, running: false });
  // 오늘(장중)이 첫날 → 1/3일째, 아직 끝난 날 0
  assert.deepEqual(P(['2026-11-20'], '2026-11-20', 600, 3), { n: 0, day: 1, total: 3, done: false, running: true });
  // 3일 모두 기록 + 3일째 장 마감 전 → 아직 끝나지 않음, 마감 후 끝
  const d3 = ['2026-11-20', '2026-11-23', '2026-11-24'];
  assert.equal(P(d3, '2026-11-24', 14 * 60, 3).done, false);
  assert.equal(P(d3, '2026-11-24', 15 * 60 + 30, 3).done, true);
  assert.equal(P(d3, '2026-11-25', 540, 3).done, true);
  assert.equal(P(d3, '2026-11-25', 540, 3).day, 3);
  assert.equal(P(['2026-11-20'], '2026-11-24', 540, 1).done, true);   // 기간 1일
});

test('거래대금 하한(amtMinEok): 기본 100억원, 0=끔, 장중·종가베팅 둘 다 가짐', () => {
  assert.equal(S.defaults('intraday').amtMinEok, 100);
  assert.equal(S.defaults('closing').amtMinEok, 100);
  assert.equal(S.validate('intraday', { amtMinEok: 300 }).val.amtMinEok, 300);
  assert.equal(S.validate('intraday', { amtMinEok: 0 }).val.amtMinEok, 0);
  assert.equal(S.validate('intraday', { amtMinEok: 9999 }).errs.length > 0, true);
});
