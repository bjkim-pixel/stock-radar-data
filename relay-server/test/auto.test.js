'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../auto');

const scr = { E: { close: 110, ma60: 100, ma120: 90, sector: '2차전지' }, F: { close: 110, ma60: 100, ma120: 90, sector: '화학' }, A: { close: 110, ma60: 100, ma120: 90, sector: '반도체', rs20_pctl: 90 }, B: { close: 95, ma60: 100, ma120: 90, sector: '반도체' }, C: { close: 110, ma60: 100, ma120: 90, sector: '반도체' }, D: { close: 110, ma60: 100, ma120: 90, sector: '2차전지' } };
const smx = { E: 'CONT', F: 'CONT', A: 'CONT', B: 'CONT', C: 'LEAVE', D: 'STALL' };
const row = (code, o = {}) => ({ code, name: '종목' + code, price: 10500, open: 10000, changePct: 3, amt: 1e11, ...o });

test('1차 필터: 정배열(종가>60>120)·매집(CONT/STALL)·상승·시가대비 +8% 이하', () => {
  const r = A.baseFilter([row('A'), row('B'), row('C'), row('D')], scr, smx, new Set());
  assert.deepEqual(r.map(x => x.code), ['A', 'D']);
});
test('시가 대비 +8% 초과·하락 종목·ETF·보유 종목 제외', () => {
  assert.equal(A.baseFilter([row('A', { price: 10900 })], scr, smx, new Set()).length, 0);     // +9%
  assert.equal(A.baseFilter([row('A', { price: 10800 })], scr, smx, new Set()).length, 1);     // +8% 경계는 통과
  assert.equal(A.baseFilter([row('A', { changePct: -1 })], scr, smx, new Set()).length, 0);
  assert.equal(A.baseFilter([row('A', { name: 'KODEX 반도체' })], scr, smx, new Set()).length, 0);
  assert.equal(A.baseFilter([row('A')], scr, smx, new Set(['A'])).length, 0);
});
test('수급 판정: 외·기·프 모두 순매수 + 체결강도 100%↑', () => {
  const c = row('A');
  const ok = A.evalFlow(c, { fq: 1000, oq: 500 }, { pgQty: 300, w52: 11000 }, { cttr: 120 });
  assert.equal(ok.pass, true);
  assert.equal(ok.m.fAmt, 1000 * 10500);
  assert.equal(A.evalFlow(c, { fq: 1000, oq: -5 }, { pgQty: 300 }, { cttr: 120 }).pass, false);
  assert.equal(A.evalFlow(c, { fq: 1000, oq: 5 }, { pgQty: 0 }, { cttr: 120 }).pass, false);
  assert.equal(A.evalFlow(c, { fq: 1000, oq: 5 }, { pgQty: 3 }, { cttr: 99.5 }).pass, false);
  assert.match(A.evalFlow(c, { err: 'x' }, { pgQty: 3 }, { cttr: 120 }).fails.join(), /외국인 수급 없음/);   // 조회 실패는 통과시키지 않음
  assert.equal(A.evalFlow(c, { fq: 1, oq: 1 }, { pgQty: 1 }, { cttr: 100 }).pass, true);                     // 100% 경계는 통과
});
test('점수: 0~100, 수급·체결강도가 클수록 높고 상승률 구간 반영', () => {
  const c = { ...row('A'), rs20: 100 };
  const big = A.scoreOne({ ...c, kw8: 0.6 }, { fAmt: 4e9, oAmt: 4e9, pAmt: 4e9, cttr: 150, w52: 10500 }, 1);
  assert.ok(big.total > 95 && big.total <= 100, big.total);
  const small = A.scoreOne({ ...c, changePct: 9 }, { fAmt: 1e8, oAmt: 1e8, pAmt: 1e8, cttr: 100, w52: 20000 }, 0);
  assert.ok(small.total < 40, small.total);
  assert.equal(A.scoreOne({ ...c, changePct: 3 }, { fAmt: 0, oAmt: 0, pAmt: 0, cttr: 100 }, 0).parts.rise, 15);
  assert.equal(A.scoreOne({ ...c, changePct: 0.5 }, { cttr: 100 }, 0).parts.rise, 7.5);
});
test('업종당 2종목까지, 점수순 상위 N', () => {
  const mk = (code, sector, t) => ({ code, sector, score: { total: t } });
  const r = A.rankAndPick([mk('a', 'X', 90), mk('b', 'X', 80), mk('c', 'X', 70), mk('d', 'Y', 60)], 3);
  assert.deepEqual(r.pick.map(x => x.code), ['a', 'b', 'd']);
  assert.equal(r.dropped[0].code, 'c');
});
test('승인 명령 파싱', () => {
  assert.deepEqual(A.parseApproval('/매수 1 3 5', 5), { kind: 'buy', nums: [1, 3, 5] });
  assert.deepEqual(A.parseApproval('/매수 1,3', 5), { kind: 'buy', nums: [1, 3] });
  assert.deepEqual(A.parseApproval('/매수 전체', 4), { kind: 'buy', nums: [1, 2, 3, 4] });
  assert.deepEqual(A.parseApproval('/패스', 4), { kind: 'pass' });
  assert.deepEqual(A.parseApproval('/매수 9', 5), { kind: 'bad' });
  assert.equal(A.parseApproval('안녕', 5), null);
});
test('메시지: 후보 없음·쉬는 날·후보 목록', () => {
  assert.match(A.formatMessage('2026-11-16', [], {}), /후보 없음/);
  const p = { code: '000001', name: '가나다', price: 10500, open: 10000, changePct: 5, sector: '반도체', m: { cttr: 130, fAmt: 5e9, oAmt: 3e9, pAmt: 2e9 }, score: { total: 88.5, ratio: 0.1 }, reasons: ['수급 외·기·프 동시'] };
  const t = A.formatMessage('2026-11-16', [p], { warn: '코스피 -1.20%' });
  assert.match(t, /1\. 가나다\(000001\) 88\.5점/); assert.match(t, /\/매수 1 3 5/); assert.match(t, /코스피 -1\.20%/);
});

