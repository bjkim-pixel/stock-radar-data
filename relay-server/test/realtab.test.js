'use strict';
/* 실전매매 자동매매(2026-11-19): 가상매매 전략과 그 "실전에 적용" 복제(드라이런·실전)가 같은 종목을 각자 사고,
   켜기/끄기·이월·일지·화면·원본 연결이 쪽(가상/실전)별로 나뉘는지 — 실제 엔진(paper.js 두 장부·live.js)과 붙여서 확인 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../auto-strategy');
const EXC = require('../auto-excursion');
const JRN = require('../auto-journal');
const { createAuto } = require('../auto');
const { createBroker } = require('../broker');
const { evalHealth } = require('../engine-guard');
const { fakeDb, boot, fakeKis } = require('./paper-harness');

const MIN = 60e3;
const D0 = ST.defaults('intraday');

async function rig({ realOn = true, pParams = {}, rParams = {}, missingDry = false, withRunEngine = true, live = false, siteSwitch = true } = {}) {
  const db = fakeDb();
  if (missingDry) db.setFail({ missing: 'dry_' });
  const kx = live ? fakeKis() : null;
  const c = await boot(db, live ? { envExtra: { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' }, kx, realOn: siteSwitch } : {});
  const runs = {}, cfg = { main: { on: true, liveOn: realOn, perStockKrw: 1000000 } }, sent = [], journal = {}, versions = [];
  const strat = [
    { id: 'intraday-default', name: '기본', kind: 'intraday', builtin: true, enabled: false, archived: false, version: 1, params: D0 },
    { id: 'intraday-p', name: '가상 원본', kind: 'intraday', builtin: false, enabled: true, archived: false, version: 1, params: { ...D0, approval: 'auto', ...pParams } },
    { id: 'intraday-r', name: '가상 원본 (실전)', kind: 'intraday', builtin: false, enabled: true, archived: false, version: 1, params: { ...D0, approval: 'auto', execMode: 'dryrun', ...rParams }, source: 'intraday-p' },
    { id: 'closing-default', name: '종가', kind: 'closing', builtin: true, enabled: true, archived: false, version: 1, params: ST.defaults('closing') },
  ];
  const kst = () => { const d = new Date(c.st.clock + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 9000 + i * 30, high: 9100 + i * 30, low: 8900 + i * 30, trade_amount: 5e10, individual_net: (i % 3 - 1) * 1e9 }));
  rows.push({ close: 10000, high: 10100, low: 9900, trade_amount: 5e10, individual_net: 1e9 });
  const q = p => new URLSearchParams(p.split('?')[1] || '');
  const sbGet = async p => {
    if (p.startsWith('auto_strategies')) return JSON.parse(JSON.stringify(strat));
    if (p.startsWith('auto_strategy_versions')) return versions.slice().reverse();
    if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(cfg[k])) }] : []; }
    if (p.startsWith('auto_runs')) {
      const d = (p.match(/trade_date=eq\.([\d-]+)/) || [])[1], s = (p.match(/strategy_id=eq\.([\w-]+)/) || [])[1];
      return Object.values(runs).filter(r => (!d || r.trade_date === d) && (!s || r.strategy_id === s)).map(r => JSON.parse(JSON.stringify(r)));
    }
    if (p.startsWith('auto_journal')) {
      const d = (p.match(/trade_date=eq\.([\d-]+)/) || [])[1], s = (p.match(/strategy_id=eq\.([\w-]+)/) || [])[1];
      return Object.values(journal).filter(r => (!d || r.trade_date === d) && (!s || r.strategy_id === s)).map(r => ({ ...JSON.parse(JSON.stringify(r)), engine: r.payload && r.payload.engine, pos: r.payload && r.payload.positions }));
    }
    if (/^(paper_|dry_|live_|stocks|trade_audit)/.test(p)) {
      const tbl = p.split('?')[0], P = q(p);
      let r = await db.sbGet(p);
      const idIn = P.get('id'); if (idIn && idIn.startsWith('in.(')) { const set = idIn.slice(4, -1).split(','); r = r.filter(x => set.includes(x.id)); }
      const sd = P.get('side'); if (sd) r = r.filter(x => x.side === sd.replace('eq.', ''));
      const all = new URLSearchParams(p.split('?')[1] || '').getAll('ts'); for (const t of all) { if (t.startsWith('lt.')) r = r.filter(x => Date.parse(x.ts) < Date.parse(t.slice(3))); }
      return tbl.endsWith('_fills') ? r.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)) : r;
    }
    return [];
  };
  const sbWrite = async (p, m, b) => {
    if (p.startsWith('auto_runs')) { b.forEach(x => { runs[`${x.trade_date}|${x.strategy_id}`] = JSON.parse(JSON.stringify(x)); }); return; }
    if (p.startsWith('auto_config')) { b.forEach(x => { cfg[x.key] = JSON.parse(JSON.stringify(x.value)); }); return; }
    if (p.startsWith('auto_strategies')) { b.forEach(x => { const i = strat.findIndex(r => r.id === x.id); if (i >= 0) strat[i] = { ...strat[i], ...x }; else strat.push(x); }); return; }
    if (p.startsWith('auto_strategy_versions')) { versions.push(...b); return; }
    if (p.startsWith('auto_journal')) { if (m === 'POST') b.forEach(x => { journal[`${x.trade_date}|${x.strategy_id}`] = JSON.parse(JSON.stringify(x)); }); return; }
    if (/^(paper_|dry_|live_|trade_audit)/.test(p)) return db.sbWrite(p, m, b);
  };
  const A = createAuto({
    sbGet, sbWrite, sendTelegram: async t => sent.push(t), kstNow: kst, isTradingDay: () => true, now: () => c.st.clock,
    prevTradingDay: d => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); },
    paper: c.t.paper, dry: c.t.dry, ...(live ? { live: c.t.live, liveReady: () => ({ ok: true }), realOrdersOn: () => c.t.realOrdersOn() } : {}), liveLimits: () => c.t.cfg.limits.REAL, getQuote: code => c.t.getQuote(code, true), loadChart: async () => rows,
    livePool: async () => [], fetchFlow: async () => ({}), fetchPower: async () => ({}), fetchCttr: async () => ({}), marketState: async () => null, marketIdx: async () => ({ 코스피: 0.2, 코스닥: 0.1 }),
  });
  const { date } = kst();
  const seed = (sid, letter, engine) => { runs[`${date}|${sid}`] = { trade_date: date, strategy_id: sid, status: 'noticed', payload: { ...(withRunEngine ? { engine } : {}), strategy: { id: sid, version: 1, name: sid }, letter, picks: [{ code: '005930', name: '삼성전자', price: 10000, score: 80 }], noticeSent: true, approved: [], decision: null } }; };
  const at = (hh, mm, dayOff = 0) => { c.st.clock = Date.parse(`${date}T00:00:00+09:00`) + dayOff * 864e5 + (hh * 60 + mm) * MIN; };
  const run = sid => runs[`${date}|${sid}`];
  const fillAll = async () => { c.st.clock += 5000; c.st.vol += 5000; await c.t.paper.tick(); await c.t.dry.tick(); };
  return { db, c, A, runs, run, cfg, sent, journal, strat, date, seed, at, fillAll, kx };
}
/* 가상 원본(A)·드라이런 복제(B)가 같은 후보를 승인받아 각자 산 상태 */
async function bothBought(k) {
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'dry');
  k.at(10, 16);
  await k.A.handleApproval('/매수 A1'); await k.A.handleApproval('/매수 B1');
  await k.fillAll(); await k.A.tick();
}

