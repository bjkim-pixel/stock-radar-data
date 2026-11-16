'use strict';
/* 자동매매 보강 E3(2026-11-16): 성과 지표 보강 + 주간 요약 + 조건 변경 안전장치. 모두 순수 함수(일지 행 → 계산).
   입력 rows = 일지 가벼운 행 { trade_date, strategy_id, kind, strategy_version, strategy_name, status, net, cost, pct, pos:[종목별], shadow:{all,picked,bought,...}, regime:{stage,...} }
   · 기대값 = 한 종목 매매의 평균 수익률(%) — 승률 × 평균 이익 − 패율 × 평균 손실과 같다
   · 지수 대비 초과수익 = 그날 전략 수익률 − 그날 코스피 등락률(일 단위 근사: 이월 종목의 다음 날 손익은 다음 날 몫에 포함되지 않음)
   · 표본이 작으면(MIN_TRADES 미만) 화면에 "참고용"으로 표시 */

const MIN_TRADES = 30;           // 이만큼은 쌓여야 기대값을 믿을 만하다고 봄
const FREQ_SAVES = 3, FREQ_DAYS = 14;   // 14일(약 10거래일) 안에 조건을 3번 이상 바꾸면 "너무 잦음"
const STALL_VERSIONS = 3, STALL_MIN_TRADES = 10;
const SHADOW_DAYS = 20;
const STAGES = ['attack', 'normal', 'caution', 'defense'];
const STAGE_KO = { attack: '공격', normal: '보통', caution: '보수', defense: '방어' };

const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);
const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
const sum = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const r2 = v => (v == null ? null : round(v, 2));
const asc = rows => rows.slice().sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0));
const posOf = r => r.pos || (r.payload && r.payload.positions) || [];
const shOf = r => (r.shadow !== undefined ? r.shadow : (r.payload && r.payload.shadow)) || null;
const rgOf = r => (r.regime !== undefined ? r.regime : (r.payload && r.payload.regime)) || null;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();   // 0=일

/* 종목 단위 매매 목록(평가 손익이 있는 것만) */
function tradesOf(rows) {
  const out = [];
  for (const r of rows) for (const p of posOf(r)) {
    if (!p || p.pnl == null) continue;
    out.push({ date: r.trade_date, sid: r.strategy_id, version: r.strategy_version, kind: r.kind, status: r.status, name: p.name, code: p.code, pnl: num(p.pnl), pct: num(p.pct), cost: num(p.cost),
      mfe: num(p.mfe), mae: num(p.mae), exSrc: p.exSrc || null, state: p.state || null, stage: (rgOf(r) || {}).stage || null });
  }
  return out;
}

/* 기대값·승률·손익비(종목 단위) */
function expectancy(trades) {
  const T = trades.filter(t => t.pct != null);
  const n = T.length;
  if (!n) return { n: 0, enough: false, winRate: null, avgWinPct: null, avgLossPct: null, expPct: null, expKrw: null, payoff: null, need: MIN_TRADES };
  const W = T.filter(t => t.pct > 0), L = T.filter(t => t.pct < 0);
  const aw = W.length ? mean(W.map(t => t.pct)) : null, al = L.length ? mean(L.map(t => t.pct)) : null;
  return {
    n, enough: n >= MIN_TRADES, need: MIN_TRADES, winRate: r2(W.length / n * 100), avgWinPct: r2(aw), avgLossPct: r2(al),
    expPct: r2(mean(T.map(t => t.pct))), expKrw: round(mean(T.map(t => t.pnl)) || 0), payoff: aw != null && al ? r2(aw / Math.abs(al)) : null,
  };
}

/* 코스피 일간 등락률 맵. kospi = [{trade_date, index_close}] (오름차순) */
function kospiDaily(kospi) {
  const m = {}, K = (kospi || []).filter(k => +k.index_close > 0).sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  for (let i = 1; i < K.length; i++) m[K[i].trade_date] = r2((+K[i].index_close / +K[i - 1].index_close - 1) * 100);
  return m;
}
/* 기간 수익률(전 거래일 종가 → 마지막 날 종가) */
function kospiRange(kospi, from, to) {
  const K = (kospi || []).filter(k => +k.index_close > 0).sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  const before = K.filter(k => k.trade_date < from).pop(), end = K.filter(k => k.trade_date <= to).pop();
  if (!before || !end || end.trade_date < from) return null;
  return r2((+end.index_close / +before.index_close - 1) * 100);
}