/* ── 흐름 테스트(가짜 DB·시세·텔레그램) ── */
function harness({ min = 10 * 60 + 5, on = true, trading = true, params = null, kw = {} } = {}) {
  const db = { auto_runs: {}, auto_config: { main: { on, perStockKrw: 1000000 } } };
  const sent = [];
  let pool = ['A', 'B', 'C', 'D'];
  let flowFn = () => ({ fq: 1000, oq: 800 });
  let clock = { date: '2026-11-16', min };
  const deps = {
    sbGet: async path => {
      if (path.startsWith('auto_config')) return [{ key: 'main', value: db.auto_config.main }];
      if (path.startsWith('auto_strategies')) return [];   // 전략 테이블 비어 있음 = 기본 전략
      if (path.startsWith('auto_runs')) { const d = (path.match(/trade_date=eq\.([\d-]+)/) || [])[1]; return db.auto_runs[d] ? [db.auto_runs[d]] : []; }
      if (path.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2026-11-13' }];
      if (path.startsWith('v_screener')) return path.includes('offset=0') ? Object.entries(scr).map(([code, v]) => ({ code, ...v })) : [];
      if (path.startsWith('smx_state')) return path.includes('offset=0') ? Object.entries(smx).filter(([, v]) => v === 'CONT' || v === 'STALL').map(([code, st]) => ({ code, st })) : [];
      if (path.startsWith('positions')) return [];
      if (path.startsWith('v_kiwoom_accounts')) return path.includes('offset=0') ? Object.entries(kw).map(([code, snaps]) => ({ code, snaps })) : [];
      throw new Error('unexpected ' + path);
    },
    sbWrite: async (path, method, body) => { if (path.startsWith('auto_runs')) body.forEach(b => { db.auto_runs[b.trade_date] = b; }); },
    sendTelegram: async t => { sent.push(t); },
    kstNow: () => clock, isTradingDay: () => trading,
    livePool: async () => pool.map(c => row(c, c === 'D' ? { amt: 2e11 } : {})),
    fetchFlow: async c => flowFn(c), fetchPower: async c => ({ pgQty: 200, w52: 11000 }), fetchCttr: async c => ({ cttr: 125 }),
    marketState: async () => null,
  };
  if (params) { const ST = require('../auto-strategy'), P = { ...ST.defaults('intraday'), ...params }, C = ST.defaults('closing'); deps.strategies = { pair: async () => ({ I: { id: 'intraday-default', name: '기본', version: 1, enabled: true, params: P }, C: { id: 'closing-default', version: 1, enabled: true, params: C }, T: ST.timesOf(P, C) }) }; }
  return { A: A.createAuto(deps), db, sent, setFlow: f => { flowFn = f; }, setPool: p => { pool = p; }, setMin: m => { clock = { date: clock.date, min: m }; } };
}

test('10:05 선정 → 기록, 10:15 알림 1회, 재호출은 중복 발송 없음', async () => {
  const h = harness();
  const r1 = await h.A.tick();
  assert.equal(r1.sel.ok, true);
  assert.equal(h.sent.length, 0);                          // 10:05 에는 알림 없음
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'selected');
  assert.equal(h.db.auto_runs['2026-11-16'].payload.picks.length, 2);   // A, D
  h.setMin(10 * 60 + 15);
  await h.A.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /자동매매 후보/);
  await h.A.tick(); await h.A.tick();
  assert.equal(h.sent.length, 1);                          // 중복 없음
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'noticed');
});
test('서버 재시작(상태 초기화) 후에도 오늘 기록이 있으면 다시 선정하지 않음', async () => {
  const h = harness();
  await h.A.tick();
  const h2 = harness(); h2.db.auto_runs = h.db.auto_runs;
  const r = await h2.A.tick();
  assert.equal(r.sel.skipped, true);
});
test('10:20 에 처음 깨어나도 선정과 알림을 보완 실행(깨우기 10분 간격 대비)', async () => {
  const h = harness({ min: 10 * 60 + 20 });
  await h.A.tick();
  assert.equal(h.sent.length, 1);
});
test('꺼짐·휴장일·시간 창 밖에서는 아무 것도 하지 않음', async () => {
  for (const o of [{ on: false }, { trading: false }, { min: 9 * 60 }, { min: 11 * 60 + 1 }]) {
    const h = harness(o);
    await h.A.tick();
    assert.equal(h.sent.length, 0); assert.equal(Object.keys(h.db.auto_runs).length, 0);
  }
});
test('승인 기록: 매수 번호·패스·중복·마감', async () => {
  const h = harness();
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  const m1 = await h.A.handleApproval('/매수 1 2');
  assert.match(m1, /승인 기록/);
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'approved');
  assert.equal(h.db.auto_runs['2026-11-16'].payload.approved.length, 2);
  assert.match(await h.A.handleApproval('/패스'), /이미 처리/);
  const h2 = harness(); await h2.A.tick(); h2.setMin(10 * 60 + 15); await h2.A.tick();
  assert.match(await h2.A.handleApproval('/매수 7'), /번호를 확인/);
  h2.setMin(10 * 60 + 31); assert.match(await h2.A.handleApproval('/매수 1'), /마감/);
  const h3 = harness(); await h3.A.tick(); h3.setMin(10 * 60 + 15); await h3.A.tick();
  assert.match(await h3.A.handleApproval('/패스'), /패스/); assert.equal(h3.db.auto_runs['2026-11-16'].status, 'passed');
});
test('사이트 승인: 마감이 지나도 진행(텔레그램은 마감) · 만료 기록도 되살림 · 15:20 이후는 거절', async () => {
  const h = harness(); await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  h.setMin(10 * 60 + 31);                                  // 승인 마감(10:30) 지남 → 텔레그램은 거절
  assert.match(await h.A.handleApproval('/매수 1'), /마감/);
  const r = await h.A.siteApprove('buy', [1], null);        // 사이트는 진행
  assert.equal(r.ok, true); assert.doesNotMatch(r.reply, /마감/);
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'approved');
  const h2 = harness(); await h2.A.tick(); h2.setMin(10 * 60 + 15); await h2.A.tick();
  h2.setMin(10 * 60 + 31); await h2.A.tick();               // 틱이 만료 처리
  assert.equal(h2.db.auto_runs['2026-11-16'].status, 'expired');
  const r2 = await h2.A.siteApprove('buy', [1], null);
  assert.equal(r2.ok, true); assert.equal(h2.db.auto_runs['2026-11-16'].status, 'approved');
  const h3 = harness(); await h3.A.tick(); h3.setMin(10 * 60 + 15); await h3.A.tick();
  h3.setMin(15 * 60 + 21);
  assert.match((await h3.A.siteApprove('buy', [1], null)).reply, /장 마감이 가까워/);
});
test('단계 버튼: 후보 선정은 알림까지 이어지고, 승인·주문이 시작되면 다시 고르지 않음', async () => {
  const h = harness({ min: 9 * 60 + 40 });
  const sid = 'intraday-default';
  const r = await h.A.siteStage('select', sid);
  assert.equal(r.ok, true); assert.equal(h.db.auto_runs['2026-11-16'].status, 'noticed'); assert.ok(h.sent.length >= 1);
  assert.equal((await h.A.siteStage('bogus', sid)).ok, false);
  await h.A.siteApprove('buy', [1], sid);
  assert.match((await h.A.siteStage('select', sid)).reply, /다시 고를 수 없어요|이미 승인/);
});
test('그림자 기록: 조건 통과 전체가 점수와 함께 남고 알림 대상 표시', async () => {
  const h = harness(); await h.A.tick();
  const sh = h.db.auto_runs['2026-11-16'].payload.shadow;
  assert.equal(sh.length, 2); assert.ok(sh.every(s => typeof s.score === 'number' && s.parts && s.m));
});
test('수급 조건 미달 종목은 후보 제외, 모두 미달이면 "후보 없음" 알림', async () => {
  const h = harness();
  h.A = A.createAuto({ ...{}, sbGet: async p => (p.startsWith('auto_config') ? [{ value: { on: true } }] : p.startsWith('auto_runs') ? (h.db.auto_runs['2026-11-16'] ? [h.db.auto_runs['2026-11-16']] : []) : p.startsWith('v_screener?select=trade_date') ? [{ trade_date: 'x' }] : p.startsWith('v_screener') ? (p.includes('offset=0') ? Object.entries(scr).map(([code, v]) => ({ code, ...v })) : []) : p.startsWith('smx_state') ? (p.includes('offset=0') ? [{ code: 'A', st: 'CONT' }] : []) : []),
    sbWrite: async (p, m, b) => { b.forEach(x => { h.db.auto_runs[x.trade_date] = x; }); }, sendTelegram: async t => h.sent.push(t),
    kstNow: () => ({ date: '2026-11-16', min: 10 * 60 + 16 }), isTradingDay: () => true, livePool: async () => [row('A')],
    fetchFlow: async () => ({ fq: -5, oq: 3 }), fetchPower: async () => ({ pgQty: 1 }), fetchCttr: async () => ({ cttr: 130 }), marketState: async () => null });
  await h.A.tick();
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /후보 없음/);
});