test('같은 전략의 가상 원본과 드라이런 복제가 같은 종목을 각자 산다 — 가상 장부·드라이런 장부에 따로, 드라이런은 실전 한도(1회 50만)로 줄여서', async () => {
  const k = await rig();
  await bothBought(k);
  const po = [...k.db.t.paper_orders.values()].filter(o => o.side === 'buy'), dz = [...k.db.t.dry_orders.values()].filter(o => o.side === 'buy');
  assert.equal(po.length, 1); assert.equal(dz.length, 1);
  assert.equal(po[0].code, '005930'); assert.equal(dz[0].code, '005930');
  assert.equal(po[0].origin, 'auto:intraday-p'); assert.equal(dz[0].origin, 'auto:intraday-r');
  assert.match(dz[0].id, /^dr/, '드라이런 주문 번호는 가상과 구분');
  assert.equal(k.db.t.paper_positions.get('005930').qty, 100);
  assert.ok(k.db.t.dry_positions.get('005930').qty * 10000 <= 500000, '드라이런은 실전 1회 상한 안에서');
  assert.equal(k.run('intraday-p').payload.orders['005930'].st, 'filled');
  assert.equal(k.run('intraday-r').payload.orders['005930'].st, 'filled');
  assert.equal(k.run('intraday-r').payload.orders['005930'].mode, 'dryrun');
  await k.c.close();
});

test('실전매매 스위치가 꺼져 있으면: 실전매매 전략은 승인돼도 사지 않고 선정도 건너뜀 · 가상매매는 그대로', async () => {
  const k = await rig({ realOn: false });
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'dry');
  k.at(10, 16);
  assert.match(await k.A.handleApproval('/매수 B1'), /실전매매 자동매매가 꺼져/);
  assert.equal(k.db.t.dry_orders.size, 0);
  await k.A.handleApproval('/매수 A1');
  assert.equal(k.db.t.paper_orders.size, 1);
  /* 선정 시각: 켜진 쪽 전략만 오늘 기록을 만든다 */
  const k2 = await rig({ realOn: false });
  k2.at(10, 6); await k2.A.tick();
  assert.ok(k2.run('intraday-p'), '가상 전략은 선정');
  assert.equal(k2.run('intraday-r'), undefined, '실전매매 전략은 스위치가 꺼져 선정하지 않음');
  k2.cfg.main.liveOn = true; k2.at(10, 7); await k2.A.tick();
  assert.ok(k2.run('intraday-r'), '켜면 다음 주기에 선정');
  assert.equal(k2.run('intraday-r').payload.engine, 'dry'); assert.equal(k2.run('intraday-p').payload.engine, 'paper');
  await k.c.close(); await k2.c.close();
});

test('실전매매 켜기는 PIN 필요(setConfig) · 끄기는 PIN 없이', async () => {
  const k = await rig({ realOn: false });
  const r = await k.A.setConfig({ liveOn: true });
  assert.equal(r.ok, false); assert.equal(r.needPin, true); assert.equal(k.cfg.main.liveOn, false);
  const r2 = await k.A.setConfig({ liveOn: true }, { pinOk: true });
  assert.equal(r2.ok, true); assert.equal(r2.cfg.liveOn, true); assert.equal(k.cfg.main.on, true, '가상 스위치는 그대로');
  const r3 = await k.A.setConfig({ liveOn: false });
  assert.equal(r3.ok, true); assert.equal(k.cfg.main.liveOn, false);
  await k.c.close();
});

