'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../auto-journal');

const D1 = '2026-11-16', D2 = '2026-11-17';
const T = (d, hm) => Date.parse(`${d}T${hm}:00+09:00`);
const fill = (id, d, hm, o) => ({ id, ts: T(d, hm), orderId: o.orderId || null, code: o.code, side: o.side, price: o.price, qty: o.qty, amount: o.price * o.qty, fee: o.fee || 0, realized: o.realized == null ? null : o.realized, reason: o.reason || 'manual' });
const run = (sid = 'intraday-default', extra = {}) => ({
  trade_date: D1, strategy_id: sid, status: 'approved',
  payload: {
    strategy: { id: sid, version: 3, name: sid === 'intraday-default' ? '수급 돌파 장중' : '체결강도형' }, letter: sid === 'intraday-default' ? 'A' : 'B', params: { stopPct: 5 },
    stat: { pool: 300, base: 20, flowPass: 6 }, picks: [{ code: 'A', name: '가나' }, { code: 'B', name: '다라' }], approved: ['A', 'B'], decision: { kind: 'buy', nums: [1, 2] },
    orders: { A: { st: 'filled', orderId: 'oA', filled: 100, avg: 10000 }, B: { st: 'filled', orderId: 'oB', filled: 50, avg: 20000 }, C: { st: 'skipped', why: '이미 보유·주문 중' } },
    shadow: [{ code: 'A', name: '가나', price: 10000, picked: true }, { code: 'B', name: '다라', price: 20000, picked: true }, { code: 'Z', name: '제트', price: 5000, picked: false }],
    eod: { at: 1, items: [{ code: 'B', name: '다라', ok: true, why: [] }], weak: [], decision: { kind: 'none' } },
    carryDone: { at: 2, codes: ['B'] }, ...extra,
  },
});
const day1Fills = () => [
  fill('f1', D1, '10:06', { orderId: 'oA', code: 'A', side: 'buy', price: 10000, qty: 100, fee: 150 }),
  fill('f2', D1, '10:07', { orderId: 'oB', code: 'B', side: 'buy', price: 20000, qty: 50, fee: 150 }),
  fill('f3', D1, '13:00', { code: 'A', side: 'sell', price: 10500, qty: 100, fee: 1890, realized: 50000, reason: 'tp1' }),
  fill('f4', D1, '11:00', { code: 'M', side: 'buy', price: 3000, qty: 10, fee: 5 }),                // 직접 매매 — 장부에서 빠져야 함
];