/* ── 장중 반복 검토 ── */
test('반복 검토: 30분 뒤 새 후보만 이어 붙이고 번호를 이어서 알림', async () => {
  const h = harness();
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  assert.equal(h.sent.length, 1);
  h.setPool(['A', 'B', 'C', 'D', 'E']);
  h.setMin(10 * 60 + 30); await h.A.tick();
  assert.equal(h.sent.length, 1);                                  // 아직 10:35 전
  h.setMin(10 * 60 + 35);
  const r = await h.A.tick();
  assert.equal(r.round.fresh, 1);
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual(P.picks.map(p => p.code).sort(), ['A', 'D', 'E']); assert.equal(P.picks[2].code, 'E');      // 기존 A·D 는 다시 넣지 않음
  assert.equal(P.picks[2].round, 2); assert.equal(P.roundN, 2); assert.ok(P.picks[0].closed && !P.picks[2].closed);   // 이전 회차(만료) 후보는 닫힘
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'noticed');
  const notes = h.sent.filter(t => /^📈 자동매매 후보/.test(t));
  assert.equal(notes.length, 2);
  assert.match(notes[1], /2회차/); assert.match(notes[1], /\n3\. 종목E/); assert.match(notes[1], /\/매수 3 \(번호\)/);
  assert.ok(P.log.some(l => l.k === 'round' && /새 후보 1개/.test(l.text)));
  await h.A.tick(); await h.A.tick();
  assert.equal(h.sent.filter(t => /^📈 자동매매 후보/.test(t)).length, 2);   // 같은 회차 중복 없음
  const m = await h.A.handleApproval('/매수 1');
  assert.match(m, /이전 회차/);                                       // 닫힌 후보는 살 수 없음
});
test('반복 검토: 새 후보가 없으면 알리지 않고 기록만 남김', async () => {
  const h = harness();
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  h.setMin(10 * 60 + 35); await h.A.tick();
  assert.equal(h.sent.filter(t => /^📈 자동매매 후보/.test(t)).length, 1);
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.equal(P.picks.length, 2); assert.equal(P.roundN, 2);
  assert.ok(P.log.some(l => l.k === 'round' && /새 후보 없음/.test(l.text)));
});
test('반복 검토: 하루 최대 매수 종목 수를 채우면 건너뜀', async () => {
  const h = harness();
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  const P0 = h.db.auto_runs['2026-11-16'].payload;
  P0.orders = Object.fromEntries(['X1', 'X2', 'X3', 'X4', 'X5'].map(c => [c, { orderId: c, st: 'open' }]));
  h.setPool(['A', 'B', 'C', 'D', 'E']); h.setMin(10 * 60 + 35); await h.A.tick();
  assert.equal(h.sent.filter(t => /^📈 자동매매 후보/.test(t)).length, 1);
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.equal(P.picks.length, 2);
  assert.ok(P.log.some(l => l.k === 'round' && /건너뜀/.test(l.text)));
});
test('반복 검토: 마지막 검토 시각(14:30) 뒤에는 돌지 않고, 첫 선정은 예전처럼 11:00 까지만', async () => {
  const h = harness();
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  h.setPool(['A', 'B', 'C', 'D', 'E']); h.setMin(14 * 60 + 40); await h.A.tick();
  assert.equal(h.db.auto_runs['2026-11-16'].payload.picks.length, 2);
  const h2 = harness({ min: 11 * 60 + 30 }); await h2.A.tick();
  assert.equal(Object.keys(h2.db.auto_runs).length, 0);
});
test('반복 검토 + 자동 승인: 새 후보도 알림 직후 자동으로 승인 기록', async () => {
  const h = harness({ params: { approval: 'auto' } });
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  assert.deepEqual(h.db.auto_runs['2026-11-16'].payload.approved.slice().sort(), ['A', 'D']);
  h.setPool(['A', 'B', 'C', 'D', 'E']); h.setMin(10 * 60 + 35); await h.A.tick();
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual(P.approved.slice().sort(), ['A', 'D', 'E']);     // 이전 승인 + 새 후보
  assert.equal(P.decision.kind, 'buy'); assert.deepEqual(P.decision.nums, [3]);
  assert.equal(P.decisions.length, 1);
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'approved');
});