test('이월: 같은 종목을 가상·드라이런이 각자 넘기면 이월 기록이 둘(종목 · 종목@dry) — 다음 날 아침 각자 장부에서 판다', async () => {
  const k = await rig();
  await bothBought(k);
  k.at(20, 1); await k.A.tick();
  const items = k.cfg.carry && k.cfg.carry.items;
  assert.ok(items, '이월 기록');
  assert.deepEqual(Object.keys(items).sort(), ['005930', '005930@dry']);
  assert.equal(items['005930'].kind, 'paper'); assert.equal(items['005930@dry'].kind, 'dry');
  assert.equal(items['005930'].q0, 100); assert.equal(items['005930@dry'].q0, k.db.t.dry_positions.get('005930').qty);
  /* 다음 날 09:05 첫 분할 매도: 각자 장부에서 */
  k.at(9, 5, 1); k.c.st.price = 10100; k.c.st.bids = Array.from({ length: 10 }, (_, i) => [10100 - i * 10, 100000]); k.c.st.asks = Array.from({ length: 10 }, (_, i) => [10110 + i * 10, 100000]);
  await k.A.tick();
  const ps = [...k.db.t.paper_orders.values()].filter(o => o.side === 'sell'), ds = [...k.db.t.dry_orders.values()].filter(o => o.side === 'sell');
  assert.ok(ps.length >= 1, '가상 장부 아침 매도'); assert.ok(ds.length >= 1, '드라이런 장부 아침 매도');
  const it2 = k.cfg.carry.items;
  assert.ok(it2['005930'].sold > 0 && it2['005930@dry'].sold > 0, JSON.stringify(it2));
  assert.ok(k.db.t.paper_positions.get('005930').qty < 100, '가상은 가상 수량에서만 줄어듦');
  await k.c.close();
});

test('화면(uiState): 가상매매는 가상 장부·가상 전략만, 실전매매는 드라이런·실전만', async () => {
  const k = await rig();
  await bothBought(k);
  const P = await k.A.uiState(null, 'paper'), R = await k.A.uiState(null, 'real');
  assert.equal(P.side, 'paper'); assert.equal(R.side, 'real');
  assert.deepEqual(P.todays.map(t => t.sid), ['intraday-p']); assert.deepEqual(R.todays.map(t => t.sid), ['intraday-r']);
  assert.deepEqual(P.positions.map(p => [p.code, p.kind, p.qty]), [['005930', 'paper', 100]]);
  assert.deepEqual(R.positions.map(p => [p.code, p.kind]), [['005930', 'dry']]);
  assert.ok(R.positions[0].qty < 100);
  assert.ok(P.trades.every(f => f.kind === 'paper')); assert.ok(R.trades.every(f => f.kind === 'dry'));
  assert.deepEqual(P.active, ['intraday-p']); assert.deepEqual(R.active, ['intraday-r']);
  assert.equal(R.modes['intraday-r'], 'dryrun');
  assert.equal(R.cfg.liveOn, true);
  await k.c.close();
});

test('일지: 같은 종목이라도 각자 장부 체결로만 계산(가상 100주 · 드라이런 자기 수량) — 행에 장부 표시', async () => {
  const k = await rig();
  await bothBought(k);
  await k.A.journal.generateDay(k.date, { today: k.date, min: 1000, phase: 1, announce: false });
  const jp = k.journal[`${k.date}|intraday-p`], jr = k.journal[`${k.date}|intraday-r`];
  assert.ok(jp && jr);
  assert.equal(jp.payload.engine, 'paper'); assert.equal(jr.payload.engine, 'dry');
  assert.equal(jp.payload.positions[0].qty, 100);
  assert.equal(jr.payload.positions[0].qty, k.db.t.dry_positions.get('005930').qty);
  /* 목록: 쪽·장부로 거름 */
  const lp = await k.A.journalList({ side: 'paper' }), lr = await k.A.journalList({ side: 'real' }), ld = await k.A.journalList({ engine: 'dry' }), ll = await k.A.journalList({ engine: 'live' });
  assert.deepEqual(lp.rows.map(r => r.sid), ['intraday-p']); assert.deepEqual(lr.rows.map(r => r.sid), ['intraday-r']);
  assert.deepEqual(ld.rows.map(r => r.engine), ['dry']); assert.equal(ll.rows.length, 0);
  /* 비교: 드라이런 ↔ 가상 원본 */
  const cmp = await k.A.journalCompare({ sid: 'intraday-r', src: 'intraday-p' });
  assert.equal(cmp.ok, true); assert.equal(cmp.totals.days, 1); assert.equal(cmp.totals.both, 1);
  assert.equal(cmp.days[0].codes[0].code, '005930'); assert.equal(cmp.days[0].codes[0].slip, 0);
  await k.c.close();
});

test('이월 종가베팅 일지도 장부별 행(closing-default · closingdry-default)', async () => {
  const k = await rig();
  await bothBought(k);
  k.at(20, 1); await k.A.tick();
  await k.A.journal.generateDay(k.date, { today: k.date, min: 1205, phase: 2, announce: false });
  assert.ok(k.journal[`${k.date}|closing-default`], '가상 종가베팅 행');
  assert.ok(k.journal[`${k.date}|closingdry-default`], '드라이런 종가베팅 행');
  assert.equal(k.journal[`${k.date}|closingdry-default`].payload.engine, 'dry');
  assert.equal(k.journal[`${k.date}|closing-default`].payload.positions[0].qty, 100);
  await k.c.close();
});

