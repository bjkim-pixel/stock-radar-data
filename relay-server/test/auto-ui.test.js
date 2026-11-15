'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const U = require('../auto-ui');
const { createAuto } = require('../auto');
const { createTrade, hashPin } = require('../trade');

/* ── 순수 함수 ── */
test('설정 검증: on 은 불리언, 금액은 10만~5천만 · 1만원 단위 정수', () => {
  assert.deepEqual(U.checkConfig({ on: true }).val, { on: true });
  assert.deepEqual(U.checkConfig({ perStockKrw: 1500000 }).val, { perStockKrw: 1500000 });
  assert.deepEqual(U.checkConfig({ on: false, perStockKrw: '2000000' }).val, { on: false, perStockKrw: 2000000 });
  for (const bad of [{}, { on: 'yes' }, { on: 1 }, { perStockKrw: 50000 }, { perStockKrw: 60000000 }, { perStockKrw: 1234567 }, { perStockKrw: 1500000.5 }, { perStockKrw: 'abc' }, null])
    assert.ok(U.checkConfig(bad).err, JSON.stringify(bad));
});

const run = (date, orders, shadow = []) => ({ date, status: 'approved', decision: { kind: 'buy' }, picks: [], shadow, orders });
test('실현손익은 그 종목을 산 가장 최근 실행일에 붙는다(다음 날 아침 매도 포함)', () => {
  const runs = [run('2026-11-12', [{ code: 'A', filled: 10, avg: 1000 }]), run('2026-11-13', [{ code: 'A', filled: 5, avg: 1100 }, { code: 'B', filled: 1, avg: 5000 }])];
  const sells = [
    { code: 'A', ts: '2026-11-12T05:00:00+00:00', realized: 100 },   // 12일 14:00 KST → 12일 실행
    { code: 'A', ts: '2026-11-13T00:05:00+00:00', realized: 50 },    // 13일 09:05 KST → 13일 실행(최근 우선)
    { code: 'B', ts: '2026-11-14T00:05:00+00:00', realized: -30 },   // 14일 아침 → 13일 실행
    { code: 'Z', ts: '2026-11-13T00:05:00+00:00', realized: 999 },   // 자동매매 종목이 아님 → 무시
  ];
  const r = U.attributeRealized(runs, sells);
  assert.deepEqual(r['2026-11-12'], { realized: 100, n: 1 });
  assert.deepEqual(r['2026-11-13'], { realized: 20, n: 2 });
});
test('그림자 수익률: 선정가→종가, 알림 후보·실제 매수·전체 평균', () => {
  const r = run('2026-11-12', [{ code: 'A', filled: 10, avg: 1000 }], [
    { code: 'A', price: 1000, picked: true }, { code: 'B', price: 2000, picked: true }, { code: 'C', price: 1000, picked: false }, { code: 'D', price: 1000, picked: false }]);
  const s = U.shadowReturns(r, { '2026-11-12': { A: 1100, B: 1900, C: 900 } });   // D 종가 없음
  assert.ok(Math.abs(s.picked - 2.5) < 1e-9 && s.pickedN === 2);   // (+10 + −5)/2
  assert.ok(Math.abs(s.bought - 10) < 1e-9 && s.boughtN === 1);
  assert.ok(Math.abs(s.all - (10 - 5 - 10) / 3) < 1e-9 && s.allN === 3);
  assert.equal(U.shadowReturns(r, {}).all, null);   // 종가 자료 없음
});
test('일별 성과 표: 비용·손익·승률·오늘은 그림자 제외', () => {
  const runs = [
    run('2026-11-15', [{ code: 'A', filled: 10, avg: 1000 }]),
    run('2026-11-13', [{ code: 'A', filled: 10, avg: 1000 }], [{ code: 'A', price: 1000, picked: true }]),
    run('2026-11-12', [], []),
  ];
  const h = U.buildHistory(runs, { '2026-11-13': { realized: 500, n: 2 }, '2026-11-15': { realized: 0, n: 0 } }, { '2026-11-13': { A: 1020 } }, '2026-11-15');
  assert.equal(h.rows[0].shadow, null);                       // 오늘
  assert.equal(h.rows[0].pct, null);                          // 아직 팔지 않음
  assert.equal(h.rows[1].cost, 10000);
  assert.ok(Math.abs(h.rows[1].pct - 5) < 1e-9);
  assert.ok(Math.abs(h.rows[1].shadow.picked - 2) < 1e-9);
  assert.equal(h.totals.doneDays, 1); assert.equal(h.totals.wins, 1); assert.equal(h.totals.tradedDays, 2);
  assert.ok(Math.abs(h.totals.pct - 5) < 1e-9);
});