/* 지수 대비 초과수익(일 단위) — 장중 전략의 매수한 날만 */
function excess(rows, kmap) {
  const D = rows.filter(r => r.kind === 'intraday' && num(r.cost) > 0 && num(r.pct) != null && kmap[r.trade_date] != null)
    .map(r => ({ date: r.trade_date, strat: num(r.pct), idx: kmap[r.trade_date], ex: r2(num(r.pct) - kmap[r.trade_date]) }));
  if (!D.length) return { days: 0, avgStrat: null, avgIdx: null, avgExcess: null, hit: null, cum: null, series: [] };
  let c = 0;
  return { days: D.length, avgStrat: r2(mean(D.map(d => d.strat))), avgIdx: r2(mean(D.map(d => d.idx))), avgExcess: r2(mean(D.map(d => d.ex))),
    hit: r2(D.filter(d => d.ex > 0).length / D.length * 100), cum: r2(sum(D, d => d.ex)), series: D.map(d => ({ date: d.date, ex: d.ex, cum: r2(c += d.ex) })) };
}

/* MFE·MAE 분포: 매수 뒤 최고 평가이익 / 최대 평가손실, 최종 수익률. 반납 = 평균 최고 − 평균 최종 */
function excursion(trades) {
  const T = trades.filter(t => t.mfe != null && t.mae != null && t.pct != null);
  if (!T.length) return { n: 0, nLive: 0, avgMfe: null, avgMae: null, avgPct: null, giveBack: null, points: [] };
  const avgMfe = mean(T.map(t => t.mfe)), avgPct = mean(T.map(t => t.pct));
  return { n: T.length, nLive: T.filter(t => t.exSrc === 'live').length, avgMfe: r2(avgMfe), avgMae: r2(mean(T.map(t => t.mae))), avgPct: r2(avgPct), giveBack: r2(avgMfe - avgPct),
    points: T.slice(-150).map(t => ({ date: t.date, name: t.name, mfe: t.mfe, mae: t.mae, pct: t.pct, src: t.exSrc })) };
}

/* 시장 상태 단계별 성과(선정 날의 단계 기준) */
function byStage(rows) {
  const out = {};
  for (const st of STAGES) out[st] = { stage: st, label: STAGE_KO[st], days: 0, n: 0, wins: 0, net: 0, cost: 0 };
  for (const r of rows) {
    const st = (rgOf(r) || {}).stage;
    if (!out[st] || num(r.cost) == null || !(num(r.cost) > 0)) continue;
    const o = out[st]; o.days++; o.net += num(r.net) || 0; o.cost += num(r.cost) || 0;
    posOf(r).filter(p => p && p.pnl != null).forEach(p => { o.n++; if (p.pnl > 0) o.wins++; });
  }
  return STAGES.map(s => { const o = out[s]; return { ...o, net: round(o.net), cost: round(o.cost), pct: o.cost > 0 ? r2(o.net / o.cost * 100) : null, winRate: o.n ? r2(o.wins / o.n * 100) : null }; });
}

/* 버전별 기대값(조건 변경 전후 비교·정체 판단용) */
function byVersionExp(rows) {
  const g = {};
  for (const t of tradesOf(rows)) { const k = t.version == null ? 0 : t.version; (g[k] = g[k] || []).push(t); }
  return Object.entries(g).map(([v, T]) => ({ version: +v, ...expectancy(T) })).sort((a, b) => b.version - a.version);
}

/* 전략별 보강 지표 + 전체 */
function perfExtra(rows, kospi) {
  const kmap = kospiDaily(kospi), by = {};
  for (const r of asc(rows)) (by[r.strategy_id] = by[r.strategy_id] || []).push(r);
  const out = {};
  for (const [sid, R] of Object.entries(by)) {
    const T = tradesOf(R);
    out[sid] = { sid, expectancy: expectancy(T), excess: R[0].kind === 'intraday' ? excess(R, kmap) : null, excursion: R[0].kind === 'intraday' ? excursion(T) : null,
      byStage: R[0].kind === 'intraday' ? byStage(R) : null, versions: byVersionExp(R) };
  }
  return out;
}