test('예전 기록(장부 표시 없음): 주문 mode 로 추정 — 실전 주문이 없으면 가상', async () => {
  const k = await rig({ withRunEngine: false });
  k.seed('intraday-p', 'A'); k.at(10, 16);
  await k.A.handleApproval('/매수 A1');
  const P = await k.A.uiState(null, 'paper');
  assert.deepEqual(P.todays.map(t => t.sid), ['intraday-p']);
  assert.equal(P.todays[0].engine, 'paper');
  await k.c.close();
});

test('원본 연결: "실전에 적용"으로 만들면 원본을 기억 · 원본 조건이 바뀌면 차이 수 · 반영하면 매수·매도 조건만 가져오고 금액·실행 모드는 유지', async () => {
  const k = await rig();
  const r = await k.A.createStrategy({ from: 'intraday-p', asLive: true }, 'site');
  assert.equal(r.ok, true);
  const id = r.strategy.id, row = k.strat.find(s => s.id === id);
  assert.equal(row.source, 'intraday-p'); assert.equal(row.enabled, false); assert.equal(r.strategy.params.execMode, 'dryrun'); assert.match(row.name, /\(실전\)/);
  assert.equal((await k.A.saveStrategy(id, { params: { perStockKrw: 300000 } }, 'site', { confirm: true })).ok, true);
  assert.equal((await k.A.saveStrategy('intraday-p', { params: { cttrMin: 150, perStockKrw: 2000000 } }, 'site', { confirm: true })).ok, true);
  const L = await k.A.strategies(), me = L.strategies.find(s => s.id === id);
  assert.equal(me.sourceDiff, 1, '금액(perStockKrw) 차이는 세지 않음'); assert.equal(me.sourceName, '가상 원본'); assert.equal(me.side, 'real');
  assert.ok(L.ownKeys.includes('perStockKrw') && L.ownKeys.includes('execMode'));
  const d = await k.A.sourceDiff(id);
  assert.deepEqual(d.changes.map(x => x.key), ['cttrMin']);
  const ap = await k.A.applySource(id, 'site', { confirm: true });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  const after = k.strat.find(s => s.id === id).params;
  assert.equal(after.cttrMin, 150); assert.equal(after.perStockKrw, 300000); assert.equal(after.execMode, 'dryrun');
  assert.equal((await k.A.applySource(id, 'site', {})).unchanged, true);
  /* 실전 모드 전략이면 PIN */
  k.strat.find(s => s.id === id).params.execMode = 'live';
  await k.A.saveStrategy('intraday-p', { params: { cttrMin: 160 } }, 'site', { confirm: true });
  await k.A.strategies();
  const ap2 = await k.A.applySource(id, 'site', { confirm: true });
  assert.equal(ap2.needPin, true);
  /* 일반 복제(실전용 아님)는 원본을 기억하지 않음 */
  k.c.st.clock += 5000;   // 전략 ID 가 시각으로 만들어져 겹치지 않게
  const r3 = await k.A.createStrategy({ from: 'intraday-p' }, 'site');
  assert.notEqual(r3.strategy.id, id);
  assert.equal(k.strat.find(s => s.id === r3.strategy.id).source, undefined);
  await k.c.close();
});

test('드라이런 장부 테이블이 아직 없을 때: 드라이런 주문만 거부(가상 장부로 돌리지 않음) · 가상은 정상 · 감시 상태는 "없음"으로 실패 아님', async () => {
  const k = await rig({ missingDry: true });
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'dry'); k.at(10, 16);
  await k.A.handleApproval('/매수 B1');
  assert.equal(k.db.t.paper_orders.size, 0, '드라이런 주문이 가상 장부로 새지 않음');
  await k.A.handleApproval('/매수 A1');
  assert.equal(k.db.t.paper_orders.size, 1);
  await k.c.t.dry.tick();
  const h = k.c.t.engineHealth();
  assert.equal(h.dry.missing, true);
  const ev = evalHealth({ now: k.c.st.clock, bootAt: k.c.st.clock - 600e3, tradingDay: true, min: 616, engines: { paper: { enabled: true, lastTick: k.c.st.clock }, dry: h.dry }, token: { ok: true }, held: 0, authority: { mode: 'ok', held: true, holder: 'me' } });
  assert.equal(ev.ok, true, JSON.stringify(ev.reasons)); assert.equal(ev.engines.dry.missing, true);
  await k.c.close();
});

test('드라이런 장부: 실전 한도로 점검(1회 50만 초과 거부) · 가상 장부는 가상 한도', async () => {
  const db = fakeDb(), c = await boot(db);
  const big = { code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10000, qty: 60 };
  const d = await c.t.dry.place(big);
  assert.equal(d.ok, false); assert.match(d.error, /1회 주문 한도/);
  const p = await c.t.paper.place(big);
  assert.equal(p.ok, true);
  assert.equal(db.t.dry_orders.size, 0); assert.equal(db.t.paper_orders.size, 1);
  await c.close();
});

