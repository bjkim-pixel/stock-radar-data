'use strict';
/* 눌림목 전략 흐름(2026-11-26 새 규칙): 3개월 내 무게 1·2위일 평균가 아래로 빠짐 + 스마트머니 유지 → 15:10 평균가 +1% 돌파 시 시장가 가상 매수 → 매수가 −5% 종가 마감 손절 · +8/+12% 익절 계획 · N거래일 시간 청산 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

const MIN = 60e3, DAY = 86400e3;
async function rig({ pExtra = {}, smx = [{ win: '21', st: 'CONT', lead_nm: '외국인', lead_trend: 'UP' }, { win: '63', st: 'CONT', lead_nm: '외국인', lead_trend: 'UP' }], lastDelta = 1, priceToday = 10650, noDip = false } = {}) {
  const db = fakeDb(), c = await boot(db, {});
  const runs = {}, cfg = { main: { on: true, liveOn: true, perStockKrw: 1000000 } }, sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const I0 = { ...ST.defaults('intraday'), ...ST.BUILTIN.find(b => b.id === 'pullback-default').preset, ...pExtra };
  const v = ST.validate('intraday', I0); assert.ok(v.val, JSON.stringify(v.errs));
  const I = { id: 'pullback-default', name: '눌림목', version: 1, enabled: true, params: v.val, letter: 'A' };
  const C = { id: 'closing-default', version: 1, enabled: false, params: ST.defaults('closing') };
  I.T = ST.timesOf(I.params, C.params);
  const strategies = { pair: async () => ({ I, C, T: I.T }), actives: async () => ({ Is: [I], C }), list: async () => [I, C], byId: async id => (id === I.id ? I : null), isMissing: () => false };
  const date0 = kst().date, dd = k => new Date(Date.parse(date0 + 'T00:00:00Z') + k * DAY).toISOString().slice(0, 10);
  const prevD = dd(-1), barD = dd(-4), lastD = dd(-lastDelta);
  // 무게 1위일(상한가 +29.9%): 거래대금÷거래량 = 10,500(평균가). 이후 종가가 평균가 −2%(10,290) 아래로 빠진 상태 → 눌림(무장). noDip 이면 계속 위에 머묾
  const H = [
    { code: '035420', trade_date: barD, close: 12000, market_cap: 3000e8 },
    { code: '035420', trade_date: dd(-3), close: noDip ? 12200 : 11000, market_cap: 3000e8 },
    { code: '035420', trade_date: dd(-2), close: noDip ? 11800 : 10200, market_cap: 3000e8 },
    { code: '035420', trade_date: prevD, close: noDip ? 11300 : 10100, market_cap: 3000e8 },
  ];
  const A = createAuto({
    strategies,
    sbGet: async p => {
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) return runs.r ? [JSON.parse(JSON.stringify(runs.r))] : [];
      if (p.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2027-01-12' }];
      if (p.startsWith('v_screener')) return p.includes('offset=0') ? [{ code: '035420', close: 11300, ma60: 9500, ma120: 9000, sector: 'IT', rs20_pctl: 70 }] : [];
      if (p.startsWith('daily_price?select=trade_date')) return [{ trade_date: lastD }];
      if (p.startsWith('record_wt')) return p.includes('offset=0') ? [{ code: '035420', rk: 1, trade_date: barD, w: 0.5, change_pct: 29.9, trade_amount: 1.05e10, volume: 1e6 }] : [];
      if (p.startsWith('daily_price?select=code,trade_date,close')) return p.includes('offset=0') ? H : [];
      if (p.startsWith('smx_state')) return smx.map(r => ({ code: '035420', ...r }));
      if (p.startsWith('stocks?select=code,name,security_type')) return [{ code: '035420', name: 'NAVER', security_type: 'STOCK' }];
      return [];
    },
    sbWrite: async (p, m, b) => { b.forEach(x => { if (p.startsWith('auto_runs')) runs.r = JSON.parse(JSON.stringify(x)); else if (x && x.key) cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => new Date(Date.parse(d + 'T00:00:00Z') - DAY).toISOString().slice(0, 10),
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: 0, trade_date: dd(-40 + i) })),
    pbQuotes: async codes => codes.map(code => ({ code, name: 'NAVER', price: priceToday, open: 10200, high: 10700, low: 10100, changePct: -6, vol: 4e5, amt: 4.3e9 })),
    livePool: async () => [], fetchFlow: async () => ({ err: 'x' }), fetchPower: async () => ({ pgQty: 100 }), fetchCttr: async () => ({ cttr: 60 }), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const at = (k, hh, mm) => { c.st.clock = Date.parse(`${date0}T00:00:00+09:00`) + k * DAY + (hh * 60 + mm) * MIN; };
  const quote = price => { const st = c.st; st.price = price; st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]); st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]); st.low = Math.min(st.low, price); st.high = Math.max(st.high, price); };
  return { c, A, runs, sent, date0, at, quote };
}

test('15:10 선정 → 시장가 매수 · 손절 = 매수가−5% · 익절 +8/+12% · 종가 마감 손절은 15:15 이후에만', async () => {
  const { c, A, runs, at, quote } = await rig();
  try {
    at(0, 15, 10); quote(10650);
    const tk = await A.tick(); if (process.env.DBG) console.log('TICK', JSON.stringify(tk).slice(0, 1500));
    const P = runs.r && runs.r.payload;
    assert.ok(P, '오늘 기록이 만들어져야 함');
    assert.deepEqual(P.picks.map(p => p.code), ['035420'], JSON.stringify(P.stat || P));
    assert.ok(P.picks[0].reasons.some(r => /무게\/주식수 1위일/.test(r)) && P.picks[0].reasons.some(r => /평균가를 돌파/.test(r)) && P.picks[0].reasons.some(r => /스마트머니 1개월/.test(r)));
    assert.equal(P.picks[0].pb.rk, 1); assert.equal(P.picks[0].pb.vw, 10500);
    const o = P.orders && P.orders['035420'];
    assert.ok(o && o.plan, '자동 승인으로 주문 + 매도계획: ' + JSON.stringify(P.decision || P.stat));
    // 체결강도 60%(기준 100% 미만)·시가 대비 −6% 인데도 재확인에서 막지 않음(종가 매수 전략은 호가 강도를 안 봄)
    assert.notEqual(o.st, 'skipped', o.why);
    assert.equal(o.plan.stop, 10110, '현재가 10,650 × 0.95 = 10,117.5 → 호가 내림');
    assert.equal(o.plan.closeStop, true);
    assert.deepEqual(o.plan.steps.map(s => s.p), [11520, 11940], '매수가 10,660 → +8% · +12%');
    const S1 = await c.t.paper.state();
    const b1 = S1.orders.find(x => x.code === '035420' && x.side === 'buy');
    assert.equal(b1.type, 'market');
    const pos = S1.positions.find(p => p.code === '035420');
    assert.ok(pos && pos.qty > 0 && pos.plan.closeStop === true && pos.plan.stop === 10110);
    // 15:12 손절가 아래로 잠깐 내려가도(장중 흔들림) 손절하지 않음
    at(0, 15, 12); quote(10000); await c.t.paper.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:15 전에는 손절 안 함');
    // 15:16 에도 손절가 아래면 종가 마감 손절
    at(0, 15, 16); quote(10000); await c.t.paper.tick();
    assert.ok(!(await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:15 이후 손절가 아래면 전량 매도');
  } finally { await c.close(); }
});

test('종가 마감 손절: 15:15 이후 손절가 위로 회복해 있으면 팔지 않음', async () => {
  const { c, A, at, quote } = await rig();
  try {
    at(0, 15, 10); quote(10650); await A.tick();
    at(0, 15, 14); quote(10000); await c.t.paper.tick();
    at(0, 15, 16); quote(10300); await c.t.paper.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0));
  } finally { await c.close(); }
});

test('시간 청산: 매수 후 pbHoldDays 거래일째 15:05 에 전량 시장가 매도', async () => {
  const { c, A, sent, at, quote } = await rig({ pExtra: { pbHoldDays: 2 } });
  try {
    at(0, 15, 10); quote(10650); await A.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '매수');
    at(1, 15, 6); quote(10650); await A.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '1거래일째엔 보유');
    at(2, 15, 4); quote(10650); await A.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:05 전엔 보유');
    at(2, 15, 6); quote(10650); await A.tick();
    assert.ok(!(await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '2거래일째 15:05 이후 전량 청산');
    assert.ok(sent.some(t => /시간 청산/.test(t)));
  } finally { await c.close(); }
});

test('조건: 스마트머니 이탈·돌파 구간 밖·눌림 아님·일봉 갱신 지연은 후보 없음, 점검을 끄면 통과', async () => {
  const sm = (a, b, t = 'UP') => [{ win: '21', st: a, lead_nm: '외국인', lead_trend: t }, { win: '63', st: b, lead_nm: '외국인', lead_trend: 'UP' }];
  const none = async (o, price = 10650) => { const r = await rig(o); try { r.at(0, 15, 10); r.quote(price); await r.A.tick(); const P = r.runs.r && r.runs.r.payload; assert.deepEqual((P && P.picks) || [], []); return JSON.stringify(P); } finally { await r.c.close(); } };
  assert.match(await none({ smx: sm('LEAVE', 'CONT') }), /스마트머니 1개월: 이탈 진행/);
  assert.match(await none({ smx: sm('CONT', 'CONT', 'DOWN').map(x => (x.win === '63' ? { ...x, lead_trend: 'DOWN' } : x)) }), /스마트머니 3개월: 주도 외국인 매도 중/);
  assert.match(await none({ smx: [] }), /스마트머니 1개월 자료 없음/);
  let r = await rig({ smx: sm('LEAVE', 'OUT'), pExtra: { pbSmGate: false } });
  try { r.at(0, 15, 10); r.quote(10650); await r.A.tick(); assert.equal(r.runs.r.payload.picks.length, 1, '점검을 끄면 통과'); } finally { await r.c.close(); }
  assert.match(await none({ priceToday: 10600 }, 10600), /아직 못 되찾음/);                        // +0.95% < +1%
  assert.match(await none({ priceToday: 11300 }, 11300), /쫓지 않음/);                            // +7.6% > +6%
  await none({ noDip: true });                                                                    // 계속 평균가 위 → 눌림 아님
  r = await rig({ lastDelta: 3 });   // 일봉이 어제까지 안 들어옴
  try { r.at(0, 15, 10); r.quote(10650); await r.A.tick(); const P = r.runs.r && r.runs.r.payload; assert.deepEqual((P && P.picks) || [], []); assert.match(JSON.stringify(P), /일봉이/); } finally { await r.c.close(); }
});

test('관찰 목록 API: 평균가 아래로 빠진 종목을 기준가 대비 위치·스마트머니 점검과 함께 돌려줌(돌파+통과 종목 먼저)', async () => {
  const { c, A, at, quote } = await rig();
  try {
    at(0, 14, 0); quote(10650);
    const r = await A.pullbackWatch();
    assert.equal(r.ok, true); assert.equal(r.stale, false); assert.equal(r.rows.length, 1);
    const x = r.rows[0];
    assert.equal(x.code, '035420'); assert.equal(x.vw, 10500); assert.equal(x.rk, 1); assert.equal(x.gap, 1.4); assert.equal(x.hit, true); assert.equal(x.smOk, true);
    assert.equal(x.sm['21'].st, 'CONT'); assert.equal(x.minGap, -3.8); assert.ok(x.dipDate);
    assert.equal(r.breakPct, 1); assert.equal(r.maxAge, 63); assert.equal(r.smGate, true);
  } finally { await c.close(); }
  const r1 = await rig({ smx: [{ win: '21', st: 'HEAVY', lead_nm: '기관', lead_trend: 'DOWN' }, { win: '63', st: 'CONT', lead_nm: '기관', lead_trend: 'UP' }] });
  try { r1.at(0, 14, 0); r1.quote(10650); const w = await r1.A.pullbackWatch(); assert.equal(w.rows[0].smOk, false); assert.equal(w.rows[0].hit, false, '스마트머니 점검 실패면 매수 후보 표시 안 함'); assert.match(w.rows[0].smFails.join(), /이탈 심화/); } finally { await r1.c.close(); }
  const r0 = await rig({ noDip: true });
  try { r0.at(0, 14, 0); r0.quote(10650); const w = await r0.A.pullbackWatch(); assert.deepEqual(w.rows, [], '눌림이 없으면 관찰 목록에 없음'); } finally { await r0.c.close(); }
  const r2 = await rig({ lastDelta: 3 });
  try { r2.at(0, 14, 0); const w = await r2.A.pullbackWatch(); assert.equal(w.stale, true); assert.deepEqual(w.rows, []); } finally { await r2.c.close(); }
});

test('화면 상태: 어제 산 눌림목 종목도 보유 목록에 전략 id 와 함께 나오고, 오늘 청산 내역에도 전략 id 가 붙음', async () => {
  const { c, A, at, quote } = await rig({ pExtra: { pbHoldDays: 2 } });
  try {
    at(0, 15, 10); quote(10650); await A.tick();
    at(1, 11, 0); quote(10700);
    let u = await A.uiState(null, 'paper');
    const p = (u.positions || []).find(x => x.code === '035420');
    assert.ok(p, '다음 날 아침 오늘 주문이 없어도 보유 목록에 있어야 함: ' + JSON.stringify(u.positions));
    assert.equal(p.sid, 'pullback-default');
    at(2, 15, 6); quote(10700); await A.tick();
    u = await A.uiState(null, 'paper');
    const f = (u.trades || []).find(x => x.code === '035420' && x.side === 'sell');
    assert.ok(f, '시간 청산 체결이 오늘 매매 내역에 보여야 함');
    assert.equal(f.sid, 'pullback-default');
  } finally { await c.close(); }
});
