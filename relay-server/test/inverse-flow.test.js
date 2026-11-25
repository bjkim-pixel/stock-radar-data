'use strict';
/* 인버스·사이드카 전략 흐름(2026-11-26): A 하락 국면 보유 · B 외국인 동반 순매도 · C 매도 사이드카 반등 — 선정 → 시장가 가상 매수 → 정리 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy');
const INV = require('../inverse');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

const MIN = 60e3, DAY = 86400e3;
const IDS = { regime: 'inverse-regime', flow: 'inverse-flow', sidecar: 'sidecar-rebound' };
async function rig({ mode, pExtra = {}, kPrice = 9000, kChg = -1, flowSpot = -3000, flowFut = -2000, flowDate = null, events = [], etfPrice = 10000 } = {}) {
  const db = fakeDb(), c = await boot(db, {});
  const runs = {}, cfg = { main: { on: true, liveOn: true, perStockKrw: 1000000 } }, sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const b = ST.BUILTIN.find(x => x.id === IDS[mode]); assert.ok(b && b.off, '꺼진 기본 전략으로 등록');
  const v = ST.validate('intraday', { ...ST.defaults('intraday'), ...b.preset, ...pExtra }); assert.ok(v.val, JSON.stringify(v.errs));
  const I = { id: b.id, name: b.name, version: 1, enabled: true, params: v.val, letter: 'A' };
  const C = { id: 'closing-default', version: 1, enabled: false, params: ST.defaults('closing') };
  I.T = ST.timesOf(I.params, C.params);
  const strategies = { pair: async () => ({ I, C, T: I.T }), actives: async () => ({ Is: [I], C }), list: async () => [I, C], byId: async id => (id === I.id ? I : null), isMissing: () => false };
  const date0 = kst().date, dd = k => new Date(Date.parse(date0 + 'T00:00:00Z') + k * DAY).toISOString().slice(0, 10), prevD = dd(-1);
  const closes = Array.from({ length: 70 }, () => 10000);
  const A = createAuto({
    strategies,
    sbGet: async p => {
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) return runs.r ? [JSON.parse(JSON.stringify(runs.r))] : [];
      if (p.startsWith('etf_daily')) return closes.map((x, i) => ({ trade_date: dd(-1 - i), close: x })).slice(0, 75);
      if (p.startsWith('market_events')) return events;
      if (p.startsWith('market_investor_detail')) return [{ trade_date: flowDate || prevD, foreign_net: flowSpot }];
      if (p.startsWith('market_investor_daily')) return [{ trade_date: flowDate || prevD, foreign_net: flowFut }];
      return [];
    },
    sbWrite: async (p, m, bb) => { bb.forEach(x => { if (p.startsWith('auto_runs')) runs.r = JSON.parse(JSON.stringify(x)); else if (x && x.key) cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => new Date(Date.parse(d + 'T00:00:00Z') - DAY).toISOString().slice(0, 10),
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => Array.from({ length: 30 }, (_, i) => ({ close: 10000, high: 10100, low: 9900, trade_amount: 5e10, individual_net: 0, trade_date: dd(-40 + i) })),
    pbQuotes: async codes => codes.map(code => (code === '069500' ? { code, name: 'KODEX 200', price: kPrice, open: 10000, high: 10000, low: kPrice, changePct: kChg, vol: 1e6, amt: 1e11 } : { code, name: 'ETF' + code, price: etfPrice, open: etfPrice, high: etfPrice, low: etfPrice, changePct: 1, vol: 1e6, amt: 1e10 })),
    livePool: async () => [], fetchFlow: async () => ({ err: 'x' }), fetchPower: async () => ({ pgQty: 100 }), fetchCttr: async () => ({ cttr: 60 }), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const at = (k, hh, mm) => { c.st.clock = Date.parse(`${date0}T00:00:00+09:00`) + k * DAY + (hh * 60 + mm) * MIN; };
  const quote = price => { const st = c.st; st.price = price; st.asks = Array.from({ length: 10 }, (_, i) => [price + 5 * (i + 1), 1000]); st.bids = Array.from({ length: 10 }, (_, i) => [price - 5 * i, 1000]); st.low = Math.min(st.low, price); st.high = Math.max(st.high, price); };
  const set = o => Object.assign(o, {});
  const held = async code => (await c.t.paper.state()).positions.some(p => p.code === code && p.qty > 0);
  return { c, A, runs, sent, date0, at, quote, held, setK: (p, ch) => { kPrice = p; kChg = ch; } };
}

test('기본 전략 3개(A·B·C): 모두 꺼진 가상 전략 · 선정 방식 inverse · 검증 통과', () => {
  for (const [mode, id] of Object.entries(IDS)) {
    const b = ST.BUILTIN.find(x => x.id === id);
    assert.ok(b && b.off && b.preset.selector === 'inverse' && b.preset.invMode === mode, id);
    const r = ST.validate('intraday', { ...ST.defaults('intraday'), ...b.preset });
    assert.ok(r.val, JSON.stringify(r.errs)); assert.equal(r.val.execMode, 'paper'); assert.equal(r.val.buyType, 'market');
  }
  assert.equal(ST.BUILTIN.find(x => x.id === IDS.flow).preset.flatOn, true);
  assert.equal(ST.BUILTIN.find(x => x.id === IDS.flow).preset.selectAt, '09:10');
});

test('순수 계산: 이동평균 · 하락 국면 · 외국인 신호 · 사이드카 신호 · 꼬리표', () => {
  const prev = Array.from({ length: 59 }, () => 10000);
  assert.ok(Math.abs(INV.ma(prev, 9000) - (59 * 10000 + 9000) / 60) < 1e-9);
  assert.equal(INV.ma(prev.slice(1), 9000), null, '일수 모자람');
  assert.equal(INV.regime(prev, 9000).on, true); assert.equal(INV.regime(prev, 10500).on, false);
  assert.equal(INV.flowSignal(-1, -1).on, true); assert.equal(INV.flowSignal(1, -1).on, false); assert.equal(INV.flowSignal(null, -1).ok, false);
  assert.deepEqual(INV.sidecarSignal({ sellToday: true, chgPct: 0 }), { on: true, via: 'event' });
  assert.deepEqual(INV.sidecarSignal({ sellToday: false, chgPct: -4.2, dropPct: 4 }), { on: true, via: 'drop' });
  assert.equal(INV.sidecarSignal({ sellToday: false, chgPct: -3.9, dropPct: 4 }).on, false);
  assert.equal(INV.holdDaysC(true), 1); assert.equal(INV.holdDaysC(false), 2);
  assert.equal(INV.tagOf('sidecar', 1), 'C1'); assert.equal(INV.tagDays('C2'), 2); assert.equal(INV.tagDays('A'), 0);
  assert.equal(INV.stopDefault('sidecar', '122630'), 10); assert.equal(INV.stopDefault('sidecar', '069500'), 5);
});

test('A: 하락 국면이면 15:10 인버스 시장가 매수(꼬리표 A · 익절 없음 · 종가 마감 손절), 국면이 끝나면 15:15 정리', async () => {
  const r = await rig({ mode: 'regime' });
  try {
    r.at(0, 15, 10); r.quote(10000); await r.A.tick();
    const P = r.runs.r && r.runs.r.payload;
    assert.ok(P, '기록'); assert.deepEqual(P.picks.map(p => p.code), ['114800'], JSON.stringify(P.stat));
    const o = P.orders['114800'];
    assert.ok(o && o.plan && o.st !== 'skipped', JSON.stringify(o));
    assert.equal(o.plan.tag, 'A'); assert.equal(o.plan.closeStop, true); assert.deepEqual(o.plan.steps, []);
    assert.equal(o.plan.stop, 9300, '매수가 10,000 × 0.93');
    assert.ok(await r.held('114800'));
    // 다음날 15:15: 아직 60일선 아래면 계속 보유
    r.at(1, 15, 16); r.quote(10000); await r.A.tick();
    assert.ok(await r.held('114800'), '하락 국면 지속 → 보유');
  } finally { await r.c.close(); }
  const r2 = await rig({ mode: 'regime' });
  try {
    r2.at(0, 15, 10); r2.quote(10000); await r2.A.tick(); assert.ok(await r2.held('114800'));
    r2.setK(10600, 1); r2.at(1, 15, 16); r2.quote(10000); await r2.A.tick();
    assert.ok(!(await r2.held('114800')), '60일선 위로 올라오면 정리'); assert.ok(r2.sent.some(t => /정리/.test(t)));
  } finally { await r2.c.close(); }
  const r3 = await rig({ mode: 'regime', kPrice: 10600 });   // 하락 국면 아님
  try { r3.at(0, 15, 10); r3.quote(10000); await r3.A.tick(); assert.deepEqual(r3.runs.r.payload.picks, []); assert.match(JSON.stringify(r3.runs.r.payload), /하락 국면 아님/); } finally { await r3.c.close(); }
});

test('B: 어제 외국인 현물·선물 동반 순매도 → 09:10 인버스 2X 시장가 매수 → 15:15 당일 청산(손절 −4%)', async () => {
  const r = await rig({ mode: 'flow' });
  try {
    r.at(0, 9, 10); r.quote(10000); await r.A.tick();
    const P = r.runs.r && r.runs.r.payload;
    assert.deepEqual(P.picks.map(p => p.code), ['252670'], JSON.stringify(P.stat));
    const o = P.orders['252670'];
    assert.ok(o && o.plan && o.st !== 'skipped', JSON.stringify(o));
    assert.equal(o.plan.tag, 'B'); assert.ok(!o.plan.closeStop); assert.equal(o.plan.stop, 9600);
    assert.ok(await r.held('252670'));
    r.at(0, 15, 16); r.quote(10100); await r.A.tick();
    assert.ok(!(await r.held('252670')), '15:15 전량 청산');
  } finally { await r.c.close(); }
  for (const x of [{ flowSpot: 500 }, { flowFut: 100 }, { flowDate: '2020-01-01' }]) {   // 현물 순매수 · 선물 순매수 · 자료 지연
    const q = await rig({ mode: 'flow', ...x });
    try { q.at(0, 9, 10); q.quote(10000); await q.A.tick(); assert.deepEqual((q.runs.r && q.runs.r.payload.picks) || [], [], JSON.stringify(x)); } finally { await q.c.close(); }
  }
});

test('C: 매도 사이드카(또는 KODEX200 −4%↓) 날 15:10 매수 → 이틀째 15:15 정리, 하락 국면이면 다음날 정리', async () => {
  const r = await rig({ mode: 'sidecar', kPrice: 9500, kChg: -5, pExtra: { invMaDays: 20 } });   // 20일선 = (19×10000+9500)/20 = 9975 → 9,500 은 아래(하락 국면)
  try {
    r.at(0, 15, 10); r.quote(10000); await r.A.tick();
    const P = r.runs.r.payload, o = P.orders['122630'];
    assert.deepEqual(P.picks.map(p => p.code), ['122630'], JSON.stringify(P.stat));
    assert.equal(o.plan.tag, 'C1', '하락 국면 → 1일 보유'); assert.equal(o.plan.stop, 9000, '2X 손절 −10%');
    assert.ok(await r.held('122630'));
    r.at(1, 15, 14); r.quote(10000); await r.A.tick(); assert.ok(await r.held('122630'), '15:15 전엔 보유');
    r.at(1, 15, 16); r.quote(10000); await r.A.tick(); assert.ok(!(await r.held('122630')), '다음날 15:15 정리');
  } finally { await r.c.close(); }
  // 하락 국면이 아니면(KODEX200 이 20일선 위지만 당일 −4.5% 라고 가정 못 함 → 발동 기록으로 신호) 이틀째 정리
  const q = await rig({ mode: 'sidecar', kPrice: 10400, kChg: -0.5, events: [{ title: '코스피 매도 사이드카 발동' }], pExtra: { invMaDays: 20 } });
  try {
    q.at(0, 15, 10); q.quote(10000); await q.A.tick();
    const o = q.runs.r.payload.orders['122630'];
    assert.equal(o.plan.tag, 'C2');
    q.at(1, 15, 16); q.quote(10000); await q.A.tick(); assert.ok(await q.held('122630'), '첫날 지나도 보유');
    q.at(2, 15, 16); q.quote(10000); await q.A.tick(); assert.ok(!(await q.held('122630')), '이틀째 15:15 정리');
  } finally { await q.c.close(); }
  const n = await rig({ mode: 'sidecar', kPrice: 9900, kChg: -2, pExtra: { invMaDays: 20 } });
  try { n.at(0, 15, 10); n.quote(10000); await n.A.tick(); assert.deepEqual(n.runs.r.payload.picks, []); assert.match(JSON.stringify(n.runs.r.payload), /사이드카 신호 없음/); } finally { await n.c.close(); }
});
