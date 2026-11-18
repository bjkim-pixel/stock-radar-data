'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy');
const { createAuto } = require('../auto');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

/* 종가베팅 저녁 매수(18:00 관찰 → 19:30 최종 선정): NXT 종목만 · 종가가 고가 5% 이내(2% 넘게 내리면 감점) · 손절 −5%만 걸고 익절 없음 · 20:00 이월 */
const MIN = 60e3;
async function rig({ approval = 'auto', cbMax = 3, cbOn = true, watchMin, live = false, perStock = 1000000 } = {}) {
  const kx = live ? fakeKis() : null;
  const db = fakeDb(), c = await boot(db, live ? { envExtra: { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' }, kx } : {});
  for (const k of ['035420', '051910']) db.t.stocks.set(k, { code: k, nxt_ok: true, security_type: 'STOCK' });
  db.t.stocks.set('999999', { code: '999999', nxt_ok: false, security_type: 'STOCK' });
  const runs = {}, cfg = { main: { on: true, perStockKrw: perStock } }, sent = [];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const I = { ...ST.defaults('intraday'), ...(perStock !== 1000000 ? { perStockKrw: perStock } : {}) }, C = { ...ST.defaults('closing'), closeBuyApproval: approval, closeBuyMax: cbMax, closeBuyOn: cbOn, ...(watchMin != null ? { closeBuyWatchMin: watchMin } : {}) };
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
    paper: c.t.paper, ...(live ? { live: c.t.live, modeOf: () => 'live', kindsInUse: () => ['live'] } : {}), getQuote: code => c.t.getQuote(code, true), loadChart: async () => rows,
    livePool: async () => pool, fetchFlow: async () => ({ fq: 1000, oq: 800 }), fetchPower: async () => ({ pgQty: 200, w52: 11000 }), fetchCttr: async () => ({ err: 'after hours' }), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const date = kst().date;
  const at = (hh, mm, dayOff = 0) => { c.st.clock = Date.parse(`${date}T00:00:00+09:00`) + dayOff * 864e5 + (hh * 60 + mm) * MIN; };
  const px = p => { c.st.price = p; c.st.high = Math.max(c.st.high, p); c.st.low = Math.min(c.st.low, p); c.st.bids = Array.from({ length: 10 }, (_, i) => [p - (i + 1) * 10, 1000]); c.st.asks = Array.from({ length: 10 }, (_, i) => [p + i * 10, 1000]); };
  return { db, c, A, runs, cfg, sent, date, at, px, kx };
}

test('19:30 종가베팅(관찰 없이 바로 최종 선정): NXT 종목만 · 고가 5% 초과 낙폭 제외 · 2% 넘게 내린 종목은 감점 · 오전 기록이 없어도 진행', async () => {
  const { c, A, runs, sent, date, at, px } = await rig();
  at(19, 31); px(10000); await A.tick();
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
  at(19, 31); px(10000); await A.tick();
  assert.ok(sent.some(t => /🤖 자동 승인/.test(t)), sent.join('|'));
  const ords = runs[date].payload.orders;
  assert.equal(Object.keys(ords).length, 2);
  for (const o of Object.values(ords)) { assert.ok(['open', 'filled'].includes(o.st), o.st); assert.equal(o.plan.steps.length, 0); assert.equal(o.plan.stopPct, 5); }
  at(19, 32); px(9990); c.st.vol += 5000; await c.t.paper.tick(); await A.tick();
  at(19, 40); await A.tick();
  for (const code of ['000660', '035420']) assert.equal(db.t.paper_positions.get(code).qty, 100, code);
  assert.equal(db.t.paper_positions.get('000660').plan.steps.length, 0);
  at(20, 1); await A.tick();
  assert.deepEqual(Object.keys(cfg.carry.items).sort(), ['000660', '035420']);
  assert.ok(sent.some(t => /종가 베팅 전환/.test(t)));
  await c.close();
});
test('하루 최대 종목 수(1)면 점수 높은 종목만 · 꺼 두면 아무 것도 안 함', async () => {
  const a = await rig({ cbMax: 1 });
  a.at(19, 31); a.px(10000); await a.A.tick();
  assert.deepEqual(a.runs[a.date].payload.picks.map(p => p.name), ['SK하이닉스']);
  await a.c.close();
  const b = await rig({ cbOn: false });
  b.at(19, 31); b.px(10000); await b.A.tick();
  assert.equal(b.runs[b.date], undefined);
  await b.c.close();
});
test('직접 승인: 알림만 보내고 /매수 로 승인해야 주문 · 마감까지 답이 없으면 만료', async () => {
  const a = await rig({ approval: 'manual' });
  a.at(19, 31); a.px(10000); await a.A.tick();
  assert.equal(Object.keys(a.runs[a.date].payload.orders || {}).length, 0);
  assert.ok(a.sent.some(t => /\/매수 1 2/.test(t) && /19:50까지/.test(t)), a.sent.join('|'));
  a.at(19, 35); const r = await a.A.handleApproval('/매수 1');
  assert.match(r, /가상 매수/);
  assert.equal(Object.keys(a.runs[a.date].payload.orders).length, 1);
  await a.c.close();
  const b = await rig({ approval: 'manual' });
  b.at(19, 31); b.px(10000); await b.A.tick();
  b.at(19, 51); await b.A.tick();
  assert.equal(b.runs[b.date].status, 'expired');
  assert.ok(b.sent.some(t => /19:50 승인 마감/.test(t)), b.sent.join('|'));
  await b.c.close();
});
test('오전 장중 후보·주문이 있던 날: 저녁 후보는 새 종목만, 오전 후보는 닫고, 종목 수는 따로 셈', async () => {
  const { c, A, runs, date, at, px } = await rig();
  runs[date] = { trade_date: date, strategy_id: 'intraday-default', status: 'approved', payload: { picks: [{ code: '000660', name: 'SK하이닉스', price: 10000, score: 80, round: 1 }], noticeSent: true, approved: ['000660'], decision: { kind: 'buy', nums: [1] }, orders: { '000660': { st: 'filled', filled: 10, avg: 10000 } }, roundN: 3, log: [] } };
  at(19, 31); px(10000); await A.tick();
  const P = runs[date].payload;
  assert.equal(P.picks[0].closed, true);                                                    // 오전 후보 닫힘
  assert.deepEqual(P.picks.filter(p => p.cb).map(p => p.code), ['035420']);                  // 이미 산 SK하이닉스는 제외
  assert.equal(P.picks.find(p => p.cb).round, 4);
  await c.close();
});

test('18:00부터 30분마다 관찰만(알림·매수 없음) → 19:30 최종 선정에 통과 이력 가점', async () => {
  const { c, A, runs, sent, date, at, px } = await rig();
  at(17, 59); px(10000); await A.tick();
  assert.equal(runs[date], undefined);                                   // 관찰 전
  at(18, 1); await A.tick();
  let P = runs[date].payload;
  assert.equal(P.cbw.length, 1); assert.equal(P.cbw[0].k, 1); assert.ok(!P.cbw[0].busy);
  assert.deepEqual(P.cbw[0].passed.map(x => x.code).sort(), ['000660', '035420']);   // 비NXT·낙폭 큰 종목은 통과 못 함
  assert.equal(P.picks.length, 0); assert.equal(Object.keys(P.orders || {}).length, 0); assert.equal(sent.length, 0);
  await A.tick();                                                         // 같은 회차는 다시 돌지 않음
  assert.equal(runs[date].payload.cbw.length, 1);
  at(18, 31); await A.tick(); at(19, 1); await A.tick();
  P = runs[date].payload; assert.deepEqual(P.cbw.map(e => e.k), [1, 2, 3]);
  assert.equal(P.picks.length, 0); assert.equal(sent.length, 0);
  at(19, 29); await A.tick(); assert.equal(runs[date].payload.picks.length, 0);       // 최종 선정 전
  at(19, 31); await A.tick();
  P = runs[date].payload;
  assert.equal(P.cb.done, true);
  const hy = P.picks.find(p => p.code === '000660');
  assert.deepEqual(hy.hist, { k: 3, n: 3 }); assert.equal(hy.bonus, 10);
  assert.ok(hy.reasons.some(r => /관찰 3회 중 3회 통과 \(가점 \+10\)/.test(r)));
  assert.ok(sent.some(t => /종가베팅 후보/.test(t)));
  await c.close();
});
test('관찰 이력이 적을수록 가점도 비례해 줄어든다 · 놓친 회차는 가장 최근 하나만 따라잡음', async () => {
  const { c, A, runs, date, at, px } = await rig();
  at(19, 1); px(10000); await A.tick();                                   // 18:00·18:30 놓치고 19:00 회차만
  assert.deepEqual(runs[date].payload.cbw.map(e => e.k), [3]);
  at(19, 31); await A.tick();
  const hy = runs[date].payload.picks.find(p => p.code === '000660');
  assert.deepEqual(hy.hist, { k: 1, n: 1 }); assert.equal(hy.bonus, 10);
  await c.close();
});
test('관찰 간격 0이면 관찰 없이 19:30에 바로 선정', async () => {
  const { c, A, runs, date, at, px } = await rig({ watchMin: 0 });
  at(18, 31); px(10000); await A.tick();
  assert.equal(runs[date], undefined);
  at(19, 31); await A.tick();
  assert.equal(runs[date].payload.cbw, undefined); assert.equal(runs[date].payload.cb.done, true);
  await c.close();
});

/* 실거래 전환 1단계: 전략의 실행 모드가 실전이면 같은 자동매매 흐름이 실전 엔진(가짜 KIS)으로 주문한다. 실행 모드 설정은 2단계 — 여기선 modeOf 를 직접 줌 */
test('[실전 연결] 자동 승인 종가베팅 매수가 실전 엔진으로 — KIS 주문·출처 기록·가상 주문 없음·알림에 실전 표시', async () => {
  const { db, c, A, runs, sent, date, at, px, kx } = await rig({ live: true, perStock: 400000 });
  at(19, 31); px(10000); await A.tick();
  const ords = runs[date].payload.orders;
  assert.equal(Object.keys(ords).length, 2, JSON.stringify(ords));
  for (const o of Object.values(ords)) assert.ok(['open', 'filled'].includes(o.st), JSON.stringify(o));
  const buys = kx.posts.filter(p => p.tr === 'TTTC0012U');
  assert.equal(buys.length, 2, '실전 매수 2건이 KIS 로');
  assert.ok(buys.every(b => b.body.ORD_DVSN === '00'), 'NXT 저녁은 지정가');
  assert.equal(db.t.paper_orders.size, 0, '가상 주문은 없음');
  const lo = [...db.t.live_orders.values()];
  assert.ok(lo.length === 2 && lo.every(o => o.origin === 'auto:intraday-default'), JSON.stringify(lo.map(o => o.origin)));
  assert.ok(sent.some(t => /실전 매수/.test(t)), sent.join('|'));
  await c.close();
});
test('[실전 연결] 실전 1회 한도(50만 원)를 넘는 금액이면 실전 엔진이 거부 — 자동매매는 실패로 기록하고 KIS 를 부르지 않음', async () => {
  const { c, A, runs, date, at, px, kx } = await rig({ live: true, perStock: 1000000 });
  at(19, 31); px(10000); await A.tick();
  const ords = Object.values(runs[date].payload.orders);
  assert.ok(ords.length && ords.every(o => o.st === 'failed'), JSON.stringify(ords));
  assert.equal(kx.posts.filter(p => p.tr === 'TTTC0012U').length, 0);
  await c.close();
});