/* ── 주간 요약 ── */
const mondayOf = d => { const w = dow(d); return addDays(d, w === 0 ? -6 : 1 - w); };
function weekSummary(rows, kospi, date) {
  const from = mondayOf(date), to = addDays(from, 4);
  const R = rows.filter(r => r.trade_date >= from && r.trade_date <= to && num(r.cost) > 0);
  const strategies = {}, trades = tradesOf(R);
  for (const r of R) {
    const s = strategies[r.strategy_id] = strategies[r.strategy_id] || { sid: r.strategy_id, name: r.strategy_name || r.strategy_id, kind: r.kind, days: 0, net: 0, cost: 0, n: 0, wins: 0, losses: 0 };
    s.days++; s.net += num(r.net) || 0; s.cost += num(r.cost) || 0;
  }
  for (const t of trades) { const s = strategies[t.sid]; if (!s) continue; s.n++; if (t.pnl > 0) s.wins++; else if (t.pnl < 0) s.losses++; }
  const list = Object.values(strategies).map(s => ({ ...s, net: round(s.net), cost: round(s.cost), pct: s.cost > 0 ? r2(s.net / s.cost * 100) : null }));
  const sorted = trades.filter(t => t.pct != null).sort((a, b) => b.pct - a.pct);
  const intr = list.filter(s => s.kind === 'intraday'), costI = sum(intr, s => s.cost);
  const pctAll = costI > 0 ? r2(sum(intr, s => s.net) / costI * 100) : null;
  const idx = kospiRange(kospi, from, to);
  const regimes = [...new Set(R.map(r => (rgOf(r) || {}).stage).filter(Boolean))].map(s => STAGE_KO[s]);
  return { from, to, strategies: list, net: round(sum(list, s => s.net)), tradedDays: new Set(R.map(r => r.trade_date)).size, n: trades.length,
    best: sorted[0] || null, worst: sorted.length > 1 ? sorted[sorted.length - 1] : null, pctAll, kospi: idx, excess: pctAll != null && idx != null ? r2(pctAll - idx) : null, stages: regimes };
}
const fmt = v => Math.round(v).toLocaleString('ko-KR');
const sg = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
const sp = v => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%');
const md = d => d.slice(5).replace('-', '/');
function weeklyText(ws, extra = {}) {
  const L = [`📅 주간 요약 · ${md(ws.from)}~${md(ws.to)}`];
  if (!ws.strategies.length) { L.push('', '이번 주는 자동매매 매수가 없었어요.'); return L.join('\n'); }
  L.push('', `순손익 ${sg(ws.net)}원 · 매수한 날 ${ws.tradedDays}일 · ${ws.n}종목`);
  ws.strategies.forEach(s => L.push(`■ ${s.name}: ${sg(s.net)}원 (${sp(s.pct)}) · ${s.n}종목 ${s.wins}승 ${s.losses}패`));
  if (ws.kospi != null) L.push('', `코스피 ${sp(ws.kospi)}${ws.excess != null ? ` · 장중 전략 ${sp(ws.pctAll)} → 지수 대비 ${ws.excess > 0 ? '+' : ws.excess < 0 ? '−' : ''}${Math.abs(ws.excess).toFixed(2)}%p` : ''} (일 단위 근사)`);
  if (ws.best) L.push(`최고 ${ws.best.name} ${sp(ws.best.pct)}${ws.worst && ws.worst !== ws.best ? ` · 최저 ${ws.worst.name} ${sp(ws.worst.pct)}` : ''}`);
  if (ws.stages && ws.stages.length) L.push(`시장 상태: ${ws.stages.join('·')}`);
  if (extra.exp && extra.exp.n) L.push(`누적 기대값 ${sp(extra.exp.expPct)}/종목 (${extra.exp.n}종목${extra.exp.enough ? '' : ` — ${extra.exp.need}종목 전까지는 참고용`})`);
  L.push('', '금요일 16:00 기준이라 마지막 날은 종가 확정 전 수치가 섞일 수 있어요.');
  return L.join('\n');
}