test('체결 귀속: 주문 id·종목으로 전략에 나누고 직접 매매는 뺀다', () => {
  const att = J.attribute(D1, [run('intraday-default'), run('intraday-x', { orders: { Q: { st: 'filled', orderId: 'oQ', filled: 5 } } })], [...day1Fills(), fill('f5', D1, '10:30', { orderId: 'oQ', code: 'Q', side: 'buy', price: 1000, qty: 5 })], [], 'closing-default');
  assert.deepEqual(att.map(f => `${f.id}:${f.sid}:${f.leg}`), ['f1:intraday-default:intraday', 'f2:intraday-default:intraday', 'f5:intraday-x:intraday', 'f3:intraday-default:intraday']);
});
test('체결 귀속: 이월 종목을 다음 날 아침 파는 체결은 종가베팅 몫, 같은 날 다시 사면 장중 몫', () => {
  const carry = [{ code: 'B', from: D1, at: T(D1, '20:00'), sid: 'intraday-default' }];
  const r2 = { ...run('intraday-default'), trade_date: D2, payload: { ...run().payload, orders: { B: { st: 'filled', orderId: 'oB2', filled: 10 } } } };
  const fills = [fill('s1', D2, '09:05', { code: 'B', side: 'sell', price: 20800, qty: 20 }), fill('b2', D2, '10:30', { orderId: 'oB2', code: 'B', side: 'buy', price: 20500, qty: 10 }), fill('s2', D2, '14:00', { code: 'B', side: 'sell', price: 20900, qty: 10 })];
  const att = J.attribute(D2, [r2], fills, carry, 'closing-default');
  assert.deepEqual(att.map(f => `${f.id}:${f.leg}`), ['s1:closing', 'b2:intraday', 's2:intraday']);
  assert.equal(att[0].sid, 'closing-default'); assert.equal(att[0].from, D1);
});
test('장중 일지: 실현 + 이월 평가(넘긴 가격) − 수수료, 이중으로 세지 않음', () => {
  const r = run(), fills = J.attribute(D1, [r], day1Fills(), [], 'closing-default').filter(f => f.sid === 'intraday-default');
  const j = J.buildIntraday({ date: D1, run: r, fills, marks: { B: 20400 }, closes: {}, prev: {}, today: D1 });
  const A = j.positions.find(p => p.code === 'A'), B = j.positions.find(p => p.code === 'B');
  assert.equal(A.pnl, 50000 - 150 - 1890); assert.equal(A.state, 'closed'); assert.equal(A.sells === undefined, true);
  assert.equal(B.carryMark, 20000); assert.equal(B.pnl, 20000 - 150); assert.equal(B.state, 'carried'); assert.equal(B.px0, 20400); assert.equal(B.px0src, 'last');
  assert.equal(j.totals.net, 50000 - 2040 + 19850); assert.equal(j.totals.cost, 2000000); assert.equal(j.totals.n, 2); assert.equal(j.totals.wins, 2);
  assert.equal(j.totals.carried, 1);
  assert.deepEqual(j.sells.map(s => s.why), ['1차 익절']);
  assert.deepEqual(j.skipped, [{ code: 'C', name: 'C', st: 'skipped', why: '이미 보유·주문 중' }]);
  assert.equal(j.funnel.bought, 2); assert.equal(j.closeFinal, false);
  assert.equal(j.positions.length, 2);   // 직접 매매 M 은 없음
});
test('장중 일지: 공식 종가가 오면 넘긴 가격을 종가로 바꾸고 그림자 비교·확정', () => {
  const r = run(), fills = J.attribute(D1, [r], day1Fills(), [], 'closing-default').filter(f => f.sid === 'intraday-default');
  const j1 = J.buildIntraday({ date: D1, run: r, fills, marks: { B: 20400 }, prev: {}, today: D1 });
  const j2 = J.buildIntraday({ date: D1, run: r, fills, marks: {}, closes: { A: 10600, B: 20200, Z: 5500 }, prev: { px0: j1.px0, src: j1.px0src }, today: D2 });
  const B = j2.positions.find(p => p.code === 'B');
  assert.equal(B.px0, 20200); assert.equal(B.px0src, 'close'); assert.equal(B.carryMark, 10000);
  assert.equal(j2.closeFinal, true);
  assert.equal(+j2.shadow.all.toFixed(2), +(((10600 / 10000 - 1) + (20200 / 20000 - 1) + (5500 / 5000 - 1)) / 3 * 100).toFixed(2));
  assert.equal(+j2.shadow.picked.toFixed(2), +(((0.06) + (0.01)) / 2 * 100).toFixed(2));
  // 종가가 없고 이전 값이 있으면 이전 값 유지(마킹이 흔들리지 않음)
  const j3 = J.buildIntraday({ date: D1, run: r, fills, marks: { B: 99999 }, closes: {}, prev: { px0: j1.px0, src: j1.px0src }, today: D1 });
  assert.equal(j3.positions.find(p => p.code === 'B').px0, 20400);
  // 처음 값이 평균가(시세 없음)였다면 이후 시세로 갱신
  const j0 = J.buildIntraday({ date: D1, run: r, fills, marks: {}, prev: {}, today: D1 }), j4 = J.buildIntraday({ date: D1, run: r, fills, marks: { B: 20300 }, prev: { px0: j0.px0, src: j0.px0src }, today: D1 });
  assert.equal(j0.positions.find(p => p.code === 'B').px0src, 'avg'); assert.equal(j4.positions.find(p => p.code === 'B').px0, 20300);
});
test('종가베팅 일지: 넘겨받은 가격 기준 손익 · 수량 한도 · 손절·분할 사유', () => {
  const item = { code: 'B', name: '다라', q0: 50, avg: 20000, px0: 20400, at: T(D1, '20:00'), sid: 'intraday-default', state: 'done', log: [{ cut: true }] };
  const sells = [fill('s1', D2, '09:05', { code: 'B', side: 'sell', price: 20800, qty: 20, fee: 40 }), fill('s2', D2, '09:10', { code: 'B', side: 'sell', price: 20600, qty: 40, fee: 80 })];
  const c = J.buildClosing({ date: D1, items: [item], sells, strategy: { id: 'closing-default', version: 1, name: '종가베팅' } });
  assert.equal(c.positions[0].sellQty, 50);   // 40주 체결 중 30주만 인정(남은 수량 한도)
  assert.equal(c.sells.length, 2); assert.equal(c.sells[1].qty, 30); assert.equal(c.sells[1].fee, 60);
  assert.equal(c.totals.net, (20800 - 20400) * 20 + (20600 - 20400) * 30 - 100);
  assert.equal(c.totals.cost, 20400 * 50); assert.equal(c.state, 'done'); assert.equal(c.positions[0].gapCut, true);
  assert.equal(c.positions[0].vsCost, +(((20800 * 20 + 20600 * 30) / 50 / 20000 - 1) * 100).toFixed(2));
  // 아직 덜 판 경우 열린 상태
  const o = J.buildClosing({ date: D1, items: [{ ...item, state: 'selling', log: [] }], sells: [sells[0]], strategy: null });
  assert.equal(o.state, 'open'); assert.equal(o.totals.left, 30); assert.equal(o.positions[0].gapCut, false);
  // 손절 사유
  const st = J.buildClosing({ date: D1, items: [{ ...item, state: 'done', log: [] }], sells: [fill('s3', D2, '09:01', { code: 'B', side: 'sell', price: 19000, qty: 50, fee: 50, reason: 'stop' })], strategy: null });
  assert.equal(st.sells[0].why, '손절(이월 중)'); assert.equal(st.totals.net, (19000 - 20400) * 50 - 50);
});
test('성과 집계: 누적·승률·손익비·최대낙폭·버전별·그림자', () => {
  const mk = (d, sid, ver, net, cost, pos, shadow) => ({ trade_date: d, strategy_id: sid, strategy_name: sid, kind: 'intraday', strategy_version: ver, status: 'final', net, cost, pos, shadow });
  const rows = [
    mk('2026-11-16', 's1', 1, 30000, 1000000, [{ pnl: 50000 }, { pnl: -20000 }], { all: 1, picked: 2, bought: 3 }),
    mk('2026-11-17', 's1', 1, -60000, 1000000, [{ pnl: -60000 }], { all: 3, picked: 4, bought: 5 }),
    mk('2026-11-18', 's1', 2, 40000, 2000000, [{ pnl: 40000 }, { pnl: 0 }], null),
  ];
  const p = J.summarize(rows), s = p.strategies[0];
  assert.deepEqual(s.curve.map(c => c.cum), [30000, -30000, 10000]);
  assert.equal(s.net, 10000); assert.equal(s.cost, 4000000); assert.equal(s.pct, 0.25);
  assert.equal(s.n, 5); assert.equal(s.wins, 2); assert.equal(s.losses, 2); assert.equal(s.winRate, 40);
  assert.equal(s.avgWin, 45000); assert.equal(s.avgLoss, -40000); assert.equal(s.payoff, 1.13);
  assert.equal(s.maxDrawdown, 60000);
  assert.deepEqual(s.byVersion.map(v => [v.version, v.days, v.net]), [[1, 2, -30000], [2, 1, 40000]]);
  assert.deepEqual(s.shadow, { n: 2, all: 2, picked: 3, bought: 4 });
  assert.deepEqual(p.combined.map(c => c.cum), [30000, -30000, 10000]);
  assert.equal(J.summarize([]).strategies.length, 0);
});
test('텔레그램 요약 문구', () => {
  const r = run(), fills = J.attribute(D1, [r], day1Fills(), [], 'closing-default').filter(f => f.sid === 'intraday-default');
  const j = J.buildIntraday({ date: D1, run: r, fills, marks: { B: 20400 }, prev: {}, today: D1 });
  const t = J.daySummaryText(D1, [j]);
  assert.match(t, /11\/16 자동매매 일지/); assert.match(t, /A · 수급 돌파 장중/); assert.match(t, /매수 2종목/); assert.match(t, /이월 1종목\(평가 \+20,000원\)/); assert.match(t, /순손익 \+67,810원/);
  assert.match(t, /가나 \+47,960원/);
  const e = J.daySummaryText(D1, [{ ...j, totals: { ...j.totals, n: 0 }, decision: { kind: 'pass' } }]);
  assert.match(e, /매수 없음 \(패스\)/);
});

