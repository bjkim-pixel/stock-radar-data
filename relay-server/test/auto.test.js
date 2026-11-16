'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../auto');

const scr = { A: { close: 110, ma60: 100, ma120: 90, sector: '반도체', rs20_pctl: 90 }, B: { close: 95, ma60: 100, ma120: 90, sector: '반도체' }, C: { close: 110, ma60: 100, ma120: 90, sector: '반도체' }, D: { close: 110, ma60: 100, ma120: 90, sector: '2차전지' } };
const smx = { A: 'CONT', B: 'CONT', C: 'LEAVE', D: 'STALL' };
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
  const big = A.scoreOne(c, { fAmt: 4e9, oAmt: 4e9, pAmt: 4e9, cttr: 150, w52: 10500 }, 1);
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
function harness({ min = 10 * 60 + 5, on = true, trading = true } = {}) {
  const db = { auto_runs: {}, auto_config: { main: { on, perStockKrw: 1000000 } } };
  const sent = [];
  let clock = { date: '2026-11-16', min };
  const deps = {
    sbGet: async path => {
      if (path.startsWith('auto_config')) return [{ key: 'main', value: db.auto_config.main }];
      if (path.startsWith('auto_runs')) { const d = (path.match(/trade_date=eq\.([\d-]+)/) || [])[1]; return db.auto_runs[d] ? [db.auto_runs[d]] : []; }
      if (path.startsWith('v_screener?select=trade_date')) return [{ trade_date: '2026-11-13' }];
      if (path.startsWith('v_screener')) return path.includes('offset=0') ? Object.entries(scr).map(([code, v]) => ({ code, ...v })) : [];
      if (path.startsWith('smx_state')) return path.includes('offset=0') ? Object.entries(smx).filter(([, v]) => v === 'CONT' || v === 'STALL').map(([code, st]) => ({ code, st })) : [];
      if (path.startsWith('positions')) return [];
      throw new Error('unexpected ' + path);
    },
    sbWrite: async (path, method, body) => { if (path.startsWith('auto_runs')) body.forEach(b => { db.auto_runs[b.trade_date] = b; }); },
    sendTelegram: async t => { sent.push(t); },
    kstNow: () => clock, isTradingDay: () => trading,
    livePool: async () => [row('A'), row('B'), row('C'), row('D', { amt: 2e11 })],
    fetchFlow: async c => ({ fq: 1000, oq: 800 }), fetchPower: async c => ({ pgQty: 200, w52: 11000 }), fetchCttr: async c => ({ cttr: 125 }),
    marketState: async () => null,
  };
  return { A: A.createAuto(deps), db, sent, setMin: m => { clock = { date: clock.date, min: m }; } };
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