/* ── createAuto.uiState / setConfig (가짜 DB) ── */
function fakeAuto({ runs = [], cfg = {}, fills = [], closes = [], paperState = null } = {}) {
  const store = { cfg: JSON.parse(JSON.stringify(cfg)), writes: [] };
  const A = createAuto({
    sbGet: async p => {
      if (p.startsWith('auto_strateg')) throw new Error('auto_strategies 404 PGRST205');   // 165 SQL 실행 전 상태
      if (p.startsWith('auto_config')) { const k = (p.match(/key=eq\.(\w+)/) || [])[1]; return store.cfg[k] ? [{ key: k, value: JSON.parse(JSON.stringify(store.cfg[k])) }] : []; }
      if (p.startsWith('auto_runs')) { const d = (p.match(/trade_date=eq\.([\d-]+)/) || [])[1]; return d ? runs.filter(r => r.trade_date === d) : runs.slice().sort((a, b) => a.trade_date < b.trade_date ? 1 : -1); }
      if (p.startsWith('paper_fills')) return fills;
      if (p.startsWith('daily_price')) return closes;
      return [];
    },
    sbWrite: async (p, m, b) => { store.writes.push([p, b]); b.forEach(x => { if (p.startsWith('auto_config')) store.cfg[x.key] = x.value; }); },
    sendTelegram: async () => {}, kstNow: () => ({ date: '2026-11-16', min: 600 }), isTradingDay: () => true, now: () => Date.now(),
    paper: paperState ? { state: async () => paperState } : undefined,
    getQuote: async () => ({}), loadChart: async () => [], livePool: async () => [], fetchFlow: async () => ({}), fetchPower: async () => ({}), fetchCttr: async () => ({}), marketState: async () => null,
  });
  return { A, store };
}
const mkRun = (date, payload, status = 'approved') => ({ trade_date: date, status, payload });

test('uiState: 설정·오늘 후보·보유·일별 성과를 한 번에 돌려준다', async () => {
  const { A } = fakeAuto({
    cfg: { main: { on: true, perStockKrw: 2000000 }, carry: { items: { A: { code: 'A', name: '가', q0: 10, avg: 1000, from: '2026-11-13', sold: 0, state: 'wait' } } } },
    runs: [
      mkRun('2026-11-16', { picks: [{ code: 'T', name: '오늘주', score: 77, price: 5000, open: 4900, changePct: 2, sector: '반도체', reasons: ['외국인'], m: { cttr: 120 } }], shadow: [{ code: 'T', name: '오늘주', price: 5000, score: 77, picked: true }], decision: null, noticeSent: true }, 'noticed'),
      mkRun('2026-11-13', { picks: [{ code: 'A', name: '가', score: 80, price: 1000 }], shadow: [{ code: 'A', name: '가', price: 1000, score: 80, picked: true }, { code: 'X', name: '엑', price: 1000, score: 60, picked: false }], decision: { kind: 'buy', nums: [1] }, orders: { A: { st: 'filled', filled: 10, avg: 1000 } } }),
    ],
    fills: [{ code: 'A', ts: '2026-11-14T00:05:00+00:00', realized: 400 }],
    closes: [{ code: 'A', trade_date: '2026-11-13', close: '1050' }, { code: 'X', trade_date: '2026-11-13', close: '950' }],
    paperState: { ok: true, positions: [{ code: 'A', name: '가', qty: 10, avg: 1000, last: 1040, stop: 950 }, { code: 'Q', name: '남', qty: 1, avg: 1, last: 1 }] },
  });
  const s = await A.uiState();
  assert.equal(s.ok, true); assert.equal(s.date, '2026-11-16');
  assert.deepEqual(s.cfg, { on: true, perStockKrw: 2000000 });
  assert.equal(s.today.picks[0].reasons[0], '외국인'); assert.equal(s.today.status, 'noticed');
  assert.deepEqual(s.positions.map(p => p.code), ['A']);        // 자동매매 종목만
  assert.equal(s.carry.length, 1);
  const h = s.history.find(r => r.date === '2026-11-13');
  assert.equal(h.cost, 10000); assert.equal(h.realized, 400); assert.ok(Math.abs(h.pct - 4) < 1e-9);
  assert.ok(Math.abs(h.shadow.picked - 5) < 1e-9); assert.ok(Math.abs(h.shadow.all - 0) < 1e-9);
  assert.equal(s.totals.wins, 1);
  assert.deepEqual(s.limits, { min: U.PER_MIN, max: U.PER_MAX, step: U.PER_STEP });
});
test('uiState: 기록이 하나도 없어도 오류 없이 빈 상태', async () => {
  const { A } = fakeAuto({});
  const s = await A.uiState();
  assert.equal(s.today, null); assert.deepEqual(s.history, []); assert.deepEqual(s.cfg, { on: false, perStockKrw: 1000000 });
});
test('setConfig: 기존 값은 유지하고 바꾼 값만 저장 · 잘못된 값은 저장 안 함', async () => {
  const { A, store } = fakeAuto({ cfg: { main: { on: true, perStockKrw: 1000000, extra: 1 } } });
  const bad = await A.setConfig({ perStockKrw: 12345 });
  assert.equal(bad.ok, false); assert.equal(store.writes.length, 0);
  const r = await A.setConfig({ perStockKrw: 3000000 });
  assert.equal(r.ok, true); assert.deepEqual(store.cfg.main, { on: true, perStockKrw: 3000000, extra: 1 });
  const r2 = await A.setConfig({ on: false });
  assert.deepEqual(r2.cfg, { on: false, perStockKrw: 3000000 });
});