/* ── 흐름: 가짜 DB 로 15:40 작성 → 전환 후 반영 → 다음 날 확정 · 메모 보존 · 텔레그램 한 번 ── */
function harness() {
  const db = { auto_journal: [], paper_fills: [...day1Fills(),
    fill('s1', D2, '09:05', { code: 'B', side: 'sell', price: 20800, qty: 20, fee: 40 }), fill('s2', D2, '09:10', { code: 'B', side: 'sell', price: 20600, qty: 30, fee: 60 })], daily_price: [] };
  const tg = [];
  const carry = { items: { B: { code: 'B', name: '다라', q0: 50, avg: 20000, from: D1, at: T(D1, '20:00'), sid: 'intraday-default', state: 'wait' } } };
  const runs = { [D1]: [run()] };
  const io = {
    sbGet: async p => {
      const [tb, qs] = p.split('?'), q = new URLSearchParams(qs);
      if (tb === 'paper_fills') {
        let r = db.paper_fills.map(f => ({ ...f, ts: new Date(f.ts).toISOString(), order_id: f.orderId }));
        for (const v of q.getAll('ts')) { const i = v.indexOf('.'), op = v.slice(0, i), x = v.slice(i + 1); r = r.filter(f => op === 'gte' ? Date.parse(f.ts) >= Date.parse(x) : Date.parse(f.ts) < Date.parse(x)); }
        if (q.get('side')) r = r.filter(f => f.side === q.get('side').slice(3));
        if (q.get('code')) { const set = q.get('code').slice(4).replace(/[()]/g, '').split(','); r = r.filter(f => set.includes(f.code)); }
        return r;
      }
      if (tb === 'daily_price') { const d = q.get('trade_date').slice(3); return db.daily_price.filter(x => x.trade_date === d); }
      if (tb === 'auto_journal') {
        let r = db.auto_journal.map(x => JSON.parse(JSON.stringify(x)));
        const f = (k, fn) => { if (q.get(k)) r = r.filter(x => fn(x, q.get(k))); };
        f('trade_date', (x, v) => v.startsWith('eq.') ? x.trade_date === v.slice(3) : v.startsWith('lt.') ? x.trade_date < v.slice(3) : v.startsWith('gte.') ? x.trade_date >= v.slice(4) : x.trade_date <= v.slice(4));
        f('status', (x, v) => v.replace(/^in\.\(|\)$/g, '').split(',').includes(x.status));
        f('strategy_id', (x, v) => x.strategy_id === v.slice(3));
        r.sort((a, b) => a.trade_date < b.trade_date ? 1 : -1);
        return r.map(x => ({ ...x, pos: x.payload.positions, shadow: x.payload.shadow }));
      }
      return [];
    },
    sbWrite: async (p, m, b) => {
      if (p.startsWith('auto_journal?on_conflict')) b.forEach(x => { const i = db.auto_journal.findIndex(r => r.trade_date === x.trade_date && r.strategy_id === x.strategy_id); if (i >= 0) db.auto_journal[i] = { ...db.auto_journal[i], ...x }; else db.auto_journal.push({ memo: '', ...x }); });
      else if (p.startsWith('auto_journal?') && m === 'PATCH') { const q = new URLSearchParams(p.split('?')[1]); db.auto_journal.forEach(r => { if (r.trade_date === q.get('trade_date').slice(3) && r.strategy_id === q.get('strategy_id').slice(3)) Object.assign(r, b); }); }
    },
    sendTelegram: async t => { tg.push(t); },
    paper: { state: async () => ({ ok: true, positions: [{ code: 'B', qty: 50, last: 20400 }] }) },
    readRuns: async d => runs[d] || [], readCarry: async () => carry,
    actives: async () => ({ Is: [], C: { id: 'closing-default', version: 2, name: '장중 강세 이월', enabled: true } }),
    now: (() => { let t = 1_800_000_000_000; return () => (t += 1000); })(),
  };
  return { db, tg, carry, io, runs };
}
test('일지 흐름: 15:40 작성(텔레그램 1회) → 20:05 반영 → 다음 날 종가베팅 결과로 확정, 메모 보존', async () => {
  const h = harness(), jr = J.createJournal(h.io);
  // 15:40 — 아직 전환 전: 이월 대기
  let r = await jr.tick(D1, 15 * 60 + 40, 1200);
  assert.equal(r.ok, true); assert.equal(r.day.sent, 1);
  assert.equal(h.tg.length, 1); assert.match(h.tg[0], /일지/);
  let rows = h.db.auto_journal;
  assert.equal(rows.length, 2);   // 장중 전략 + 종가베팅(이월 항목이 있으므로)
  const intra = rows.find(x => x.kind === 'intraday'), clo = rows.find(x => x.kind === 'closing');
  assert.equal(intra.status, 'draft');
  assert.equal(intra.net, 47960 + 19850); assert.equal(intra.strategy_name, '수급 돌파 장중'); assert.equal(intra.strategy_version, 3);
  assert.equal(clo.status, 'final');   // 이 시나리오는 다음 날 매도가 이미 체결돼 있어 바로 끝남(아래에서 다시 확인)
  // 메모
  assert.equal((await jr.memo(D1, 'intraday-default', '장 초반 강세 — 다음엔 비중↓')).ok, true);
  assert.equal(h.db.auto_journal.find(x => x.kind === 'intraday').memo, '장 초반 강세 — 다음엔 비중↓');
  // 20:05 — 같은 시각 다시 호출해도 텔레그램은 더 안 감, 메모는 그대로
  await jr.tick(D1, 20 * 60 + 5, 1200);
  assert.equal(h.tg.length, 1);
  assert.equal(h.db.auto_journal.find(x => x.kind === 'intraday').memo, '장 초반 강세 — 다음엔 비중↓');
  // 다음 날 09:20 — 공식 종가 도착 → 넘긴 가격 갱신·확정 + 종가베팅 결과 텔레그램 1회
  h.db.daily_price.push({ trade_date: D1, code: 'A', close: 10600 }, { trade_date: D1, code: 'B', close: 20200 }, { trade_date: D1, code: 'Z', close: 5500 });
  r = await jr.tick(D2, 9 * 60 + 20, 1200);
  assert.equal(r.ok, true); assert.equal(r.finish.length, 1);
  const i2 = h.db.auto_journal.find(x => x.kind === 'intraday'), c2 = h.db.auto_journal.find(x => x.kind === 'closing');
  assert.equal(i2.status, 'final'); assert.equal(i2.payload.positions.find(p => p.code === 'B').px0, 20200);
  assert.equal(i2.net, 47960 + (20200 - 20000) * 50 - 150);
  assert.equal(c2.status, 'final'); assert.equal(c2.net, (20800 - 20200) * 20 + (20600 - 20200) * 30 - 100);
  assert.equal(c2.strategy_id, 'closing-default'); assert.equal(c2.strategy_version, 2);
  assert.equal(h.tg.length, 2); assert.match(h.tg[1], /이월분 종가베팅 결과/);
  // 이미 확정된 날은 다시 일하지 않음(과거 확정 일지는 목록 조회 대상에서 빠짐)
  const before = JSON.stringify(h.db.auto_journal);
  await jr.tick(D2, 9 * 60 + 40, 1200);
  assert.equal(h.tg.length, 2); assert.equal(JSON.stringify(h.db.auto_journal), before);
});
test('일지 흐름: 다음 날 매도가 덜 끝났으면 open, 이후 다 팔리면 확정', async () => {
  const h = harness(); h.db.paper_fills = h.db.paper_fills.filter(f => f.id !== 's2');
  const jr = J.createJournal(h.io);
  await jr.generateDay(D1, { today: D1, min: 15 * 60 + 40, phase: 1 });
  let c = h.db.auto_journal.find(x => x.kind === 'closing');
  assert.equal(c.status, 'open'); assert.equal(c.payload.totals.left, 30);
  await jr.generateDay(D1, { today: D2, min: 9 * 60 + 20, phase: 3 });
  assert.equal(h.db.auto_journal.find(x => x.kind === 'closing').status, 'open'); assert.equal(h.tg.length, 1);   // 요약만 나가고 결과는 아직
  h.db.paper_fills.push(fill('s2', D2, '09:15', { code: 'B', side: 'sell', price: 20600, qty: 30, fee: 60 }));
  await jr.generateDay(D1, { today: D2, min: 9 * 60 + 40, phase: 3 });
  assert.equal(h.db.auto_journal.find(x => x.kind === 'closing').status, 'final'); assert.equal(h.tg.length, 2);
});
test('일지 목록·상세·메모 검증 · 다시 만들기 · 테이블 없음', async () => {
  const h = harness(), jr = J.createJournal(h.io);
  assert.equal((await jr.run('2030-01-01', D2)).status, 400);
  assert.equal((await jr.run(D2, D2)).status, 404);   // 그날 기록 없음
  const r = await jr.run(D1, D2);
  assert.equal(r.ok, true); assert.equal(h.tg.length, 0);   // 다시 만들기는 텔레그램 없음
  const L = await jr.list({});
  assert.equal(L.rows.length, 2); assert.equal(L.perf.strategies.length, 2); assert.equal(L.rows[0].hasMemo, false);
  assert.equal((await jr.list({ sid: 'closing-default' })).rows.length, 1);
  const G = await jr.get(D1, 'intraday-default');
  assert.equal(G.journals.length, 1); assert.equal(G.journals[0].payload.kind, 'intraday');
  assert.equal((await jr.get('bad', null)).status, 400);
  assert.equal((await jr.memo(D1, 'nope-x', 'a')).status, 404);
  assert.equal((await jr.memo(D1, 'intraday-default', 123)).status, 400);
  const long = await jr.memo(D1, 'intraday-default', 'x'.repeat(2500));
  assert.equal(long.memo.length, J.MEMO_MAX); assert.equal(long.truncated, true);
  // 테이블 없음: 목록은 빈 값, tick 은 조용히 쉼
  const miss = J.createJournal({ ...h.io, sbGet: async () => { throw new Error('auto_journal 404 PGRST205'); } });
  assert.deepEqual((await miss.list({})).rows, []);
  const t = await miss.tick(D1, 15 * 60 + 40, 1200);
  assert.equal(t.ok, false); assert.match(t.err, /auto_journal/);
  assert.equal((await miss.tick(D1, 15 * 60 + 45, 1200)).idle, 'no-table');
});
test('매수가 없던 날: 일지는 만들되 텔레그램은 보내지 않는다', async () => {
  const h = harness(); h.runs[D1] = [run('intraday-default', { orders: {}, decision: { kind: 'pass' }, carryDone: undefined, eod: undefined })]; h.carry.items = {};
  const jr = J.createJournal(h.io);
  await jr.tick(D1, 15 * 60 + 40, 1200);
  assert.equal(h.tg.length, 0); assert.equal(h.db.auto_journal.length, 1); assert.equal(h.db.auto_journal[0].net, 0);
  assert.equal(h.db.auto_journal[0].payload.decision.kind, 'pass');
});