/* ── 못 산 종목 다시 시도 ── */
async function roundWith(params, orders, pool = ['A', 'B', 'C', 'D']) {
  const h = harness(params ? { params } : {});
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  const P0 = h.db.auto_runs['2026-11-16'].payload;
  P0.orders = JSON.parse(JSON.stringify(orders(P0)));
  h.setPool(pool); h.setMin(10 * 60 + 35);
  const r = await h.A.tick();
  return { h, r, P: h.db.auto_runs['2026-11-16'].payload };
}
const codesOf = P => P.picks.map(p => p.code);
test('다시 시도: 미체결 취소된 종목이 다음 검토에서 같은 번호로 다시 후보가 되고, 지난 주문은 이력으로 접힌다', async () => {
  const { h, r, P } = await roundWith({ approval: 'manual' }, P0 => { const [a, d] = codesOf(P0); return { [a]: { st: 'cancelled', buy: 10300, qty: 10, orderId: 'o1', placedAt: 1, at: 1 }, [d]: { st: 'filled', filled: 5, avg: 10000, orderId: 'o2' } }; });
  assert.equal(r.round.retry, 1); assert.equal(P.picks.length, 2);                          // 새 종목 없이 기존 후보 갱신
  const pk = P.picks.find(p => p.retry === 1), code = pk.code, num = P.picks.indexOf(pk) + 1;
  assert.equal(pk.closed, false); assert.match(pk.retryWhy, /미체결/);
  assert.equal(P.orders[code].st, 'retry'); assert.equal(P.orders[code].tries.length, 1); assert.equal(P.orders[code].tries[0].st, 'cancelled');
  const note = h.sent.filter(t => /^📈 자동매매 후보/.test(t))[1];
  assert.match(note, /🔁 재시도/); assert.match(note, /지난번: 미체결로 취소/); assert.match(note, new RegExp(`\\n${num}\\. `));
  assert.ok(P.log.some(l => l.k === 'round' && /다시 시도 1개/.test(l.text)));
});
test('다시 시도: 직접 승인 — 재시도 후보만 승인되고, 이미 산 종목 번호는 닫힘', async () => {
  const { h, P } = await roundWith({ approval: 'manual' }, P0 => { const [a, d] = codesOf(P0); return { [a]: { st: 'skipped', why: '체결강도 90%', at: 1 }, [d]: { st: 'filled', filled: 5, avg: 10000, orderId: 'o2' } }; });
  const re = P.picks.findIndex(p => p.retry) + 1, bought = P.picks.findIndex(p => !p.retry) + 1;
  assert.match(await h.A.handleApproval(`/매수 ${bought}`), /이전 회차/);
  const m = await h.A.handleApproval(`/매수 ${re}`);
  assert.match(m, /승인 기록/);
  assert.equal(h.db.auto_runs['2026-11-16'].payload.decision.nums[0], re);
});
test('다시 시도: 자동 승인이면 재시도 후보도 알림 직후 승인 기록', async () => {
  const { h, P } = await roundWith({ approval: 'auto' }, P0 => ({ [codesOf(P0)[0]]: { st: 'cancelled', buy: 1, qty: 1, orderId: 'o1' } }));
  const re = P.picks.findIndex(p => p.retry) + 1;
  assert.deepEqual(P.decision.nums, [re]); assert.equal(P.decision.kind, 'buy');
});
test('다시 시도: 시도 횟수를 다 썼거나(maxTries)·설정을 끄거나·다른 곳에서 보유 중이면 다시 하지 않음', async () => {
  const two = { st: 'cancelled', buy: 1, qty: 1, orderId: 'x', tries: [{ n: 1, st: 'cancelled' }, { n: 2, st: 'cancelled' }] };   // 이미 3번째 시도까지 씀
  let x = await roundWith({ approval: 'manual' }, P0 => ({ [codesOf(P0)[0]]: two }));
  assert.equal(x.r.round.fresh, 0);
  x = await roundWith({ approval: 'manual', retryUnfilled: false }, P0 => ({ [codesOf(P0)[0]]: { st: 'cancelled', buy: 1, qty: 1, orderId: 'x' } }));
  assert.equal(x.r.round.fresh, 0);
  x = await roundWith({ approval: 'manual' }, P0 => ({ [codesOf(P0)[0]]: { st: 'skipped', why: '이미 보유·주문 중(다른 전략 또는 직접 매매)' } }));
  assert.equal(x.r.round.fresh, 0);
  x = await roundWith({ approval: 'manual', maxTries: 2 }, P0 => ({ [codesOf(P0)[0]]: { st: 'cancelled', buy: 1, qty: 1, orderId: 'x' } }));   // 2번째 시도까지 → 1번 했으니 한 번 더 가능
  assert.equal(x.r.round.retry, 1);
});
test('하루 최대 종목 수: 못 산(취소·탈락) 주문은 세지 않는다', async () => {
  const { h, P } = await roundWith({ approval: 'manual', retryUnfilled: false }, P0 => Object.fromEntries(['X1', 'X2', 'X3', 'X4', 'X5'].map(c => [c, { st: 'cancelled', orderId: c, buy: 1, qty: 1 }])), ['A', 'B', 'C', 'D', 'E']);
  assert.ok(codesOf(P).includes('E'));                              // 예전엔 취소 주문 5개가 한도를 채워 검토를 건너뜀
});
test('다시 시도 대기: 다음 검토에서 조건을 통과하지 못하면 대기에서 빼고 지난 시도 상태로 되돌림', async () => {
  const tr = [{ n: 1, st: 'cancelled', why: null, buy: 10300, qty: 10, at: 1, placedAt: 2 }];
  const { P } = await roundWith({ approval: 'manual' }, P0 => ({ [codesOf(P0)[0]]: { st: 'retry', tries: tr } }), ['B', 'C']);   // 후보 A 가 더는 조건을 통과하지 못함
  const a = P.picks[0], o = P.orders[a.code];
  assert.equal(o.st, 'cancelled'); assert.equal(o.buy, 10300); assert.equal(o.tries, undefined); assert.equal(a.closed, true);
  assert.ok(P.log.some(l => l.k === 'round' && /재시도 대기에서 뺌/.test(l.text)));
});
test('다시 시도 대기: 조건을 계속 통과하면 대기에 남아 다시 승인 대상이 됨(빼지 않음)', async () => {
  const { P } = await roundWith({ approval: 'manual' }, P0 => ({ [codesOf(P0)[0]]: { st: 'cancelled', buy: 1, qty: 1, orderId: 'o' } }));
  const a = P.picks.find(p => p.retry);
  assert.equal(P.orders[a.code].st, 'retry'); assert.equal(a.closed, false);
});