/* ── 조건 변경 안전장치 ──
   입력: rows(그 전략의 일지 행), versions([{version, changed, at}] 최신순), cur(현재 버전 번호), today('YYYY-MM-DD')
   반환: [{ key, level:'warn'|'info', title, text }] — 비어 있으면 그냥 저장 */
const PARAM_META = new Set(['enabled', 'name', 'desc', 'auto', 'init']);
function guards({ rows = [], versions = [], cur, today }) {
  rows = asc(rows);
  const out = [];
  const byV = byVersionExp(rows);
  const mine = byV.find(v => v.version === cur);
  if (mine && mine.n > 0 && mine.n < MIN_TRADES) out.push({ key: 'sample', level: 'warn', title: '표본이 아직 적어요', text: `지금 조건(v${cur})으로 쌓인 매매가 ${mine.n}종목뿐이에요(${MIN_TRADES}종목 이상이어야 기대값을 믿을 만해요). 지금 바꾸면 이 조건이 좋은지 나쁜지 끝내 알 수 없게 됩니다.` });
  const since = addDays(today, -FREQ_DAYS);
  const recent = versions.filter(v => v.at && String(v.at).slice(0, 10) >= since && (v.changed || []).some(c => !PARAM_META.has(c.key)));
  if (recent.length >= FREQ_SAVES) out.push({ key: 'freq', level: 'warn', title: '조건을 너무 자주 바꾸고 있어요', text: `최근 ${FREQ_DAYS}일 동안 조건 변경이 이미 ${recent.length}번이에요. 자주 바꾸면 어떤 변경이 효과였는지 구분할 수 없습니다.` });
  const stalled = byV.filter(v => v.n >= STALL_MIN_TRADES).slice(0, STALL_VERSIONS);
  if (stalled.length === STALL_VERSIONS && stalled.every(v => v.expPct != null && v.expPct <= 0)) out.push({ key: 'stall', level: 'warn', title: '최근 세 버전 모두 기대값이 0 이하예요', text: `v${stalled.map(v => v.version).join('·v')} 모두 종목당 평균 수익이 0% 이하(${stalled.map(v => sp(v.expPct)).join(' · ')}). 숫자 몇 개를 고치는 것보다 전략 자체(선정 방식·청산 방식)를 점검하는 편이 낫습니다.` });
  const sh = rows.filter(r => { const s = shOf(r); return s && s.all != null && s.bought != null; }).slice(-SHADOW_DAYS);
  if (sh.length >= SHADOW_DAYS) {
    const a = mean(sh.map(r => shOf(r).all)), b = mean(sh.map(r => shOf(r).bought));
    if (a != null && b != null && b < a) out.push({ key: 'shadow', level: 'info', title: '산 종목이 통과 후보 평균보다 못해요', text: `최근 ${SHADOW_DAYS}일 평균: 산 종목 ${sp(r2(b))} < 조건 통과 후보 전체 ${sp(r2(a))}. 후보를 고르는 순위·승인보다 매수·청산 방식에서 손해를 보고 있을 수 있어요.` });
  }
  return out;
}

/* 이번 주 마지막 거래일인지(금요일, 금요일이 휴장이면 그 주 마지막 거래일). isTrading(date)→bool */
function isLastTradingDayOfWeek(date, isTrading) {
  const w = dow(date);
  if (w < 1 || w > 5) return false;
  for (let d = addDays(date, 1), k = w + 1; k <= 5; d = addDays(d, 1), k++) if (isTrading(d)) return false;
  return true;
}

module.exports = { MIN_TRADES, FREQ_SAVES, FREQ_DAYS, STALL_VERSIONS, SHADOW_DAYS, STAGES, STAGE_KO, tradesOf, expectancy, kospiDaily, kospiRange, excess, excursion, byStage, byVersionExp, perfExtra,
  addDays, mondayOf, weekSummary, weeklyText, guards, isLastTradingDayOfWeek };
