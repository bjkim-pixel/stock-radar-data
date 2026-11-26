'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../auto-strategy');
const A = require('../auto');

/* ── 명령 파싱 ── */
test('명령 파싱: 글자+번호 · 글자 없음 · 전체 · 패스/유지 · 잘못된 입력', () => {
  assert.deepEqual(A.parseCmdMulti('/매수 A1 b2,3', 'buy'), { kind: 'pick', items: [{ letter: 'A', n: 1 }, { letter: 'B', n: 2 }, { letter: null, n: 3 }] });
  assert.deepEqual(A.parseCmdMulti('/매수 전체', 'buy'), { kind: 'all' });
  assert.deepEqual(A.parseCmdMulti('/패스', 'buy'), { kind: 'pass' });
  assert.deepEqual(A.parseCmdMulti('/매수 A123', 'buy'), { kind: 'bad' });
  assert.deepEqual(A.parseCmdMulti('/매수 D1 f2', 'buy'), { kind: 'pick', items: [{ letter: 'D', n: 1 }, { letter: 'F', n: 2 }] });   // 실전매매 전략까지 글자 A~F
  assert.deepEqual(A.parseCmdMulti('/매수', 'buy'), { kind: 'bad' });
  assert.equal(A.parseCmdMulti('/정리 1', 'buy'), null);
  assert.deepEqual(A.parseCmdMulti('/정리 A1 2', 'eod'), { kind: 'pick', items: [{ letter: 'A', n: 1 }, { letter: null, n: 2 }] });
  assert.deepEqual(A.parseCmdMulti('/유지', 'eod'), { kind: 'keep' });
  assert.deepEqual(A.parseCmdMulti('/정리 전체', 'eod'), { kind: 'all' });
});

/* ── 저장소: 동시 켜기 규칙 · 추가 · 복제 · 보관 ── */
function fakeStoreDb() {
  const db = { auto_strategies: [], versions: [] };
  let t = 1_800_000_000_000;
  const io = {
    sbGet: async p => p.startsWith('auto_strategies') ? JSON.parse(JSON.stringify(db.auto_strategies)) : p.startsWith('auto_strategy_versions') ? db.versions.slice().reverse() : [],
    sbWrite: async (p, m, b) => { if (p.startsWith('auto_strategies')) b.forEach(x => { const i = db.auto_strategies.findIndex(r => r.id === x.id); if (i >= 0) db.auto_strategies[i] = { ...db.auto_strategies[i], ...x }; else db.auto_strategies.push(x); }); else db.versions.push(...b); },
    now: () => (t += 1000),
  };
  for (const b of S.BUILTIN.filter(x => !x.off)) db.auto_strategies.push({ ...b, enabled: true, archived: false, version: 1, params: S.defaults(b.kind) });
  return { db, io };
}
test('장중 전략은 여러 개 켜지고(쪽마다 최대 12) 글자 A·B·C·D 가 붙는다', async () => {
  const { io } = fakeStoreDb(), st = S.createStore(io);
  const ids = [];
  for (let i = 0; i < 3; i++) { const r = await st.create({ kind: 'intraday', name: `장중${i}` }, 'site'); assert.equal(r.ok, true); assert.equal(r.strategy.enabled, false); ids.push(r.strategy.id); }
  assert.equal((await st.save(ids[0], { enabled: true })).ok, true);
  assert.equal((await st.save(ids[1], { enabled: true })).ok, true);
  assert.equal((await st.save(ids[2], { enabled: true })).ok, true);
  const A2 = await st.actives();
  assert.deepEqual(A2.Is.map(i => i.letter), ['A', 'B', 'C', 'D']);
  assert.equal(A2.Is[0].id, 'intraday-default');
  assert.equal(A2.Is[0].T.sel, 605);
});
test('종가 전략은 하나만: 새로 켜면 기존 것이 꺼지고 이력에 사유가 남는다', async () => {
  const { io, db } = fakeStoreDb(), st = S.createStore(io);
  const c = await st.create({ from: 'closing-default', name: '느린 이월' });
  assert.equal(c.strategy.kind, 'closing'); assert.deepEqual(c.strategy.params, S.defaults('closing'));
  const r = await st.save(c.strategy.id, { enabled: true, params: { slices: ['09:20', '09:40'] } });
  assert.equal(r.ok, true); assert.deepEqual(r.turnedOff, ['장중 강세 이월']);
  const A2 = await st.actives();
  assert.equal(A2.C.id, c.strategy.id); assert.deepEqual(A2.Is[0].T.slices, [560, 580]);
  assert.ok(db.versions.some(v => v.strategy_id === 'closing-default' && JSON.stringify(v.changed).includes('하나만')));
});
test('복제는 조건값을 그대로 가져오고, 보관은 기본·켜진 전략을 막는다', async () => {
  const { io } = fakeStoreDb(), st = S.createStore(io);
  await st.save('intraday-default', { params: { cttrMin: 130 } });
  const c = await st.create({ from: 'intraday-default' });
  assert.equal(c.strategy.params.cttrMin, 130); assert.equal(c.strategy.name, '수급 돌파 장중 복사본');
  assert.equal((await st.create({ from: 'nope' })).status, 404);
  assert.equal((await st.create({ kind: 'weird' })).status, 400);
  assert.match((await st.archive('intraday-default')).error, /기본 전략/);
  await st.save(c.strategy.id, { enabled: true });
  assert.match((await st.archive(c.strategy.id)).error, /먼저 끄세요/);
  await st.save(c.strategy.id, { enabled: false });
  assert.equal((await st.archive(c.strategy.id)).ok, true);
  const L = await st.list(true);
  assert.equal(L.find(r => r.id === c.strategy.id).archived, true);
  assert.equal((await st.actives()).Is.length, 1);
  assert.match((await st.save(c.strategy.id, { enabled: true })).error, /보관된 전략/);
});

