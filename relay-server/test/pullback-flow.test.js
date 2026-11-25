'use strict';
/* 눌림목 전략 흐름(2026-11-26): 15:10 후보 선정 → 시장가 가상 매수 → 평균가 −5% 종가 마감 손절 · +8/+12% 익절 계획 · N거래일 시간 청산 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

const MIN = 60e3, DAY = 86400e3;
async function rig({ pExtra = {}, flowNet = 5e9, lastDelta = 1, lowToday = 10500, priceToday = 10600 } = {}) {
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
  // 막대일(상한가 +29.9%): 시가 9000 → 종가 12000, 거래대금÷거래량 = 10500(평균가). 이후 2일은 크게 위에서 머묾 → 아직 재터치 없음
  const H = [
    { code: '035420', trade_date: barD, open: 9000, high: 12000, low: 9000, close: 12000, volume: 1e6, trade_amount: 1.05e10 },
    { code: '035420', trade_date: dd(-3), open: 12000, high: 12600, low: 11700, close: 12200, volume: 5e5, trade_amount: 6e9 },
    { code: '035420', trade_date: dd(-2), open: 12200, high: 12500, low: 11500, close: 11800, volume: 5e5, trade_amount: 6e9 },
    { code: '035420', trade_date: prevD, open: 11800, high: 11900, low: 11200, close: 11300, volume: 5e5, trade_amount: 5.8e9 },
  ];
  const A = createAuto({
    strategies,
    sbGet: async p => {
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) return runs.r ? [JSON.parse(JSON.stringify(runs.r))] : [];
      if (p.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2027-01-12' }];
      if (p.startsWith('v_screener')) return p.includes('offset=0') ? [{ code: '035420', close: 11300, ma60: 9500, ma120: 9000, sector: 'IT', rs20_pctl: 70 }] : [];
      if (p.startsWith('daily_price?select=trade_date')) return [{ trade_date: lastD }];
      if (p.startsWith('daily_price?select=code,trade_date,weight_per_share')) return p.includes('offset=0') ? [{ code: '035420', trade_date: barD, weight_per_share: 0.5, change_pct: 29.9, market_cap: 3000e8 }] : [];
      if (p.startsWith('daily_price?select=code,trade_date,open')) return p.includes('offset=0') ? H : [];
      if (p.startsWith('daily_flow')) return p.includes('offset=0') ? [{ code: '035420', trade_date: barD, foreign_net: flowNet, inst_net: flowNet / 5 }] : [];
      if (p.startsWith('stocks?select=code,name,security_type')) return [{ code: '035420', name: 'NAVER', security_type: 'STOCK' }];
      return [];
    },
    sbWrite: async (p, m, b) => { b.forEach(x => { if (p.startsWith('auto_runs')) runs.r = JSON.parse(JSON.stringify(x)); else if (x && x.key) cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => new Date(Date.parse(d + 'T00:00:00Z') - DAY).toISOString().slice(0, 10),
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: 0, trade_date: dd(-40 + i) })),
    pbQuotes: async codes => codes.map(code => ({ code, name: 'NAVER', price: priceToday, open: 11300, high: 11400, low: lowToday, changePct: -6, vol: 4e5, amt: 4.3e9 })),
    livePool: async () => [], fetchFlow: async () => ({ err: 'x' }), fetchPower: async () => ({ pgQty: 100 }), fetchCttr: async () => ({ cttr: 60 }), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const at = (k, hh, mm) => { c.st.clock = Date.parse(`${date0}T00:00:00+09:00`) + k * DAY + (hh * 60 + mm) * MIN; };
  const quote = price => { const st = c.st; st.price = price; st.asks = Array.from({ length: 10 }, (_, i) => [price + 10 * (i + 1), 100]); st.bids = Array.from({ length: 10 }, (_, i) => [price - 10 * i, 100]); st.low = Math.min(st.low, price); st.high = Math.max(st.high, price); };
  return { c, A, runs, sent, date0, at, quote };
}

test('15:10 선정 → 시장가 매수 · 손절 = 평균가−5% · 익절 +8/+12% · 종가 마감 손절은 15:15 이후에만', async () => {
  const { c, A, runs, at, quote } = await rig();
  try {
    at(0, 15, 10); quote(10600);
    const tk = await A.tick(); if (process.env.DBG) console.log('TICK', JSON.stringify(tk).slice(0, 1500));
    const P = runs.r && runs.r.payload;
    assert.ok(P, '오늘 기록이 만들어져야 함');
    assert.deepEqual(P.picks.map(p => p.code), ['035420'], JSON.stringify(P.stat || P));
    assert.ok(P.picks[0].reasons.some(r => /무게 신고 막대/.test(r)) && P.picks[0].reasons.some(r => /평균가/.test(r)));
    assert.equal(P.picks[0].pb.barDate.slice(5), P.picks[0].pb.barDate.slice(5));
    const o = P.orders && P.orders['035420'];
    assert.ok(o && o.plan, '자동 승인으로 주문 + 매도계획: ' + JSON.stringify(P.decision || P.stat));
    // 체결강도 60%(기준 100% 미만)·시가 대비 −6% 인데도 재확인에서 막지 않음(종가 매수 전략은 호가 강도를 안 봄)
    assert.notEqual(o.st, 'skipped', o.why);
    assert.equal(o.plan.stop, 9970, '평균가 10,500 × 0.95 = 9,975 → 호가 내림');
    assert.equal(o.plan.closeStop, true);
    assert.deepEqual(o.plan.steps.map(s => s.p), [11460, 11890], '매수가 10,610 → +8% · +12%');
    const S1 = await c.t.paper.state();
    const b1 = S1.orders.find(x => x.code === '035420' && x.side === 'buy');
    assert.equal(b1.type, 'market');
    const pos = S1.positions.find(p => p.code === '035420');
    assert.ok(pos && pos.qty > 0 && pos.plan.closeStop === true && pos.plan.stop === 9970);
    // 15:12 손절가 아래로 잠깐 내려가도(장중 흔들림) 손절하지 않음
    at(0, 15, 12); quote(9900); await c.t.paper.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:15 전에는 손절 안 함');
    // 15:16 에도 손절가 아래면 종가 마감 손절
    at(0, 15, 16); quote(9900); await c.t.paper.tick();
    assert.ok(!(await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:15 이후 손절가 아래면 전량 매도');
  } finally { await c.close(); }
});

test('종가 마감 손절: 15:15 이후 손절가 위로 회복해 있으면 팔지 않음', async () => {
  const { c, A, at, quote } = await rig();
  try {
    at(0, 15, 10); quote(10600); await A.tick();
    at(0, 15, 14); quote(9900); await c.t.paper.tick();
    at(0, 15, 16); quote(10300); await c.t.paper.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0));
  } finally { await c.close(); }
});

test('시간 청산: 매수 후 pbHoldDays 거래일째 15:05 에 전량 시장가 매도', async () => {
  const { c, A, sent, at, quote } = await rig({ pExtra: { pbHoldDays: 2 } });
  try {
    at(0, 15, 10); quote(10600); await A.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '매수');
    at(1, 15, 6); quote(10600); await A.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '1거래일째엔 보유');
    at(2, 15, 4); quote(10600); await A.tick();
    assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:05 전엔 보유');
    at(2, 15, 6); quote(10600); await A.tick();
    assert.ok(!(await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '2거래일째 15:05 이후 전량 청산');
    assert.ok(sent.some(t => /시간 청산/.test(t)));
  } finally { await c.close(); }
});

test('조건: 막대일 외+기 순매도면 pbSmBuy 가 막고, 상한가 막대만(pbUpOnly)·재터치 아님(저가 위)·일봉 갱신 지연은 후보 없음', async () => {
  let r = await rig({ pExtra: { pbSmBuy: true }, flowNet: -5e9 });
  try { r.at(0, 15, 10); r.quote(10600); await r.A.tick(); const P = r.runs.r && r.runs.r.payload; assert.deepEqual((P && P.picks) || [], []); assert.ok(JSON.stringify(P).includes('외+기')); } finally { await r.c.close(); }
  r = await rig({ pExtra: { pbSmBuy: true }, flowNet: 5e9 });
  try { r.at(0, 15, 10); r.quote(10600); await r.A.tick(); assert.equal(r.runs.r.payload.picks.length, 1); } finally { await r.c.close(); }
  r = await rig({ pExtra: { pbUpOnly: true } });   // 막대 +29.9% → 상한가 막대 통과
  try { r.at(0, 15, 10); r.quote(10600); await r.A.tick(); assert.equal(r.runs.r.payload.picks.length, 1); } finally { await r.c.close(); }
  r = await rig({ lowToday: 11000, priceToday: 11050 });   // 저가가 평균가+3%(10,815) 위 → 재터치 아님
  try { r.at(0, 15, 10); r.quote(11050); await r.A.tick(); assert.deepEqual((r.runs.r.payload.picks) || [], []); } finally { await r.c.close(); }
  r = await rig({ lastDelta: 3 });   // 일봉이 어제까지 안 들어옴
  try { r.at(0, 15, 10); r.quote(10600); await r.A.tick(); const P = r.runs.r && r.runs.r.payload; assert.deepEqual((P && P.picks) || [], []); assert.match(JSON.stringify(P), /일봉이/); } finally { await r.c.close(); }
});
