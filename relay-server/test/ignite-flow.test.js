'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy'), IG = require('../ignite');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

const MIN = 60e3;
async function rig(iExtra = {}) {
  const db = fakeDb(), c = await boot(db, {});
  const runs = {}, cfg = { main: { on: true, liveOn: true, perStockKrw: 1000000 } }, sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const I0 = { ...ST.defaults('intraday'), ...ST.BUILTIN.find(b => b.id === 'ignite-default').preset, ...iExtra };
  const I = { id: 'ignite-default', name: '시동', version: 1, enabled: true, params: ST.validate('intraday', I0).val, letter: 'A' };
  const C = { id: 'closing-default', version: 1, enabled: false, params: ST.defaults('closing') };
  I.T = ST.timesOf(I.params, C.params);
  const strategies = { pair: async () => ({ I, C, T: I.T }), actives: async () => ({ Is: [I], C }), list: async () => [I, C], byId: async id => (id === I.id ? I : null), isMissing: () => false };
  // 09:00~09:15 이력: 09:05까지 잔잔(분당 1억) → 이후 오르며 분당 4억
  const tr = IG.createTracker();
  for (let m = 540; m <= 555; m++) {
    const price = m <= 550 ? 9800 + (m - 540) * 6 : 9860 + (m - 550) * 28, amt = m <= 550 ? (m - 539) * 1e8 : 11e8 + (m - 550) * 4e8;
    tr.ingest([{ code: '035420', price, open: 9800, high: price, vol: amt / 9900, amt }], m * 60000, m);
  }
  const row = { code: '035420', name: 'NAVER', price: 10000, open: 9800, high: 10000, changePct: 3, vol: 3e6, amt: 11e8 + 5 * 4e8 };
  const A = createAuto({
    strategies,
    sbGet: async p => {
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) return runs.r ? [JSON.parse(JSON.stringify(runs.r))] : [];
      if (p.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2027-01-12' }];
      if (p.startsWith('v_screener')) return p.includes('offset=0') ? [{ code: '035420', close: 10000, ma60: 9500, ma120: 9000, sector: 'IT', rs20_pctl: 70 }] : [];
      return [];
    },
    sbWrite: async (p, m, b) => { b.forEach(x => { if (p.startsWith('auto_runs')) runs.r = JSON.parse(JSON.stringify(x)); else if (x && x.key) cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); },
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: 1e9 })),
    ignitePool: async () => ({ rows: [row], get: code => tr.get(code), size: 1, scanAt: new Date().toISOString() }),
    livePool: async () => [], fetchFlow: async () => ({ err: 'x' }), fetchPower: async () => ({ pgQty: 100 }), fetchCttr: async () => ({ cttr: 140 }), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const date = kst().date;
  const at = (hh, mm) => { c.st.clock = Date.parse(`${date}T00:00:00+09:00`) + (hh * 60 + mm) * MIN; };
  return { c, A, runs, sent, date, at };
}

test('09:15 포착 → 자동 가상 매수(종목당 100만원) → 15:14 남은 보유분 전량 시장가 청산', async () => {
  const { c, A, runs, sent, date, at } = await rig({ cttrMin: 100 });
  try {
  at(9, 15); c.st.price = 10000;
  await A.tick();
  const P = runs.r && runs.r.payload;
  assert.ok(P, '오늘 기록이 만들어져야 함');
  assert.deepEqual(P.picks.map(p => p.code), ['035420'], JSON.stringify(P.stat || P));
  assert.ok(P.picks[0].reasons.some(r => /거래대금/.test(r)));
  assert.equal(P.strategy && P.strategy.id || 'ignite-default', 'ignite-default');
  const o = P.orders && P.orders['035420'];
  assert.ok(o, '자동 승인으로 주문이 나가야 함: ' + JSON.stringify(P.decision));
  for (let m = 16; m <= 40; m++) { at(9, m); c.st.price = 10000; await A.tick(); }
  const S1 = await c.t.paper.state(); if (process.env.DBG) console.log('DBG', JSON.stringify(runs.r.payload.orders), JSON.stringify(S1.orders.map(o => [o.code, o.side, o.type, o.price, o.qty, o.status, o.note])), JSON.stringify(runs.r.payload.log || '').slice(0, 800));
  const b1 = S1.orders.find(x => x.code === '035420' && x.side === 'buy');
  assert.ok(b1 && b1.type === 'market', '시동 매수는 시장가: ' + JSON.stringify(b1));
  const pos1 = S1.positions.find(p => p.code === '035420');
  assert.ok(pos1 && pos1.qty > 0, '가상 보유가 있어야 함');
  assert.ok(pos1.qty * pos1.avg <= 1000000 + 10000, `종목당 100만원 이내: ${pos1.qty * pos1.avg}`);
  at(15, 13); await A.tick();
  assert.ok((await c.t.paper.state()).positions.some(p => p.code === '035420' && p.qty > 0), '15:13엔 아직 보유');
  at(15, 14); const tk = await A.tick(); if (process.env.DBG) console.log('TICK', JSON.stringify(tk).slice(0, 600));
  const S2 = await c.t.paper.state();
  assert.ok(!S2.positions.some(p => p.code === '035420' && p.qty > 0), '15:14 이후 전량 청산: ' + JSON.stringify(S2.positions));
  assert.ok(sent.some(t => /당일 청산/.test(t)));
  } finally { await c.close(); }
});