/* ── 대체 후보: 외국인·기관 모두 순매수 통과 종목이 없으면 외국인+기관 합계로 보충 ── */
test('대체 후보: 외국인 순매도라도 외·기 합계가 1억 이상이면 후보(승인 필요), 합계 미달이면 제외', async () => {
  const h = harness();
  h.setFlow(() => ({ fq: -1000, oq: 30000 }));            // 합계 +29,000주 × 10,500원 ≈ 3.0억
  await h.A.tick();
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual(P.picks.map(p => p.code).sort(), ['A', 'D']);
  assert.ok(P.picks.every(p => p.alt && p.altSum > 1e8));
  assert.match(P.picks[0].reasons[0], /대체 조건/);
  const h2 = harness(); h2.setFlow(() => ({ fq: -1000, oq: 5000 }));   // 합계 +4,000주 ≈ 0.42억 → 미달
  await h2.A.tick();
  assert.equal(h2.db.auto_runs['2026-11-16'].payload.picks.length, 0);
  const hh = harness({ params: { altFlowOn: false } }); hh.setFlow(() => ({ fq: -1000, oq: 30000 }));
  await hh.A.tick();
  assert.equal(hh.db.auto_runs['2026-11-16'].payload.picks.length, 0);   // 끄면 대체 후보 없음
});
test('대체 후보: 원래 조건 통과 종목이 하나라도 있으면 대체 후보는 쓰지 않음', async () => {
  const h = harness();
  h.setFlow(c => (c === 'A' ? { fq: 1000, oq: 800 } : { fq: -1000, oq: 30000 }));
  await h.A.tick();
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual(P.picks.map(p => p.code), ['A']); assert.ok(!P.picks[0].alt);
});
test('대체 후보: 자동 승인 설정이어도 승인 대기, 알림에 안내', async () => {
  const h = harness({ params: { approval: 'auto' } });
  h.setFlow(() => ({ fq: -1000, oq: 30000 }));
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick(); await h.A.tick();
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'noticed');
  assert.match(h.sent[0], /대체 조건 후보/);
  assert.ok(!(h.db.auto_runs['2026-11-16'].payload.approved || []).length);
});
test('대체 후보: 승인이 없어도 다음 검토에도 후보면 자동 매수, 패스한 건 존중', async () => {
  const h = harness();
  h.setFlow(() => ({ fq: -1000, oq: 30000 }));
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  h.setMin(10 * 60 + 31); await h.A.tick();                       // 승인 마감 → 만료
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'expired');
  h.setMin(10 * 60 + 35); await h.A.tick();                       // 2회차: 여전히 후보 → 자동 매수
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual((P.approved || []).slice().sort(), ['A', 'D']);
  assert.ok(P.picks.every(p => p.altAuto));
  assert.ok(P.log.some(l => /대체 후보.*자동 매수/.test(l.text)));
  const g = harness(); g.setFlow(() => ({ fq: -1000, oq: 30000 }));
  await g.A.tick(); g.setMin(10 * 60 + 15); await g.A.tick();
  await g.A.handleApproval('/패스');                              // 사용자가 패스
  g.setMin(10 * 60 + 35); await g.A.tick();
  assert.ok(!(g.db.auto_runs['2026-11-16'].payload.approved || []).length);
});