test('broker: 드라이런 = dry 장부(주문) + 실제 계좌(보유 확인) · dry 장부가 없으면 예전처럼 가상 장부', async () => {
  const mk = codes => ({ heldCodes: () => codes, state: async () => ({ ok: true, positions: [], orders: [], fills: [] }) });
  const B = createBroker({ paper: mk(['AAA']), dry: mk(['BBB']), live: mk(['CCC']), modeOf: s => ({ p: 'paper', d: 'dryrun', l: 'live' }[s]) });
  assert.equal(B.of('d').kind, 'dry'); assert.equal(B.of('p').kind, 'paper'); assert.equal(B.of('l').kind, 'live');
  assert.equal(B.sideOf('d'), 'real'); assert.equal(B.sideOf('p'), 'paper');
  assert.deepEqual([...await B.of('d').held()].sort(), ['BBB', 'CCC'], '드라이런은 가상 장부 보유를 피하지 않음(같은 전략 = 같은 종목)');
  const B2 = createBroker({ paper: mk(['AAA']), live: mk([]), modeOf: () => 'dryrun' });
  assert.equal(B2.of('x').kind, 'paper');
});

test('전략 켜기 상한은 쪽마다 3개(가상매매 3 + 실전매매 3) · 글자 A~F', async () => {
  const db = { auto_strategies: [], versions: [] };
  let t = 1_800_000_000_000;
  const io = {
    sbGet: async p => p.startsWith('auto_strategies') ? JSON.parse(JSON.stringify(db.auto_strategies)) : p.startsWith('auto_strategy_versions') ? db.versions.slice() : [],
    sbWrite: async (p, m, b) => { if (p.startsWith('auto_strategies')) b.forEach(x => { const i = db.auto_strategies.findIndex(r => r.id === x.id); if (i >= 0) db.auto_strategies[i] = { ...db.auto_strategies[i], ...x }; else db.auto_strategies.push(x); }); else db.versions.push(...b); },
    now: () => (t += 1000),
  };
  for (const b of ST.BUILTIN) db.auto_strategies.push({ ...b, enabled: b.kind === 'closing', archived: false, version: 1, params: ST.defaults(b.kind) });
  const st = ST.createStore(io), P = [], R = [];
  for (let i = 0; i < 4; i++) P.push((await st.create({ kind: 'intraday', name: `가상${i}` })).strategy.id);
  for (let i = 0; i < 4; i++) { const id = (await st.create({ kind: 'intraday', name: `실전${i}` })).strategy.id; await st.save(id, { params: { execMode: 'dryrun' } }, 'test', { allowSide: true }); R.push(id); }   // 새 복제본만 쪽을 정할 수 있음(「실전에 적용」과 같은 경로)
  for (let i = 0; i < 3; i++) { assert.equal((await st.save(P[i], { enabled: true })).ok, true); assert.equal((await st.save(R[i], { enabled: true })).ok, true); }
  assert.match((await st.save(P[3], { enabled: true })).error, /가상매매 장중 전략은 최대 3개/);
  assert.match((await st.save(R[3], { enabled: true })).error, /실전매매 장중 전략은 최대 3개/);
  const A2 = await st.actives();
  assert.equal(A2.Is.length, 6); assert.deepEqual(A2.Is.map(i => i.letter), ['A', 'B', 'C', 'D', 'E', 'F']);
  /* 쪽 이동 자체가 금지(2026-11-19 섞임 방지): 실전매매 전략을 가상으로 바꾸면 거부 */
  assert.match((await st.save(R[0], { params: { execMode: 'paper' } })).error, /가상으로 바꿀 수 없어요/);
});

test('MFE·MAE 기록: 같은 종목을 장부마다 따로(가상은 종목코드, 드라이런은 종목@dry)', () => {
  const store = EXC.fresh();
  const pos = [{ code: '005930', kind: 'paper', qty: 10, avg: 10000, last: 10200 }, { code: '005930', kind: 'dry', qty: 5, avg: 10100, last: 9900 }];
  EXC.update(store, pos, new Set(['005930', '005930@dry']), '2027-01-13');
  assert.deepEqual(Object.keys(store.pos).sort(), ['005930', '005930@dry']);
  assert.equal(store.pos['005930'].hi, 10200); assert.equal(store.pos['005930@dry'].lo, 9900);
  assert.equal(EXC.find(store, '005930', '2027-01-13').avg, 10000);
  assert.equal(EXC.find(store, '005930', '2027-01-13', 'dry').avg, 10100);
  EXC.update(store, [pos[0]], new Set(['005930']), '2027-01-14');
  assert.equal(store.done.length, 1); assert.equal(store.done[0].code, '005930'); assert.equal(store.done[0].kind, 'dry');
  assert.equal(EXC.find(store, '005930', '2027-01-13', 'dry').avg, 10100, '끝난 기록도 장부로 찾음');
});

