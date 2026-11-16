'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy');
const { createAuto } = require('../auto');
const { fakeDb, boot } = require('./paper-harness');

/* 종가베팅 저녁 매수(19:05~): NXT 종목만 · 종가가 고가 5% 이내(2% 넘게 내리면 감점) · 손절 −5%만 걸고 익절 없음 · 20:00 이월 */
const MIN = 60e3;
async function rig({ approval = 'auto', cbMax = 3, cbOn = true } = {}) {
  const db = fakeDb(), c = await boot(db);
  for (const k of ['035420', '051910']) db.t.stocks.set(k, { code: k, nxt_ok: true, security_type: 'STOCK' });
  db.t.stocks.set('999999', { code: '999999', nxt_ok: false, security_type: 'STOCK' });
  const runs = {}, cfg = { main: { on: true, perStockKrw: 1000000 } }, sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const I = { ...ST.defaults('intraday') }, C = { ...ST.defaults('closing'), closeBuyApproval: approval, closeBuyMax: cbMax, closeBuyOn: cbOn };
  const strategies = { pair: async () => ({ I: { id: 'intraday-default', name: '기본', version: 1, enabled: true, params: I }, C: { id: 'closing-default', version: 1, enabled: true, params: C }, T: ST.timesOf(I, C) }), isMissing: () => false, list: async () => [] };
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: 1e9 }));
  const mk = (code, name, high, extra = {}) => ({ code, name, price: 10000, open: 9800, high, changePct: 2, vol: 1e6, amt: 5e10, ...extra });
  const pool = [mk('000660', 'SK하이닉스', 10200), mk('035420', 'NAVER', 10450), mk('051910', 'LG화학', 11200), mk('999999', '비엔엑스', 10100)];
  const scr = Object.fromEntries(pool.map(r => [r.code, { close: 10000, ma60: 9500, ma120: 9000, sector: r.code === '000660' ? '반도체' : r.code === '035420' ? 'IT' : '화학', rs20_pctl: 70 }]));
  const A = createAuto({
    strategies,
    sbGet: async p => {
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) { const d = (p.match(/eq\.([\d-]+)/) || [])[1]; return runs[d] ? [JSON.parse(JSON.stringify(runs[d]))] : []; }
      if (p.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2027-01-12' }];
      if (p.startsWith('v_screener')) return p.includes('offset=0') ? Object.entries(scr).map(([code, v]) => ({ code, ...v })) : [];
      if (p.startsWith('smx_state')) return p.includes('offset=0') ? pool.map(r => ({ code: r.code, st: 'CONT' })) : [];
      if (p.startsWith('stocks?')) { const codes = (p.match(/in\.\(([\d,]+)\)/) || [])[1].split(','); return codes.map(code => db.t.stocks.get(code)).filter(Boolean).map(x => ({ code: x.code, nxt_ok: x.nxt_ok })); }
      return [];
    },
    sbWrite: async (p, m, b) => { b.forEach(x => { if (p.startsWith('auto_runs')) runs[x.trade_date] = JSON.parse(JSON.stringify(x)); else cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); },
    sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); },
    paper: c.t.paper, getQuote: code => c.t.getQuote(code, true), loadChart: async () => rows,
    livePool: async () => pool, fetchFlow: async () => ({ fq: 1000, oq: 800 }), fetchPower: async () => ({ pgQty: 200, w52: 11000 }), fetchCttr: async () => ({ err: 'after hours' }), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const date = kst().date;
  const at = (hh, mm, dayOff = 0) => { c.st.clock = Date.parse(`${date}T00:00:00+09:00`) + dayOff * 864e5 + (hh * 60 + mm) * MIN; };
  const px = p => { c.st.price = p; c.st.high = Math.max(c.st.high, p); c.st.low = Math.min(c.st.low, p); c.st.bids = Array.from({ length: 10 }, (_, i) => [p - (i + 1) * 10, 1000]); c.st.asks = Array.from({ length: 10 }, (_, i) => [p + i * 10, 1000]); };
  return { db, c, A, runs, cfg, sent, date, at, px };
}