/* ── 개인 계좌수(8월 기준): 100% 미만은 정상 후보, 이상이면 승인해야 매수하는 후보 + 배점 ── */
test('점수: 개인 물량 배점 — 70% 이하 만점, 100% 이상 0점, 자료 없으면 절반', () => {
  const c = { ...row('A'), rs20: 100 }, m = { fAmt: 0, oAmt: 0, pAmt: 0, cttr: 100 };
  const kwOf = k8 => A.scoreOne(k8 === undefined ? c : { ...c, kw8: k8 }, m, 0).parts.kw;
  assert.equal(kwOf(0.6), 10); assert.equal(kwOf(0.7), 10); assert.equal(kwOf(1), 0); assert.equal(kwOf(2.5), 0);
  assert.equal(kwOf(0.85), 5); assert.equal(kwOf(undefined), 5);
  assert.equal(A.scoreOne(c, m, 0, { ...require('../auto-strategy').defaults('intraday'), weights: { flow: 40, cttr: 15, rise: 15, amt: 15, trend: 15 } }).parts.kw, 0);   // 예전 배점은 영향 없음
});
const SN = (a8, now) => ({ '2025-08-01': a8, '2025-09-01': a8 * 0.9, '2025-11-14': now });
test('개인 계좌수: 8월 대비 100% 미만은 정상 후보, 이상은 ⚠ 승인 필요 후보(탈락 아님)', async () => {
  const h = harness({ kw: { A: SN(1000, 700), D: SN(1000, 2500) } });
  await h.A.tick();
  const P = h.db.auto_runs['2026-11-16'].payload, a = P.picks.find(p => p.code === 'A'), d = P.picks.find(p => p.code === 'D');
  assert.equal(P.picks.length, 2);
  assert.equal(a.kw8, 0.7); assert.ok(!a.kwHigh); assert.equal(d.kw8, 2.5); assert.equal(d.kwHigh, true);
  assert.match(d.reasons.join(' '), /개인 계좌 250% \(8월 대비\) — 승인해야 매수/);
  assert.equal(a.parts.kw, 10); assert.equal(d.parts.kw, 0);
});
test('개인 계좌수: 켜기를 끄면 조건·배점 모두 무시, 8월 자료가 없으면 정상 후보', async () => {
  const h = harness({ params: { kwOn: false }, kw: { D: SN(1000, 2500) } });
  await h.A.tick();
  assert.ok(h.db.auto_runs['2026-11-16'].payload.picks.every(p => !p.kwHigh && p.kw8 === undefined));
  const h2 = harness({ kw: { A: { '2025-09-01': 1000, '2025-11-14': 3000 } } });   // 8월 기록 없음
  await h2.A.tick();
  assert.ok(h2.db.auto_runs['2026-11-16'].payload.picks.every(p => !p.kwHigh));
});
test('개인 계좌수: 상한을 150%로 올리면 250%만 승인 필요', async () => {
  const h = harness({ params: { kwMax: 150 }, kw: { A: SN(1000, 1200), D: SN(1000, 2500) } });
  await h.A.tick();
  const P = h.db.auto_runs['2026-11-16'].payload;
  assert.ok(!P.picks.find(p => p.code === 'A').kwHigh); assert.equal(P.picks.find(p => p.code === 'D').kwHigh, true);
});
test('개인 계좌수: 자동 승인 설정이어도 상한 이상 후보는 자동 승인 제외, 알림에 안내, 직접 승인하면 매수', async () => {
  const h = harness({ params: { approval: 'auto' }, kw: { A: SN(1000, 700), D: SN(1000, 2500) } });
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick();
  assert.match(h.sent[0], /개인 계좌수가 8월 기준 100% 이상인 종목\(종목D 250%\)/);
  await h.A.tick(); await h.A.tick();
  let P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual((P.approved || []).slice().sort(), ['A']);        // D 는 제외
  const msg = JSON.stringify(await h.A.siteApprove('buy', [P.picks.findIndex(p => p.code === 'D') + 1], null));
  P = h.db.auto_runs['2026-11-16'].payload;
  assert.deepEqual((P.approved || []).slice().sort(), ['A', 'D'], String(msg));   // 자동 승인 뒤에도 직접 승인은 통과
  assert.deepEqual(P.decision.nums.slice().sort(), [1, 2]);
});
test('개인 계좌수: 후보가 전부 상한 이상이면 자동 승인 없음', async () => {
  const h = harness({ params: { approval: 'auto' }, kw: { A: SN(1000, 1500), D: SN(1000, 2500) } });
  await h.A.tick(); h.setMin(10 * 60 + 15); await h.A.tick(); await h.A.tick();
  assert.ok(!(h.db.auto_runs['2026-11-16'].payload.approved || []).length);
  assert.equal(h.db.auto_runs['2026-11-16'].status, 'noticed');
});