/* ── 두 장중 전략 동시 운영 흐름(가짜 DB·시세·텔레그램) ── */
const scr = { A: { close: 10000, ma60: 9000, ma120: 8000, sector: 'x' }, B: { close: 10000, ma60: 9000, ma120: 8000, sector: 'y' } };
const row = (code, extra = {}) => ({ code, name: code + '종목', price: 10300, open: 10000, changePct: 3, amt: 5e10, ...extra });
function multiHarness({ min = 10 * 60 + 5, paper = null } = {}) {
  const I = S.defaults('intraday'), C = S.defaults('closing');
  const Is = [{ id: 'intraday-default', name: '기본', version: 1, enabled: true, params: I, letter: 'A', T: S.timesOf(I, C) },
              { id: 'intraday-x', name: '체결강도형', version: 2, enabled: true, params: { ...I, cttrMin: 120 }, letter: 'B', T: S.timesOf(I, C) }];
  const strategies = { actives: async () => ({ Is, C: { id: 'closing-default', enabled: true, params: C } }), byId: async id => Is.find(i => i.id === id) || null, isMissing: () => false, list: async () => Is, pair: async () => ({ I: Is[0], C: { params: C }, T: Is[0].T }) };
  const runs = {}, sent = [];
  let clock = { date: '2026-11-16', min };
  const key = (d, s) => `${d}|${s}`;
  const deps = {
    strategies, paper,
    sbGet: async p => {
      if (p.startsWith('auto_config')) return [{ key: 'main', value: { on: true } }];
      if (p.startsWith('auto_runs')) {
        const d = (p.match(/trade_date=eq\.([\d-]+)/) || [])[1], s = (p.match(/strategy_id=eq\.([\w-]+)/) || [])[1];
        return Object.values(runs).filter(r => (!d || r.trade_date === d) && (!s || r.strategy_id === s)).map(r => JSON.parse(JSON.stringify(r)));
      }
      if (p.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2026-11-13' }];
      if (p.startsWith('v_screener')) return p.includes('offset=0') ? Object.entries(scr).map(([code, v]) => ({ code, ...v })) : [];
      if (p.startsWith('smx_state')) return p.includes('offset=0') ? [{ code: 'A', st: 'CONT' }, { code: 'B', st: 'CONT' }] : [];
      return [];
    },
    sbWrite: async (p, m, b) => { if (p.startsWith('auto_runs')) b.forEach(x => { runs[key(x.trade_date, x.strategy_id)] = JSON.parse(JSON.stringify(x)); }); },
    sendTelegram: async t => { sent.push(t); }, kstNow: () => clock, isTradingDay: () => true, now: () => Date.now(),
    livePool: async () => [row('A'), row('B')],
    fetchFlow: async () => ({ fq: 1000, oq: 800 }), fetchPower: async () => ({ pgQty: 200, w52: 11000 }), fetchCttr: async c => ({ cttr: c === 'A' ? 130 : 110 }),
    marketState: async () => null,
  };
  return { auto: A.createAuto(deps), runs, sent, setMin: m => { clock = { date: clock.date, min: m }; } };
}
test('두 전략이 각자 선정·기록하고, 알림은 전략별로 글자를 붙여 보낸다', async () => {
  const h = multiHarness();
  await h.auto.tick();
  assert.deepEqual(Object.keys(h.runs).sort(), ['2026-11-16|intraday-default', '2026-11-16|intraday-x']);
  assert.equal(h.runs['2026-11-16|intraday-default'].payload.picks.length, 2);    // A·B 모두
  assert.deepEqual(h.runs['2026-11-16|intraday-x'].payload.picks.map(p => p.code), ['A']);   // 체결강도 120%↑ 만
  assert.equal(h.runs['2026-11-16|intraday-x'].payload.letter, 'B');
  assert.equal(h.runs['2026-11-16|intraday-x'].strategy_version, 2);
  h.setMin(10 * 60 + 15);
  await h.auto.tick(); await h.auto.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0], /^📝가상매매 \[A · 기본\]/); assert.match(h.sent[0], /\nA1\. /); assert.match(h.sent[0], /\/매수 A1/);
  assert.match(h.sent[1], /^📝가상매매 \[B · 체결강도형\]/); assert.match(h.sent[1], /\nB1\. /);
});
test('승인: 글자 없으면 되묻고, A1 B1 은 전략별로 처리, 다시 패스하면 이미 처리됨', async () => {
  const h = multiHarness();
  await h.auto.tick(); h.setMin(10 * 60 + 15); await h.auto.tick();
  assert.match(await h.auto.handleApproval('/매수 1'), /글자를 붙여/);
  assert.match(await h.auto.handleApproval('/매수 C1'), /C 전략의 오늘 후보가 없어요/);
  assert.match(await h.auto.handleApproval('/매수 B5'), /1~1 중에서/);
  const r = await h.auto.handleApproval('/매수 A2 B1');
  assert.match(r, /\[A · 기본\][\s\S]*승인 기록: /); assert.match(r, /\[B · 체결강도형\][\s\S]*승인 기록: A/);
  assert.deepEqual(h.runs['2026-11-16|intraday-default'].payload.approved, [h.runs['2026-11-16|intraday-default'].payload.picks[1].code]);
  assert.equal(h.runs['2026-11-16|intraday-default'].status, 'approved');
  assert.deepEqual(h.runs['2026-11-16|intraday-x'].payload.approved, ['A']);
  assert.match(await h.auto.handleApproval('/패스'), /이미 처리했어요/);
});
test('승인: 한 전략만 대기 중이면 글자 없이도 되고, 사이트 승인은 전략을 지정', async () => {
  const h = multiHarness();
  await h.auto.tick(); h.setMin(10 * 60 + 15); await h.auto.tick();
  const s = await h.auto.siteApprove('pass', [], 'intraday-default');
  assert.equal(s.ok, true); assert.equal(h.runs['2026-11-16|intraday-default'].status, 'passed');
  assert.equal(h.runs['2026-11-16|intraday-x'].status, 'noticed');
  assert.match(await h.auto.handleApproval('/매수 1'), /승인 기록: A/);                  // 남은 대기 전략(B) 하나
  assert.equal(h.runs['2026-11-16|intraday-x'].status, 'approved');
  assert.match(h.sent.at(-1), /사이트에서 \[A · 기본\] 패스/);
});
test('승인 마감 뒤에는 전략별로 만료 기록', async () => {
  const h = multiHarness();
  await h.auto.tick(); h.setMin(10 * 60 + 15); await h.auto.tick();
  h.setMin(10 * 60 + 31); await h.auto.tick();
  assert.equal(h.runs['2026-11-16|intraday-default'].status, 'expired');
  assert.equal(h.runs['2026-11-16|intraday-x'].status, 'expired');
  assert.ok(h.sent.filter(t => /승인 마감/.test(t)).length === 2);
});
test('전략 삭제: 오늘 미체결 주문이 있으면 막음', async () => {
  const h = multiHarness();
  await h.auto.tick();
  h.runs['2026-11-16|intraday-x'].payload.orders = { A: { st: 'open' } };
  const r = await h.auto.deleteStrategy('intraday-x');
  assert.equal(r.ok, false); assert.match(r.error, /미체결/);
});
test('uiState: 오늘 기록을 전략별로 돌려주고 켜진 전략 목록을 함께', async () => {
  const h = multiHarness();
  await h.auto.tick();
  const s = await h.auto.uiState();
  assert.equal(s.todays.length, 2);
  assert.deepEqual(s.todays.map(t => t.sid).sort(), ['intraday-default', 'intraday-x']);
  assert.deepEqual(s.active, ['intraday-default', 'intraday-x']);
  assert.equal(s.history.length, 2);
});
test('같은 종목을 다른 전략이 이미 보유·주문 중이면 사지 않는다', async () => {
  const X = require('../auto-exec');
  const runs = { payload: { picks: [{ code: '005930', name: '삼성전자', price: 70000 }], approved: ['005930'] } };
  let placed = 0;
  const ex = X.createExec({ paper: { heldCodes: () => ['005930'], place: async () => { placed++; return { ok: false }; } }, getQuote: async () => ({ price: 70000, bids: [] }), loadChart: async () => [],
    sendTelegram: async () => {}, mutateRun: async (d, fn) => fn(runs), readRun: async () => runs, perStock: async () => 1e6, opt: async () => ({}) });
  const msg = await ex.approve('D', runs.payload);
  assert.match(msg, /이미 보유·주문 중/); assert.equal(placed, 0);
  assert.equal(runs.payload.orders['005930'].st, 'skipped');
});