/* ── HTTP 라우트: 로그인 + PIN 세션 필요 ── */
const ORIGIN = 'https://bjkim-pixel.github.io', GOOD = 'good-token-0123456789abcdef';
test('/trade/auto/*: 세션 없으면 401 · 세션이 있으면 조회·설정, 설정은 감사 기록', async () => {
  const pinHash = await hashPin('123456', 100000), audits = [];
  const env = { ALLOWED_EMAIL: 'owner@example.com', SUPABASE_ANON_KEY: 'anon', TRADE_PIN_HASH: pinHash, TRADING_ENABLED: '1', TRADE_APPROVAL: '0' };
  let clock = 1_800_000_000_000;
  const t = createTrade({
    env, now: () => clock, allowedOrigins: [ORIGIN], clientIp: () => '1.1.1.1', sbWrite: async (tbl, m, rows) => { audits.push(...rows); }, notify: async () => {},
    fetch: async url => String(url).includes('/auth/v1/user') ? { ok: true, status: 200, json: async () => ({ id: 'u1', email: 'owner@example.com' }) } : { ok: true, status: 200 },
  });
  const saved = [];
  const fake = { uiState: async () => ({ ok: true, hello: 1 }), setConfig: async b => (b.perStockKrw === 12345 ? { ok: false, status: 400, error: '금액 오류' } : { ok: true, cfg: { on: !!b.on, perStockKrw: 1 }, changed: b }),
    createStrategy: async (b, who) => (b.kind === 'bad' ? { ok: false, status: 400, error: '유형' } : { ok: true, strategy: { id: 'intraday-abc', kind: b.kind, who } }), deleteStrategy: async id => (id === 'intraday-default' ? { ok: false, status: 400, error: '기본 전략' } : { ok: true }),
    siteApprove: async (k, n, sid) => ({ ok: true, reply: `승인 ${k} ${n.join(',')}${sid ? ' ' + sid : ''}` }), siteEod: async (k, n) => ({ ok: true, reply: `정리 ${k} ${n.join(',')}` }),
    strategies: async () => ({ ok: true, strategies: [{ id: 'intraday-default' }] }), strategyVersions: async id => ({ ok: true, versions: [{ version: 2, id }] }),
    saveStrategy: async (id, patch, who) => { saved.push({ id, patch, who }); return patch.params && patch.params.cttrMin > 200 ? { ok: false, status: 400, error: '체결강도 범위', errs: [{ key: 'cttrMin' }] } : { ok: true, strategy: { id, version: 2 }, changed: [{ key: 'cttrMin', from: '100%', to: '120%' }] }; } };
  const server = http.createServer((req, res) => { if (!t.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let n = 0;
  const call = async (method, path, { session, body } = {}) => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${GOOD}`, origin: ORIGIN };
    if (session) headers['x-trade-session'] = session;
    const r = await fetch(base + path, { method, headers, body: method === 'POST' ? JSON.stringify({ nonce: 'n' + (++n) + 'abcdefghijkl', ts: clock, ...body }) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    assert.equal((await call('GET', '/trade/auto/state')).status, 401);                  // 세션 없음
    const so = await call('POST', '/trade/session', { body: { pin: '123456' } });
    assert.equal(so.status, 200); const session = so.body.session;
    assert.equal((await call('GET', '/trade/auto/state', { session })).status, 503);    // 자동매매 미연결
    t.attachAuto(fake);
    const st = await call('GET', '/trade/auto/state', { session });
    assert.equal(st.status, 200); assert.equal(st.body.hello, 1);
    assert.equal((await call('POST', '/trade/auto/config', { body: { on: true } })).status, 401);   // 세션 없음
    const ok = await call('POST', '/trade/auto/config', { session, body: { on: true } });
    assert.equal(ok.status, 200); assert.equal(ok.body.cfg.on, true);
    const no = await call('POST', '/trade/auto/config', { session, body: { perStockKrw: 12345 } });
    assert.equal(no.status, 400); assert.match(no.body.error, /금액/);
    assert.equal((await call('GET', '/trade/auto/strategies')).status, 401);
    assert.equal((await call('GET', '/trade/auto/strategies', { session })).body.strategies[0].id, 'intraday-default');
    assert.equal((await call('GET', '/trade/auto/strategy-versions?id=intraday-default', { session })).body.versions[0].id, 'intraday-default');
    assert.equal((await call('POST', '/trade/auto/strategy', { body: { id: 'intraday-default', params: { cttrMin: 120 } } })).status, 401);
    const sv = await call('POST', '/trade/auto/strategy', { session, body: { id: 'intraday-default', params: { cttrMin: 120 }, junk: 1 } });
    assert.equal(sv.status, 200); assert.equal(sv.body.strategy.version, 2);
    assert.deepEqual(saved[0], { id: 'intraday-default', patch: { params: { cttrMin: 120 } }, who: 'site' });   // 허용한 키만 넘김
    const sb = await call('POST', '/trade/auto/strategy', { session, body: { id: 'intraday-default', params: { cttrMin: 300 } } });
    assert.equal(sb.status, 400); assert.equal(sb.body.errs[0].key, 'cttrMin');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(audits.some(a => a.event === 'auto_strategy' && a.ok === true && /cttrMin:100%→120%/.test(JSON.stringify(a.detail))));
    assert.ok(audits.some(a => a.event === 'auto_strategy_reject'));
    assert.equal((await call('POST', '/trade/auto/approve', { body: { kind: 'buy', nums: [1] } })).status, 401);
    assert.equal((await call('POST', '/trade/auto/approve', { session, body: { kind: 'buy', nums: [] } })).status, 400);
    assert.equal((await call('POST', '/trade/auto/approve', { session, body: { kind: 'hack', nums: [1] } })).status, 400);
    assert.equal((await call('POST', '/trade/auto/approve', { session, body: { kind: 'buy', nums: [1, 3, 3] } })).body.reply, '승인 buy 1,3');
    assert.equal((await call('POST', '/trade/auto/approve', { session, body: { kind: 'pass' } })).body.reply, '승인 pass ');
    assert.equal((await call('POST', '/trade/auto/eod', { session, body: { kind: 'sell', nums: [2] } })).body.reply, '정리 sell 2');
    assert.equal((await call('POST', '/trade/auto/approve', { session, body: { kind: 'buy', nums: [1], strategy: 'intraday-x1' } })).body.reply, '승인 buy 1 intraday-x1');
    assert.equal((await call('POST', '/trade/auto/approve', { session, body: { kind: 'buy', nums: [1], strategy: '../x' } })).status, 400);
    assert.equal((await call('POST', '/trade/auto/strategy-new', { body: { kind: 'intraday' } })).status, 401);
    assert.equal((await call('POST', '/trade/auto/strategy-new', { session, body: { kind: 'intraday', name: '새것' } })).body.strategy.who, 'site');
    assert.equal((await call('POST', '/trade/auto/strategy-new', { session, body: { kind: 'bad' } })).status, 400);
    assert.equal((await call('POST', '/trade/auto/strategy-delete', { session, body: { id: 'intraday-default' } })).status, 400);
    assert.equal((await call('POST', '/trade/auto/strategy-delete', { session, body: { id: 'intraday-abc' } })).status, 200);
    assert.equal((await call('POST', '/trade/auto/eod', { session, body: { kind: 'keep' } })).body.reply, '정리 keep ');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(audits.some(a => a.event === 'auto_approve') && audits.some(a => a.event === 'auto_eod'));
    assert.ok(audits.some(a => a.event === 'auto_strategy_new') && audits.some(a => a.event === 'auto_strategy_delete'));
    assert.ok(audits.some(a => a.event === 'auto_config' && a.ok === true));
    assert.ok(audits.some(a => a.event === 'auto_config_reject' && a.ok === false));
  } finally { await new Promise(r => server.close(r)); }
});