test('19:05 종가베팅: NXT 종목만 · 고가 5% 초과 낙폭 제외 · 2% 넘게 내린 종목은 감점 · 오전 기록이 없어도 진행', async () => {
  const { c, A, runs, sent, date, at, px } = await rig();
  at(19, 6); px(10000); await A.tick();
  const P = runs[date].payload;
  assert.equal(P.cb.done, true);
  const names = P.picks.map(p => p.name);
  assert.deepEqual(names.sort(), ['NAVER', 'SK하이닉스']);                                  // 비NXT(비엔엑스)·고가 −10.7%(LG화학) 제외
  const hy = P.picks.find(p => p.code === '000660'), nv = P.picks.find(p => p.code === '035420');
  assert.ok(hy.cb && nv.cb);
  assert.equal(hy.penalty, 0); assert.ok(nv.penalty > 20 && nv.penalty < 30, nv.penalty);   // −4.3% → (4.3−2)/3×30 ≈ 23
  assert.ok(hy.score > nv.score, `${hy.score} ${nv.score}`);
  assert.ok(P.rejected.some(r => r.code === '051910' && /고가 대비 -10\.\d%/.test(r.fails[0])));
  assert.ok(sent.some(t => /종가베팅 후보\(NXT 저녁 매수\)/.test(t) && /감점 −/.test(t)), sent.join('|'));
  await c.close();
});
test('자동 승인: NXT 지정가 매수 · 손절 −5% · 익절 없음 → 20:00 이월 등록', async () => {
  const { db, c, A, runs, cfg, sent, date, at, px } = await rig();
  at(19, 6); px(10000); await A.tick();
  assert.ok(sent.some(t => /🤖 자동 승인/.test(t)), sent.join('|'));
  const ords = runs[date].payload.orders;
  assert.equal(Object.keys(ords).length, 2);
  for (const o of Object.values(ords)) { assert.ok(['open', 'filled'].includes(o.st), o.st); assert.equal(o.plan.steps.length, 0); assert.equal(o.plan.stopPct, 5); }
  at(19, 7); px(9990); c.st.vol += 5000; await c.t.paper.tick(); await A.tick();
  at(19, 20); await A.tick();
  for (const code of ['000660', '035420']) assert.equal(db.t.paper_positions.get(code).qty, 100, code);
  assert.equal(db.t.paper_positions.get('000660').plan.steps.length, 0);
  at(20, 1); await A.tick();
  assert.deepEqual(Object.keys(cfg.carry.items).sort(), ['000660', '035420']);
  assert.ok(sent.some(t => /종가 베팅 전환/.test(t)));
  await c.close();
});
test('하루 최대 종목 수(1)면 점수 높은 종목만 · 꺼 두면 아무 것도 안 함', async () => {
  const a = await rig({ cbMax: 1 });
  a.at(19, 6); a.px(10000); await a.A.tick();
  assert.deepEqual(a.runs[a.date].payload.picks.map(p => p.name), ['SK하이닉스']);
  await a.c.close();
  const b = await rig({ cbOn: false });
  b.at(19, 6); b.px(10000); await b.A.tick();
  assert.equal(b.runs[b.date], undefined);
  await b.c.close();
});
test('직접 승인: 알림만 보내고 /매수 로 승인해야 주문 · 마감까지 답이 없으면 만료', async () => {
  const a = await rig({ approval: 'manual' });
  a.at(19, 6); a.px(10000); await a.A.tick();
  assert.equal(Object.keys(a.runs[a.date].payload.orders || {}).length, 0);
  assert.ok(a.sent.some(t => /\/매수 1 2/.test(t) && /19:45까지/.test(t)), a.sent.join('|'));
  a.at(19, 10); const r = await a.A.handleApproval('/매수 1');
  assert.match(r, /가상 매수/);
  assert.equal(Object.keys(a.runs[a.date].payload.orders).length, 1);
  await a.c.close();
  const b = await rig({ approval: 'manual' });
  b.at(19, 6); b.px(10000); await b.A.tick();
  b.at(19, 46); await b.A.tick();
  assert.equal(b.runs[b.date].status, 'expired');
  assert.ok(b.sent.some(t => /19:45 승인 마감/.test(t)), b.sent.join('|'));
  await b.c.close();
});
test('오전 장중 후보·주문이 있던 날: 저녁 후보는 새 종목만, 오전 후보는 닫고, 종목 수는 따로 셈', async () => {
  const { c, A, runs, date, at, px } = await rig();
  runs[date] = { trade_date: date, strategy_id: 'intraday-default', status: 'approved', payload: { picks: [{ code: '000660', name: 'SK하이닉스', price: 10000, score: 80, round: 1 }], noticeSent: true, approved: ['000660'], decision: { kind: 'buy', nums: [1] }, orders: { '000660': { st: 'filled', filled: 10, avg: 10000 } }, roundN: 3, log: [] } };
  at(19, 6); px(10000); await A.tick();
  const P = runs[date].payload;
  assert.equal(P.picks[0].closed, true);                                                    // 오전 후보 닫힘
  assert.deepEqual(P.picks.filter(p => p.cb).map(p => p.code), ['035420']);                  // 이미 산 SK하이닉스는 제외
  assert.equal(P.picks.find(p => p.cb).round, 4);
  await c.close();
});
