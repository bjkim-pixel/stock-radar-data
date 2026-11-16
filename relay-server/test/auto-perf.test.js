'use strict';
/* 자동매매 보강 E3: 기대값·초과수익·MFE/MAE·단계별·주간 요약·조건 변경 안전장치 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../auto-perf');

const pos = (name, pnl, pct, extra = {}) => ({ code: name, name, pnl, pct, cost: 1000000, state: 'closed', ...extra });
const row = (date, sid, ver, positions, extra = {}) => {
  const net = positions.reduce((a, p) => a + p.pnl, 0), cost = positions.length * 1e6;
  return { trade_date: date, strategy_id: sid, kind: 'intraday', strategy_version: ver, strategy_name: sid === 'intraday-default' ? '기본' : sid, status: 'final', net, cost, pct: cost ? +(net / cost * 100).toFixed(2) : null, pos: positions, shadow: null, regime: null, ...extra };
};
const KOSPI = [['2026-11-06', 2500], ['2026-11-09', 2500], ['2026-11-10', 2525], ['2026-11-11', 2499.75], ['2026-11-12', 2512.25], ['2026-11-13', 2525], ['2026-11-16', 2550]].map(([d, c]) => ({ trade_date: d, index_close: c }));

test('기대값: 평균 수익률·승률·손익비, 30종목 미만이면 참고용', () => {
  const T = P.tradesOf([row('2026-11-10', 's', 1, [pos('A', 30000, 3), pos('B', -20000, -2), pos('C', 10000, 1)])]);
  const e = P.expectancy(T);
  assert.equal(e.n, 3); assert.equal(e.enough, false); assert.equal(e.need, 30);
  assert.equal(e.winRate, 66.67); assert.equal(e.avgWinPct, 2); assert.equal(e.avgLossPct, -2); assert.equal(e.payoff, 1);
  assert.equal(e.expPct, 0.67); assert.equal(e.expKrw, 6667);
  assert.equal(P.expectancy([]).n, 0);
  const many = Array.from({ length: 30 }, (_, i) => ({ pct: i % 2 ? -1 : 2, pnl: 0 }));
  assert.equal(P.expectancy(many).enough, true);
});
test('지수 대비 초과수익: 그날 전략 수익률 − 그날 코스피 등락률(매수한 날만)', () => {
  const km = P.kospiDaily(KOSPI);
  assert.deepEqual([km['2026-11-10'], km['2026-11-11'], km['2026-11-12']], [1, -1, 0.5]);
  const R = [row('2026-11-10', 's', 1, [pos('A', 20000, 2)]), row('2026-11-11', 's', 1, [pos('B', 10000, 1)]), row('2026-11-12', 's', 1, [])];
  const x = P.excess(R, km);
  assert.equal(x.days, 2);                       // 매수 없는 날(cost 0)은 제외
  assert.equal(x.avgExcess, 1.5);                // (2−1 + 1−(−1)) / 2
  assert.equal(x.hit, 100); assert.equal(x.cum, 3);
  assert.equal(P.excess([], km).days, 0);
  assert.equal(P.kospiRange(KOSPI, '2026-11-10', '2026-11-13'), 1);   // 11/9 종가 2500 → 11/13 종가 2525
});
test('MFE/MAE 분포: 기록 있는 종목만 · 반납(최고 − 최종)', () => {
  const T = P.tradesOf([row('2026-11-10', 's', 1, [pos('A', 1, 2, { mfe: 6, mae: -1, exSrc: 'live' }), pos('B', 1, -3, { mfe: 1, mae: -5, exSrc: 'daily' }), pos('C', 1, 1)])]);
  const e = P.excursion(T);
  assert.deepEqual([e.n, e.nLive, e.avgMfe, e.avgMae, e.avgPct, e.giveBack], [2, 1, 3.5, -3, -0.5, 4]);
  assert.equal(e.points.length, 2);
  assert.equal(P.excursion([]).n, 0);
});
test('시장 단계별 성과: 선정 날의 단계로 묶음', () => {
  const R = [row('2026-11-10', 's', 1, [pos('A', 20000, 2), pos('B', -10000, -1)], { regime: { stage: 'attack' } }), row('2026-11-11', 's', 1, [pos('C', -30000, -3)], { regime: { stage: 'defense' } }), row('2026-11-12', 's', 1, [pos('D', 5000, 0.5)], { regime: null })];
  const b = P.byStage(R);
  assert.deepEqual(b.map(x => x.stage), ['attack', 'normal', 'caution', 'defense']);
  const a = b[0], d = b[3];
  assert.deepEqual([a.days, a.n, a.net, a.pct, a.winRate], [1, 2, 10000, 0.5, 50]);
  assert.deepEqual([d.days, d.n, d.net, d.pct, d.winRate], [1, 1, -30000, -3, 0]);
  assert.equal(b[1].pct, null);
});
test('perfExtra: 전략별로 묶고 종가베팅은 초과수익·MFE 없음, 버전별 기대값', () => {
  const R = [row('2026-11-10', 's1', 1, [pos('A', 20000, 2)]), row('2026-11-11', 's1', 2, [pos('B', -10000, -1)]), { ...row('2026-11-10', 'c1', 1, [pos('A', 1, 1)]), kind: 'closing' }];
  const x = P.perfExtra(R, KOSPI);
  assert.equal(x.s1.excess.days, 2); assert.deepEqual(x.s1.versions.map(v => v.version), [2, 1]);
  assert.equal(x.c1.excess, null); assert.equal(x.c1.excursion, null);
});
test('주간 요약: 월~금 범위 · 전략별 · 최고/최저 · 코스피 대비 · 텍스트', () => {
  const R = [row('2026-11-09', 's', 1, [pos('A', 20000, 2)]), row('2026-11-10', 's', 1, [pos('B', -30000, -3)], { regime: { stage: 'defense' } }), row('2026-11-16', 's', 1, [pos('Z', 9, 9)])];
  const w = P.weekSummary(R, KOSPI, '2026-11-13');
  assert.deepEqual([w.from, w.to, w.tradedDays, w.n, w.net], ['2026-11-09', '2026-11-13', 2, 2, -10000]);
  assert.equal(w.best.name, 'A'); assert.equal(w.worst.name, 'B');
  assert.equal(w.kospi, 1);                       // 11/6(없음)→ 기준은 11/9 이전 종가 없음 → null 이어야 함을 아래에서 확인
});

test('주간 요약 텍스트 · 주의 마지막 거래일 판단', () => {
  const R = [row('2026-11-09', 's', 1, [pos('A', 20000, 2)]), row('2026-11-10', 's', 1, [pos('B', -30000, -3)], { regime: { stage: 'defense' } })];
  const t = P.weeklyText(P.weekSummary(R, KOSPI, '2026-11-13'), { exp: { n: 2, enough: false, need: 30, expPct: -0.5 } });
  assert.match(t, /주간 요약 · 11\/09~11\/13/); assert.match(t, /순손익 −10,000원/); assert.match(t, /코스피 \+1\.00%/);
  assert.match(t, /최고 A \+2\.00% · 최저 B −3\.00%/); assert.match(t, /시장 상태: 방어/); assert.match(t, /30종목 전까지는 참고용/);
  assert.match(P.weeklyText(P.weekSummary([], KOSPI, '2026-11-13')), /매수가 없었어요/);
  const all = () => true;
  assert.equal(P.isLastTradingDayOfWeek('2026-11-13', all), true);                 // 금요일
  assert.equal(P.isLastTradingDayOfWeek('2026-11-12', all), false);                // 목요일, 금요일 정상 개장
  assert.equal(P.isLastTradingDayOfWeek('2026-11-12', d => d !== '2026-11-13'), true);   // 금요일 휴장이면 목요일
  assert.equal(P.isLastTradingDayOfWeek('2026-11-14', all), false);                // 토요일
});

const manyPos = (n, pct) => Array.from({ length: n }, (_, i) => pos('P' + i, pct * 10000, pct));
test('안전장치: 표본 부족(현재 버전 매매 1~29종목) — 아직 안 쓴 전략은 경고 없음', () => {
  const today = '2026-11-20';
  assert.deepEqual(P.guards({ rows: [], versions: [], cur: 1, today }), []);
  const g = P.guards({ rows: [row('2026-11-17', 's', 3, manyPos(5, 1))], versions: [], cur: 3, today });
  assert.deepEqual(g.map(x => x.key), ['sample']); assert.match(g[0].text, /v3.*5종목/);
  assert.deepEqual(P.guards({ rows: [row('2026-11-17', 's', 3, manyPos(30, 1))], versions: [], cur: 3, today }), []);   // 충분
  assert.deepEqual(P.guards({ rows: [row('2026-11-17', 's', 2, manyPos(5, 1))], versions: [], cur: 3, today }), []);    // 현재 버전(v3)은 아직 안 씀
});
test('안전장치: 너무 잦은 변경 — 14일 안에 조건 변경 3번 이상(이름·켜기만 바꾼 건 제외)', () => {
  const today = '2026-11-20', V = (v, at, key = 'stopPct') => ({ version: v, at, changed: [{ key }] });
  const g = P.guards({ rows: [], versions: [V(5, '2026-11-19T01:00:00Z'), V(4, '2026-11-15T01:00:00Z'), V(3, '2026-11-10T01:00:00Z')], cur: 5, today });
  assert.deepEqual(g.map(x => x.key), ['freq']); assert.match(g[0].text, /3번/);
  assert.deepEqual(P.guards({ rows: [], versions: [V(5, '2026-11-19T01:00:00Z'), V(4, '2026-11-15T01:00:00Z'), V(3, '2026-11-10T01:00:00Z', 'enabled')], cur: 5, today }), []);
  assert.deepEqual(P.guards({ rows: [], versions: [V(5, '2026-11-19T01:00:00Z'), V(4, '2026-11-15T01:00:00Z'), V(3, '2026-10-01T01:00:00Z')], cur: 5, today }), []);   // 오래된 변경
});
test('안전장치: 성과 정체 — 최근 세 버전(각 10종목 이상) 기대값 모두 0 이하', () => {
  const today = '2026-11-20';
  const rows = [row('2026-11-02', 's', 1, manyPos(10, -1)), row('2026-11-09', 's', 2, manyPos(10, -0.5)), row('2026-11-16', 's', 3, manyPos(10, 0))];
  const g = P.guards({ rows, versions: [], cur: 4, today });
  assert.ok(g.some(x => x.key === 'stall')); assert.match(g.find(x => x.key === 'stall').text, /v3·v2·v1/);
  const ok = [row('2026-11-02', 's', 1, manyPos(10, -1)), row('2026-11-09', 's', 2, manyPos(10, -0.5)), row('2026-11-16', 's', 3, manyPos(10, 1))];
  assert.ok(!P.guards({ rows: ok, versions: [], cur: 4, today }).some(x => x.key === 'stall'));
  assert.ok(!P.guards({ rows: rows.slice(1), versions: [], cur: 4, today }).some(x => x.key === 'stall'));   // 두 버전뿐
});
test('안전장치: 그림자 역전 — 최근 20일 산 종목이 통과 후보 평균보다 못함(정보)', () => {
  const mk = i => row(`2026-10-${String(i + 1).padStart(2, '0')}`, 's', 1, manyPos(30, 1), { shadow: { all: 1.5, bought: 0.5 } });
  const rows = Array.from({ length: 20 }, (_, i) => mk(i));
  const g = P.guards({ rows, versions: [], cur: 1, today: '2026-11-20' });
  assert.deepEqual(g.map(x => [x.key, x.level]), [['shadow', 'info']]);
  assert.deepEqual(P.guards({ rows: rows.slice(1), versions: [], cur: 1, today: '2026-11-20' }), []);   // 19일뿐
});

/* 저장 흐름: 경고가 있으면 confirm 없이는 저장하지 않음 */
test('전략 저장: 경고 → 409 확인 요청, confirm 이면 저장, 조건이 안 바뀌면 점검 없음', async () => {
  const A = require('../auto'), S = require('../auto-strategy');
  const cur = { id: 'intraday-default', name: '기본', kind: 'intraday', version: 3, enabled: true, params: S.defaults('intraday') };
  let saved = 0;
  const jr = [row('2026-11-17', 'intraday-default', 3, manyPos(5, 1))];
  const strategies = { byId: async id => (id === cur.id ? cur : null), save: async () => { saved++; return { ok: true, strategy: cur, changed: [] }; }, versions: async () => [], isMissing: () => false,
    actives: async () => ({ Is: [{ ...cur, letter: 'A', T: S.timesOf(cur.params, S.defaults('closing')) }], C: { id: 'closing-default', enabled: true, params: S.defaults('closing') } }), list: async () => [cur], pair: async () => null };
  const auto = A.createAuto({ strategies, sbGet: async p => (p.startsWith('auto_journal') ? JSON.parse(JSON.stringify(jr)) : []), sbWrite: async () => {}, sendTelegram: async () => {}, kstNow: () => ({ date: '2026-11-20', min: 600 }), isTradingDay: () => true, now: () => Date.now() });
  const patch = { params: { ...cur.params, stopPct: 4 } };
  const r1 = await auto.saveStrategy('intraday-default', patch, 'site');
  assert.equal(r1.ok, false); assert.equal(r1.status, 409); assert.equal(r1.needConfirm, true); assert.equal(r1.warnings[0].key, 'sample'); assert.equal(saved, 0);
  const r2 = await auto.saveStrategy('intraday-default', patch, 'site', { confirm: true });
  assert.equal(r2.ok, true); assert.equal(saved, 1);
  const r3 = await auto.saveStrategy('intraday-default', { params: { ...cur.params } }, 'site');       // 바뀐 게 없음
  assert.equal(r3.ok, true); assert.equal(saved, 2);
  const r4 = await auto.saveStrategy('intraday-default', { enabled: false }, 'site');                   // 켜기/끄기는 점검 대상 아님
  assert.equal(r4.ok, true); assert.equal(saved, 3);
});