/* ── createAuto.tick 가 15:40 이후 일지를 부른다(자동매매 스위치가 꺼져 있어도) ── */
test('tick: 15:40 이후 일지 작성이 호출되고 스위치가 꺼져 있어도 동작', async () => {
  const h = harness();
  const A = require('../auto');
  const calls = [];
  const io = { ...h.io, sbGet: async p => { calls.push(p.split('?')[0]); if (p.startsWith('auto_runs')) return h.runs[D1] || []; if (p.startsWith('auto_config')) return [{ value: p.includes('key=eq.carry') ? h.carry : { on: false } }]; return h.io.sbGet(p); },
    kstNow: () => ({ date: D1, min: 15 * 60 + 41 }), isTradingDay: () => true, forceEnabled: false, paper: undefined };
  const auto = A.createAuto(io);
  const r = await auto.tick();
  assert.equal(r.ok, true); assert.ok(r.journal, '일지 호출됨'); assert.equal(r.journal.ok, true);
  assert.equal(h.db.auto_journal.length >= 1, true);
  assert.ok(calls.includes('auto_runs'));
  assert.equal(h.tg.length, 1);
  // 같은 시각 다시 tick — 일을 또 하지 않음
  const n = h.db.auto_journal.length; await auto.tick(); assert.equal(h.tg.length, 1); assert.equal(h.db.auto_journal.length, n);
  // 사이트용 조회·메모 연결
  const L = await auto.journalList({}); assert.equal(L.ok, true);
  assert.equal((await auto.journalMemo(D1, 'intraday-default', '메모')).ok, true);
});