test('비교(순수): 겹치는 날만 · 같은 종목 매수가 차이(슬리피지)·수익률 차이 · 한쪽만 산 종목', () => {
  const a = [{ trade_date: '2027-01-13', net: 900, cost: 100000, pct: 0.9, engine: 'live', pos: [{ code: 'A', name: '가', qty: 10, buyAvg: 10050, pnl: 900, pct: 0.9 }, { code: 'B', name: '나', qty: 5, buyAvg: 2000, pnl: -10, pct: -0.1 }] },
    { trade_date: '2027-01-14', net: 0, cost: 0, engine: 'live', pos: [] }];
  const b = [{ trade_date: '2027-01-13', net: 2000, cost: 200000, pct: 1.0, pos: [{ code: 'A', name: '가', qty: 20, buyAvg: 10000, pnl: 2000, pct: 1.0 }, { code: 'C', name: '다', qty: 1, buyAvg: 500, pnl: 5, pct: 1 }] }];
  const r = JRN.compareRows(a, b);
  assert.equal(r.days.length, 1);
  assert.equal(r.totals.both, 1); assert.equal(r.totals.onlyReal, 1); assert.equal(r.totals.onlySrc, 1);
  assert.equal(r.totals.slipAvg, 0.5); assert.equal(r.totals.pctDiffAvg, -0.1);
  assert.equal(JRN.closingIdFor('closing-default', 'live'), 'closinglive-default');
  assert.equal(JRN.closingIdFor('closing-default', 'paper'), 'closing-default');
  assert.ok(/^[a-z]+-[a-z0-9]{1,20}$/.test(JRN.closingIdFor('closing-mabc123', 'dry')), '일지 ID 규칙에 맞음');
});

test('실전 모드: 가상 원본과 실전 복제가 같은 종목을 각자 — 실제 계좌 주문(출처 기록) · 실전매매 화면은 자동매매 몫만 · 일지는 직접 매매 체결을 뺌', async () => {
  const k = await rig({ live: true, rParams: { execMode: 'live' } });
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'live');
  k.at(10, 16);
  await k.A.handleApproval('/매수 A1');
  const msg = await k.A.handleApproval('/매수 B1');   // 텔레그램 직접 승인(실전 자동 승인 허용 전에도 가능)
  const kb = k.kx.posts.filter(x => x.tr === 'TTTC0012U');
  assert.equal(kb.length, 1, msg);
  const lo = [...k.db.t.live_orders.values()].find(o => o.side === 'buy');
  assert.equal(lo.origin, 'auto:intraday-r'); assert.equal(lo.code, '005930');
  assert.ok(+kb[0].body.ORD_QTY * 10000 <= 500000, '실전 1회 상한');
  const autoQty = +kb[0].body.ORD_QTY;
  k.kx.fill([...k.kx.orders.values()].slice(-1)[0].odno, autoQty, 10000);
  /* 같은 종목을 직접 3주 더 삼(실제 계좌, 출처 없음) */
  const man = await k.c.t.live.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10000, qty: 3 });
  assert.equal(man.ok, true, JSON.stringify(man));
  k.kx.fill([...k.kx.orders.values()].slice(-1)[0].odno, 3, 10000);
  await k.fillAll();
  for (let i = 0; i < 4; i++) { k.c.st.clock += 31000; await k.c.t.live.tick(); }
  await k.A.tick();
  assert.equal(k.db.t.paper_positions.get('005930').qty, 100, '가상은 가상대로');
  const R = await k.A.uiState(null, 'real');
  const lp = R.positions.find(p => p.kind === 'live');
  assert.ok(lp, JSON.stringify(R.positions)); assert.equal(lp.qty, autoQty, '실전매매 화면은 자동매매 몫만(직접 산 3주 제외)');
  assert.ok(R.trades.every(f => f.kind === 'live'));
  await k.A.journal.generateDay(k.date, { today: k.date, min: 1000, phase: 1, announce: false });
  const jr = k.journal[`${k.date}|intraday-r`];
  assert.equal(jr.payload.engine, 'live');
  assert.equal(jr.payload.positions[0].qty, autoQty, '일지는 자동매매 주문 체결만(직접 매수 3주 제외)');
  assert.equal(k.journal[`${k.date}|intraday-p`].payload.positions[0].qty, 100);
  const cmp = await k.A.journalCompare({ sid: 'intraday-r', src: 'intraday-p', engine: 'live' });
  assert.equal(cmp.totals.both, 1);
  await k.c.close();
});

test('사이트 "실전 주문" 스위치가 꺼져 있으면: 실전 모드 전략은 매수를 건너뜀(KIS 로 안 나감) · 드라이런·가상은 영향 없음 · 켜면 매수', async () => {
  const k = await rig({ live: true, rParams: { execMode: 'live' }, siteSwitch: false });
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'live');
  k.at(10, 16);
  await k.A.handleApproval('/매수 A1');
  assert.equal(k.db.t.paper_orders.size, 1, '가상은 그대로');
  const msg = await k.A.handleApproval('/매수 B1');
  assert.equal(k.kx.posts.filter(x => x.tr === 'TTTC0012U').length, 0, msg);
  assert.equal(k.db.t.live_orders.size, 0);
  const st = k.run('intraday-r').payload.orders && k.run('intraday-r').payload.orders['005930'];
  assert.ok(!st || st.st !== 'filled', '실전 주문 기록이 체결로 남지 않음');
  assert.equal((await k.A.uiState(null, 'real')).engines.realOrders, false);
  await k.c.t.setRealOn(true, null, 'test');
  assert.equal((await k.A.uiState(null, 'real')).engines.realOrders, true);
  await k.c.close();
});

test('손절·익절 같은 매도는 스위치가 꺼져도 실전에서 계속 나감(guard 가 매수만 막음)', async () => {
  const k = await rig({ live: true, rParams: { execMode: 'live' } });
  const buy = await k.c.t.live.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 10000, qty: 2 });
  assert.equal(buy.ok, true, JSON.stringify(buy));
  k.kx.fill([...k.kx.orders.values()].slice(-1)[0].odno, 2, 10000);
  for (let i = 0; i < 3; i++) { k.c.st.clock += 31000; await k.c.t.live.tick(); }
  await k.c.t.setRealOn(false, null, 'test');
  const buy2 = await k.c.t.live.place({ code: '000660', name: 'SK하이닉스', side: 'buy', type: 'limit', price: 10000, qty: 1 });
  assert.equal(buy2.ok, false); assert.match(buy2.error, /switched off/);
  const sell = await k.c.t.live.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 10000, qty: 2 });
  assert.equal(sell.ok, true, JSON.stringify(sell));
  await k.c.close();
});