/* 주간 요약 발송: 마지막 거래일 16:00 이후 한 번만 */
test('주간 요약: 금요일 16:00 이후 한 번만 보내고 같은 주에 다시 보내지 않음', async () => {
  const J = require('../auto-journal'), sent = [], cfg = {};
  const wk = [row('2026-11-16', 'intraday-default', 1, [pos('A', 20000, 2)])];
  const jr = J.createJournal({ sbGet: async p => { if (p.startsWith('auto_config')) return cfg.weekly ? [{ value: cfg.weekly }] : []; if (p.startsWith('auto_journal')) return JSON.parse(JSON.stringify(wk)); if (p.startsWith('market_daily')) return KOSPI; return []; },
    sbWrite: async (p, m, b) => { if (p.startsWith('auto_config')) cfg.weekly = b[0].value; }, sendTelegram: async t => { sent.push(t); }, now: () => 1e12, readRuns: async () => [], readCarry: async () => ({ items: {} }), actives: async () => ({ Is: [], C: {} }), isTradingDay: () => true });
  await jr.tick('2026-11-20', 950, 1200); assert.equal(sent.length, 0);                 // 15:50 — 16:00 전
  await jr.tick('2026-11-16', 970, 1200); assert.equal(sent.length, 0);                 // 월요일 — 주의 마지막 날 아님
  const t = await jr.tick('2026-11-20', 970, 1200); assert.equal(sent.length, 1);       // 금요일 16:10
  assert.match(sent[0], /주간 요약 · 11\/16~11\/20/); assert.equal(t.weekly.sent, true);
  await jr.tick('2026-11-20', 1000, 1200); assert.equal(sent.length, 1);                // 같은 날 다시 보내지 않음
  assert.equal((await jr.sendWeekly('2026-11-20')).skipped, 'sent'); assert.equal(sent.length, 1);   // 같은 주 재시도도 건너뜀
});