test('섞임 방지 #1: 같은 종목에 가상·드라이런 자동 매수가 함께 걸려 있을 때 가상 주문 취소는 가상만 — 드라이런 주문은 그대로', async () => {
  const k = await rig();
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'dry');
  k.at(10, 16);
  k.c.st.asks = k.c.st.asks.map(([p, q], i) => [10500 + i * 10, q]);   // 매도호가를 올려 바로 체결되지 않게
  await k.A.handleApproval('/매수 A1'); await k.A.handleApproval('/매수 B1');
  const po = [...k.db.t.paper_orders.values()].find(o => o.side === 'buy'), dz = [...k.db.t.dry_orders.values()].find(o => o.side === 'buy');
  assert.ok(po && dz, '두 장부에 각자 주문');
  assert.equal(po.status, 'open'); assert.equal(dz.status, 'open');
  assert.equal(await k.A.pendingAutoBuy('005930', 'paper'), po.id);
  assert.equal(await k.A.pendingAutoBuy('005930', 'dry'), dz.id);
  assert.equal(await k.A.autoOrderCode(dz.id, 'paper'), null, '가상 화면에서 드라이런 주문번호는 안 찾힘');
  const r = await k.A.siteOrderEdit({ code: '005930', engine: 'paper', orderId: po.id, action: 'cancel' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(k.db.t.paper_orders.get(po.id).status, 'cancelled');
  assert.equal(k.db.t.dry_orders.get(dz.id).status, 'open', '드라이런 주문은 그대로');
  assert.equal(k.run('intraday-r').payload.orders['005930'].st, 'open');
  /* 반대로: 드라이런 주문번호로 가상 장부를 지정하면 거부 */
  assert.equal((await k.A.siteOrderEdit({ code: '005930', engine: 'paper', orderId: dz.id, action: 'cancel' })).status, 409);
  await k.c.close();
});

test('섞임 방지 #1(실전): 같은 종목 가상·실전 자동 매수 — 가상 화면 HTTP 취소는 실전 주문(KIS)에 닿지 않음', async () => {
  const k = await rig({ live: true, rParams: { execMode: 'live' } });
  k.c.t.attachAuto(k.A);
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'live');
  k.at(10, 16);
  k.c.st.asks = k.c.st.asks.map(([p, q], i) => [10500 + i * 10, q]);
  await k.A.handleApproval('/매수 A1'); await k.A.handleApproval('/매수 B1');
  const po = [...k.db.t.paper_orders.values()].find(o => o.side === 'buy');
  const lo = [...k.db.t.live_orders.values()].find(o => o.side === 'buy');
  assert.ok(po && lo, '가상·실전 각자 주문');
  await k.c.login();
  const before = k.kx.posts.length;
  const r = await k.c.call('POST', '/trade/paper/cancel', { body: { id: po.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(k.db.t.paper_orders.get(po.id).status, 'cancelled');
  assert.equal(k.kx.posts.length, before, 'KIS 로 취소가 나가지 않음');
  assert.equal(k.run('intraday-r').payload.orders['005930'].st, 'open', '실전 자동 주문 기록 그대로');
  /* 사이트 자동 주문 수정 API 도 장부를 꼭 받음 */
  const bad = await k.c.call('POST', '/trade/auto/order-edit', { body: { code: '005930', action: 'cancel' } });
  assert.equal(bad.status, 400);
  await k.c.close();
});

test('섞임 방지 #2: 글자 없는 텔레그램 명령은 가상매매만 — /매수 1·/매수 전체·/패스 가 실전매매 후보를 건드리지 않음 · 글자를 붙이면 실전매매', async () => {
  const k = await rig();
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'dry');
  k.at(10, 16);
  await k.A.handleApproval('/매수 전체');
  assert.equal([...k.db.t.paper_orders.values()].filter(o => o.side === 'buy').length, 1, '가상은 매수');
  assert.equal(k.db.t.dry_orders.size, 0, '드라이런(실전매매)은 그대로');
  assert.ok(!k.run('intraday-r').payload.decision, '실전매매 후보는 미결정');
  const again = await k.A.handleApproval('/매수 1');
  assert.equal(k.db.t.dry_orders.size, 0, again);
  assert.match(await k.A.handleApproval('/패스'), /이미 처리|가상/);
  assert.ok(!k.run('intraday-r').payload.decision, '/패스 도 실전매매는 건드리지 않음');
  await k.A.handleApproval('/매수 B1');
  assert.equal([...k.db.t.dry_orders.values()].filter(o => o.side === 'buy').length, 1, '글자를 붙이면 실전매매 매수');
  await k.c.close();

  const k2 = await rig();
  k2.seed('intraday-r', 'B', 'dry');   // 실전매매 후보만 남은 날
  k2.at(10, 16);
  const m = await k2.A.handleApproval('/매수 1');
  assert.match(m, /가상매매에는 오늘 승인할 후보가 없어요/); assert.match(m, /\/매수 B1/);
  assert.equal(k2.db.t.dry_orders.size, 0, '글자 없는 /매수 1 로는 실전매매 후보를 사지 않음');
  assert.match(await k2.A.handleApproval('/매수 전체'), /글자를 붙여/);
  assert.equal(k2.db.t.dry_orders.size, 0);
  await k2.A.handleApproval('/패스 B');
  assert.equal(k2.run('intraday-r').payload.decision.kind, 'pass', '/패스 B 는 그 전략만');
  await k2.c.close();
});

test('섞임 방지 #2: 명령 파싱 — 글자 붙인 전체·패스·유지', () => {
  const { parseCmdMulti } = require('../auto');
  assert.deepEqual(parseCmdMulti('/패스 B', 'buy'), { kind: 'pass', letter: 'B' });
  assert.deepEqual(parseCmdMulti('/매수 b 전체', 'buy'), { kind: 'all', letter: 'B' });
  assert.deepEqual(parseCmdMulti('/매수 B전체', 'buy'), { kind: 'all', letter: 'B' });
  assert.deepEqual(parseCmdMulti('/매수 all', 'buy'), { kind: 'all' });
  assert.deepEqual(parseCmdMulti('/유지 D', 'eod'), { kind: 'keep', letter: 'D' });
  assert.deepEqual(parseCmdMulti('/정리 D 전체', 'eod'), { kind: 'all', letter: 'D' });
  assert.deepEqual(parseCmdMulti('/패스 G', 'buy'), null, '없는 글자는 명령 아님');
});

test('섞임 방지 #3: 화면이 보낸 쪽(desk)과 주소·전략의 쪽이 다르면 서버가 거부(409) — KIS 로 나가지 않음', async () => {
  const k = await rig({ live: true, rParams: { execMode: 'live' } });
  k.c.t.attachAuto(k.A);
  k.seed('intraday-p', 'A', 'paper'); k.seed('intraday-r', 'B', 'live');
  k.at(10, 16);
  await k.c.login();
  const buy = { code: '005930', side: 'buy', type: 'limit', price: 10000, qty: 1 };
  const r1 = await k.c.call('POST', '/trade/live/order', { body: { ...buy, desk: 'paper' } });
  assert.equal(r1.status, 409); assert.equal(k.kx.posts.filter(x => x.tr === 'TTTC0012U').length, 0, 'KIS 로 안 나감');
  assert.equal((await k.c.call('POST', '/trade/paper/order', { body: { ...buy, desk: 'real' } })).status, 409);
  assert.equal(k.db.t.paper_orders.size, 0);
  assert.equal((await k.c.call('POST', '/trade/paper/order', { body: { ...buy, desk: 'xyz' } })).status, 400);
  assert.equal((await k.c.call('POST', '/trade/auto/approve', { body: { kind: 'buy', nums: [1], strategy: 'intraday-r', desk: 'paper' } })).status, 409, '가상 화면에서 실전 전략 승인 불가');
  assert.equal(k.kx.posts.filter(x => x.tr === 'TTTC0012U').length, 0);
  assert.equal((await k.c.call('POST', '/trade/auto/approve', { body: { kind: 'pass', strategy: 'intraday-p', desk: 'real' } })).status, 409, '실전 화면에서 가상 전략 패스 불가');
  assert.ok(!k.run('intraday-p').payload.decision);
  assert.equal((await k.c.call('POST', '/trade/auto/config', { body: { liveOn: true, pin: '123456', desk: 'paper' } })).status, 409);
  assert.equal((await k.c.call('POST', '/trade/auto/config', { body: { on: false, desk: 'real' } })).status, 409);
  assert.equal((await k.c.call('POST', '/trade/auto/strategy', { body: { id: 'intraday-p', name: 'x', desk: 'real' } })).status, 409);
  assert.equal((await k.c.call('POST', '/trade/auto/order-edit', { body: { code: '005930', engine: 'live', orderId: 'x', action: 'cancel', desk: 'paper' } })).status, 409);
  assert.ok(k.db.t.trade_audit.some(a => a.event === 'desk_mismatch'), '감사 기록');
  /* 같은 쪽이면 정상 처리: 실전 화면에서 실전 전략 승인 */
  const ok = await k.c.call('POST', '/trade/auto/approve', { body: { kind: 'buy', nums: [1], strategy: 'intraday-r', desk: 'real' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(k.kx.posts.filter(x => x.tr === 'TTTC0012U').length, 1);
  /* 전략을 정하지 않은 사이트 승인은 desk 쪽만 */
  await k.c.close();
});

test('섞임 방지 #5: 장중 전략은 쪽을 옮기지 않음 — 가상→드라이런·실전, 실전매매→가상 저장 거부 · 「실전에 적용」 복제는 허용', async () => {
  const k = await rig();
  const a = await k.A.saveStrategy('intraday-p', { params: { ...k.strat.find(s => s.id === 'intraday-p').params, execMode: 'dryrun' } }, 'test', { confirm: true });
  assert.equal(a.ok, false); assert.equal(a.status, 409); assert.match(a.error, /실전에 적용/);
  const b = await k.A.saveStrategy('intraday-r', { params: { ...k.strat.find(s => s.id === 'intraday-r').params, execMode: 'paper' } }, 'test', { confirm: true });
  assert.equal(b.ok, false); assert.equal(b.status, 409);
  const c = await k.A.createStrategy({ kind: 'intraday', from: 'intraday-p', asLive: true }, 'test');
  assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.strategy.params.execMode, 'dryrun');
  await k.c.close();
});
