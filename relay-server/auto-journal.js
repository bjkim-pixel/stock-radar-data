'use strict';
const EXC = require('./auto-excursion'), PERF = require('./auto-perf');
const PERF_ADD = PERF.addDays, WEEKLY_AT = 960;
/* 자동매매 D단계(2026-11-16) — 전략별 장부 + 자동 일지
   · 장부: 가상매매 체결(paper_fills)을 "어느 전략의 매매인지" 나눠 계산한다(직접 매매는 빠짐). 별도 테이블 없이 일지(auto_journal)에 담는다.
     - 매수 체결 → 그날 그 종목을 산 장중 전략(주문 id 우선, 없으면 종목)
     - 매도 체결 → 같은 전략. 단, 종가베팅으로 넘긴 종목을 다음 날 아침 파는 체결은 종가베팅 전략 몫
   · 손익: 장중 전략 = 그날 실현손익 + 이월 종목은 "넘긴 가격(종가)" 기준 평가손익 − 수수료. 종가베팅 = (판 가격 − 넘겨받은 가격) × 수량 − 수수료
     → 같은 손익을 두 전략이 이중으로 갖지 않는다(넘긴 순간까지는 장중 전략, 그 뒤는 종가베팅)
   · 일지: 거래일 15:40 첫 작성(텔레그램 요약) → 전환(20:00) 5분 뒤 이월 반영 → 다음 거래일 09:20 이후 종가베팅 결과·공식 종가 반영해 확정. 다시 만들어도 같은 결과(멱등), 메모는 건드리지 않음 */
const UI = require('./auto-ui'), RV = require('./auto-review');

const DAY = 864e5, KST = 9 * 3600e3;
const JOURNAL_AT = 15 * 60 + 40, FINISH_AT = 9 * 60 + 20, FINISH_END = 15 * 60 + 30, AFTER_CONVERT = 5;
const dayOfTs = ts => new Date(ts + KST).toISOString().slice(0, 10);
const nextDate = d => new Date(Date.parse(d + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const startIso = d => `${d}T00:00:00+09:00`;
const round = Math.round;
const sum = (a, f) => a.reduce((s, x) => s + (+f(x) || 0), 0);
const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
const fmt = v => Math.round(v).toLocaleString('ko-KR');
const sg = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
const sp = v => v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%';
const md = d => d.slice(5).replace('-', '/');
const isMissing = e => /PGRST205|42P01|404/.test(String((e && e.message) || e));
const MEMO_MAX = 2000;
/* 실전 탭(2026-11-19): 장부(paper·dry·live)별로 체결을 나눠 일지를 만든다. 텔레그램·이름 앞 표시 */
const ENG_TAG = { live: '🔴실전 ', dry: '🧪드라이런 ' };
const ENG_NAME = { paper: '', dry: ' (드라이런)', live: ' (실전)' };
/* 종가베팅 일지 행의 전략 ID: 가상은 종가 전략 ID 그대로, 드라이런·실전은 접두사를 바꿔 따로(예: closing-default → closinglive-default) */
const closingIdFor = (cid, kind) => (!cid || !kind || kind === 'paper' ? cid : String(cid).replace(/^([a-z]+)-/, `$1${kind}-`));
const engineOfRow = r => (r && (r.engine || (r.payload && r.payload.engine))) || 'paper';
const sideOfEngine = e => (e === 'live' || e === 'dry' ? 'real' : 'paper');

function normFill(r) {
  return { id: r.id, ts: typeof r.ts === 'number' ? r.ts : Date.parse(r.ts), orderId: r.order_id != null ? r.order_id : r.orderId, code: r.code, side: r.side,
    price: +r.price, qty: +r.qty, amount: +r.amount, fee: +r.fee || 0, realized: r.realized == null ? null : +r.realized, reason: r.reason || 'manual' };
}

/* 체결을 전략에 귀속(순수). 직접 매매·전략 밖 종목은 빠진다. carryItems: auto_config 'carry' 의 이월 종목(from·at·sid) */
function attribute(date, runs, fills, carryItems, closingId) {
  const byCode = {}, byOrder = {};
  for (const r of runs) {
    const sid = r.strategy_id || (r.payload && r.payload.strategy && r.payload.strategy.id);
    for (const [code, o] of Object.entries((r.payload && r.payload.orders) || {})) {
      if (!((o.filled || 0) > 0)) continue;
      if (!byCode[code]) byCode[code] = sid;
      [o.orderId, o.from].filter(Boolean).forEach(id => { byOrder[id] = sid; });
    }
  }
  const firstBuy = {};
  fills.filter(f => f.side === 'buy').forEach(f => { if (firstBuy[f.code] == null || f.ts < firstBuy[f.code]) firstBuy[f.code] = f.ts; });
  const carry = {}; (carryItems || []).forEach(i => { carry[i.code] = i; });
  const out = [];
  for (const f of fills.slice().sort((a, b) => a.ts - b.ts)) {
    if (dayOfTs(f.ts) !== date) continue;
    if (f.side === 'buy') { const sid = byOrder[f.orderId] || byCode[f.code]; if (sid) out.push({ ...f, sid, leg: 'intraday' }); continue; }
    const ci = carry[f.code], rebought = firstBuy[f.code] != null && firstBuy[f.code] <= f.ts;
    if (ci && closingId && !rebought && (ci.from < date || (ci.from === date && ci.at && f.ts >= ci.at))) { out.push({ ...f, sid: closingId, leg: 'closing', from: ci.from, fromSid: ci.sid || null }); continue; }
    const sid = byCode[f.code];
    if (sid) out.push({ ...f, sid, leg: 'intraday' });
  }
  return out;
}

const whyOf = (f, eodSell, closing) => {
  if (f.reason === 'stop') return closing ? '손절(이월 중)' : '손절';
  const m = /^tp(\d)$/.exec(f.reason || ''); if (m) return `${m[1]}차 익절`;
  if (closing) return '아침 분할 매도';
  return eodSell && eodSell.has(f.code) ? '종가 전 정리' : '수동·기타';
};

const judgeOf = E => (E ? { at: E.at, none: !!E.none, items: (E.items || []).map(i => ({ code: i.code, name: i.name, ok: !!i.ok, why: i.why || [] })), weak: E.weak || [], decision: E.decision ? { kind: E.decision.kind, timeout: !!E.decision.timeout, auto: !!E.decision.auto } : null } : null);

/* 장중 전략 하루 일지(순수). fills = 그 전략으로 귀속된 체결. closes = {종목: 공식 종가}(있으면), marks = {종목: 현재가}, prev = 지난 작성 때 값(넘긴 가격 고정용) */
function buildIntraday({ date, run, fills, marks = {}, closes = {}, prev = {}, today, exc = null, daily = {}, kind = 'paper' }) {
  const P = run.payload || {}, ords = P.orders || {};
  const codes = Object.entries(ords).filter(([, o]) => (o.filled || 0) > 0).map(([c]) => c);
  const names = {}; (P.picks || []).forEach(p => { names[p.code] = p.name; }); (P.shadow || []).forEach(p => { if (!names[p.code]) names[p.code] = p.name; });
  const eodSell = new Set([P.eod, P.eodN].flatMap(E => (E && E.decision && E.decision.kind === 'sell' ? (E.decision.codes || []) : [])));
  const carried = new Set(P.carryDone ? (P.carryDone.codes || []) : []);
  const frozen = prev.px0 || {};
  const positions = [], buys = [], sells = [];
  for (const code of codes) {
    const fb = fills.filter(f => f.code === code && f.side === 'buy'), fs = fills.filter(f => f.code === code && f.side === 'sell');
    const bq = sum(fb, f => f.qty), ba = sum(fb, f => f.amount), bf = sum(fb, f => f.fee);
    const sq = sum(fs, f => f.qty), sa = sum(fs, f => f.amount), sf = sum(fs, f => f.fee), re = sum(fs, f => f.realized);
    if (!(bq > 0)) continue;
    const buyAvg = ba / bq, held = Math.max(0, bq - sq);
    let px0 = null, src = null;
    if (held > 0) {
      if (closes[code] > 0) { px0 = closes[code]; src = 'close'; }
      else if (frozen[code] > 0 && !(prev.src && prev.src[code] === 'avg' && marks[code] > 0)) { px0 = frozen[code]; src = (prev.src && prev.src[code]) || 'frozen'; }
      else if (marks[code] > 0) { px0 = marks[code]; src = 'last'; }
      else { px0 = buyAvg; src = 'avg'; }
    }
    const carryMark = held > 0 ? (px0 - buyAvg) * held : 0;
    const pnl = re + carryMark - bf - sf;
    const ex = EXC.excursionFor(exc, daily, code, date, buyAvg, kind);
    const state = held <= 0 ? 'closed' : carried.has(code) ? 'carried' : P.carryDone ? 'held' : 'pending';
    positions.push({ code, name: names[code] || code, qty: bq, buyAvg: round(buyAvg), sellQty: sq, sellAvg: sq ? round(sa / sq) : null, held, px0: px0 ? round(px0) : null, px0src: src,
      realized: round(re), carryMark: round(carryMark), fees: round(bf + sf), pnl: round(pnl), cost: round(ba), pct: ba > 0 ? +(pnl / ba * 100).toFixed(2) : null, state,
      mfe: ex ? ex.mfe : null, mae: ex ? ex.mae : null, exSrc: ex ? ex.src : null });
    fb.forEach(f => buys.push({ code, name: names[code] || code, qty: f.qty, price: f.price, amount: round(f.amount), at: f.ts }));
    fs.forEach(f => sells.push({ code, name: names[code] || code, qty: f.qty, price: f.price, amount: round(f.amount), realized: f.realized == null ? null : round(f.realized), fee: round(f.fee), why: whyOf(f, eodSell, false), at: f.ts }));
  }
  const cost = sum(positions, p => p.cost), net = sum(positions, p => p.pnl);
  const totals = {
    cost: round(cost), net: round(net), pct: cost > 0 ? +(net / cost * 100).toFixed(2) : null, realized: round(sum(positions, p => p.realized)), carryMark: round(sum(positions, p => p.carryMark)),
    fees: round(sum(positions, p => p.fees)), n: positions.length, wins: positions.filter(p => p.pnl > 0).length, losses: positions.filter(p => p.pnl < 0).length,
    carried: positions.filter(p => p.state === 'carried' || p.state === 'pending').length,
  };
  const sm = UI.summarizeRun(run, false);
  const sh = Object.keys(closes).length && sm.shadow.length ? UI.shadowReturns(sm, { [date]: closes }) : null;
  const skipped = Object.entries(ords).filter(([, o]) => !((o.filled || 0) > 0)).map(([code, o]) => ({ code, name: names[code] || code, st: o.st, why: o.why || null }));
  const E = P.eod;
  const funnel = { ...(P.stat || {}), picks: (P.picks || []).length, approved: (P.approved || []).length, bought: positions.length };
  const notBought = RV.notBoughtOf(P, closes, daily);
  const review = RV.reviewOf({ P, positions, sells, notBought, totals, shadow: sh, funnel, params: P.params || null });
  return {
    v: 2, kind: 'intraday', engine: kind, replay: RV.replayOf(P), notBought, review, date, strategy: P.strategy || null, letter: P.letter || null, params: P.params || null, warn: P.warn || null, regime: P.regime || null,
    funnel,
    decision: P.decision ? { kind: P.decision.kind, nums: P.decision.nums || null } : null,
    buys, sells, positions, skipped, totals,
    judge: judgeOf(E), judgeN: judgeOf(P.eodN),
    carry: P.carryDone ? { at: P.carryDone.at || null, off: !!P.carryDone.off, codes: P.carryDone.codes || [] } : null,
    shadow: sh,
    px0: Object.fromEntries(positions.filter(p => p.px0).map(p => [p.code, p.px0])), px0src: Object.fromEntries(positions.filter(p => p.px0).map(p => [p.code, p.px0src])),
    closeFinal: !!(date < (today || '9999') && (Object.keys(closes).length || !codes.length)),
  };
}

/* 종가베팅 하루 일지(순수). items = 그날 넘겨받은 이월 종목({code,name,q0,avg,at,px0,sid,state,log}), sells = 그 종목들의 이후 매도 체결(시각순) */
function buildClosing({ date, items, sells, strategy, engine = 'paper' }) {
  const positions = [], rows = [];
  for (const it of items) {
    let rem = +it.q0 || 0, sq = 0, sa = 0, sf = 0, cut = false;
    for (const f of sells.filter(s => s.code === it.code && s.ts >= (it.at || 0)).sort((a, b) => a.ts - b.ts)) {
      if (rem <= 0) break;
      const take = Math.min(f.qty, rem), frac = f.qty > 0 ? take / f.qty : 0;
      sq += take; sa += f.price * take; sf += f.fee * frac; rem -= take;
      rows.push({ code: it.code, name: it.name, qty: take, price: f.price, amount: round(f.price * take), fee: round(f.fee * frac), why: whyOf(f, null, true), at: f.ts, day: dayOfTs(f.ts) });
    }
    if ((it.log || []).some(l => l.cut)) cut = true;
    const px0 = it.px0 > 0 ? it.px0 : it.avg, avgSell = sq ? sa / sq : null;
    const pnl = sq ? (avgSell - px0) * sq - sf : 0;
    const done = sq >= (+it.q0 || 0) || it.state === 'done';
    positions.push({ code: it.code, name: it.name, qty: +it.q0 || 0, px0: round(px0), buyAvg: round(it.avg), fromSid: it.sid || null, sellQty: sq, sellAvg: avgSell ? round(avgSell) : null, left: Math.max(0, (+it.q0 || 0) - sq),
      fees: round(sf), pnl: round(pnl), cost: round(px0 * sq), pct: sq && px0 > 0 ? +(pnl / (px0 * sq) * 100).toFixed(2) : null, vsCost: sq && it.avg > 0 ? +((avgSell / it.avg - 1) * 100).toFixed(2) : null, gapCut: cut, done });
  }
  const traded = positions.filter(p => p.sellQty > 0);
  const cost = sum(traded, p => p.cost), net = sum(positions, p => p.pnl);
  const alldone = positions.length > 0 && positions.every(p => p.done);
  return {
    v: 1, kind: 'closing', engine, date, strategy: strategy || null, positions, sells: rows,
    totals: { cost: round(cost), net: round(net), pct: cost > 0 ? +(net / cost * 100).toFixed(2) : null, n: positions.length, wins: positions.filter(p => p.pnl > 0).length, losses: positions.filter(p => p.pnl < 0).length, left: sum(positions, p => p.left) },
    state: alldone ? 'done' : 'open', resultFrom: rows.length ? rows[0].day : null,
  };
}

/* 일지 행 → DB 행 */
function toRow(date, sid, kind, st, status, payload) {
  const t = payload.totals || {};
  return { trade_date: date, strategy_id: sid, kind, strategy_version: st && st.version != null ? st.version : null, strategy_name: st && st.name || null, status,
    net: t.net == null ? null : t.net, cost: t.cost == null ? null : t.cost, pct: t.pct == null ? null : t.pct, n_pos: t.n || 0, wins: t.wins || 0, losses: t.losses || 0, payload, updated_at: new Date().toISOString() };
}

/* 성과 집계(순수). rows = 일지 행(가벼운 목록: pos/shadow 별칭 또는 payload 로 읽음) */
function summarize(rows) {
  const by = {}, ord = rows.slice().sort((a, b) => a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0);
  const posOf = r => r.pos || (r.payload && r.payload.positions) || [];
  const shOf = r => r.shadow !== undefined ? r.shadow : (r.payload && r.payload.shadow) || null;
  for (const r of ord) {
    const g = by[r.strategy_id] = by[r.strategy_id] || { sid: r.strategy_id, name: r.strategy_name, kind: r.kind, rows: [] };
    g.name = r.strategy_name || g.name; g.rows.push(r);
  }
  const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const out = Object.values(by).map(g => {
    let cum = 0, peak = 0, dd = 0;
    const curve = g.rows.map(r => { cum += num(r.net) || 0; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); return { date: r.trade_date, net: num(r.net) || 0, cum: round(cum), status: r.status }; });
    const pos = g.rows.flatMap(posOf).filter(p => p && p.pnl != null);
    const wins = pos.filter(p => p.pnl > 0), losses = pos.filter(p => p.pnl < 0);
    const aw = wins.length ? sum(wins, p => p.pnl) / wins.length : null, al = losses.length ? sum(losses, p => p.pnl) / losses.length : null;
    const cost = sum(g.rows, r => num(r.cost)), net = sum(g.rows, r => num(r.net));
    const vers = {};
    g.rows.forEach(r => { const k = r.strategy_version == null ? 0 : r.strategy_version; const v = vers[k] = vers[k] || { version: r.strategy_version, days: 0, net: 0, cost: 0, wins: 0, n: 0 }; v.days++; v.net += num(r.net) || 0; v.cost += num(r.cost) || 0; const ps = posOf(r).filter(p => p && p.pnl != null); v.n += ps.length; v.wins += ps.filter(p => p.pnl > 0).length; });
    const sh = g.rows.map(shOf).filter(Boolean);
    return {
      sid: g.sid, name: g.name, kind: g.kind, days: g.rows.length, tradedDays: g.rows.filter(r => (num(r.cost) || 0) > 0).length, pending: g.rows.filter(r => r.status !== 'final').length,
      net: round(net), cost: round(cost), pct: cost > 0 ? +(net / cost * 100).toFixed(2) : null,
      n: pos.length, wins: wins.length, losses: losses.length, winRate: pos.length ? +(wins.length / pos.length * 100).toFixed(1) : null,
      avgWin: aw == null ? null : round(aw), avgLoss: al == null ? null : round(al), payoff: aw != null && al ? +(aw / Math.abs(al)).toFixed(2) : null,
      maxDrawdown: round(dd), curve,
      byVersion: Object.values(vers).map(v => ({ version: v.version, days: v.days, net: round(v.net), cost: round(v.cost), pct: v.cost > 0 ? +(v.net / v.cost * 100).toFixed(2) : null, n: v.n, winRate: v.n ? +(v.wins / v.n * 100).toFixed(1) : null })).sort((a, b) => (a.version || 0) - (b.version || 0)),
      shadow: sh.length ? { n: sh.length, all: mean(sh.map(s => s.all)), picked: mean(sh.map(s => s.picked)), bought: mean(sh.map(s => s.bought)) } : null,
    };
  });
  const dates = [...new Set(ord.map(r => r.trade_date))];
  let c = 0;
  const combined = dates.map(d => { c += sum(ord.filter(r => r.trade_date === d), r => num(r.net)); return { date: d, cum: round(c) }; });
  return { strategies: out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'intraday' ? -1 : 1)), combined, total: { net: round(sum(ord, r => num(r.net))), cost: round(sum(ord, r => num(r.cost))) } };
}

/* 텔레그램 요약 */
function daySummaryText(date, journals) {
  const L = [`📒 ${md(date)} 자동매매 일지`];
  let net = 0;
  for (const j of journals) {
    const t = j.totals, nm = `${ENG_TAG[j.engine] || ''}${j.letter ? j.letter + ' · ' : ''}${(j.strategy && j.strategy.name) || '전략'}`;
    if (!t.n) { L.push('', `■ ${nm}`, `매수 없음${j.decision ? (j.decision.kind === 'pass' ? ' (패스)' : j.decision.kind === 'expired' ? ' (승인 시간 초과)' : '') : ''}`); continue; }
    net += t.net;
    L.push('', `■ ${nm}`, `매수 ${t.n}종목 · 실현 ${sg(t.realized)}원${t.carried ? ` · 이월 ${t.carried}종목(평가 ${sg(t.carryMark)}원)` : ''}`, `순손익 ${sg(t.net)}원 (${sp(t.pct)}) · 수수료 ${fmt(t.fees)}원`);
    j.positions.forEach(p => L.push(`· ${p.name} ${sg(p.pnl)}원 (${sp(p.pct)})${p.state === 'closed' ? '' : p.state === 'carried' ? ' · 이월' : ' · 보유'}`));
  }
  if (journals.length > 1) L.push('', `합계 ${sg(net)}원`);
  L.push('', '종가베팅 결과는 다음 거래일 아침에 이어서 알려드려요. 자세한 내용은 사이트 자동매매 › 일지');
  return L.join('\n');
}
function closingText(date, j) {
  const t = j.totals, L = [`📒 ${md(date)} ${ENG_TAG[j.engine] || ''}이월분 종가베팅 결과`, `순손익 ${sg(t.net)}원 (${sp(t.pct)})`];
  j.positions.forEach(p => L.push(`· ${p.name}: ${p.sellQty ? `${fmt(p.sellQty)}주 평균 ${fmt(p.sellAvg)}원 매도 · 넘긴 가격 대비 ${sp(p.pct)}` : '매도 없음'}${p.gapCut ? ' · 갭 하락 전량' : ''}`));
  return L.join('\n');
}

/* 비교(순수): a = 실전 탭 전략 일지 행들, b = 가상 원본 일지 행들(같은 전략 조건). 겹치는 날만 */
function compareRows(a, b) {
  const posOf = r => (r.pos || (r.payload && r.payload.positions) || []).filter(p => p && p.qty > 0);
  const byB = Object.fromEntries((b || []).map(r => [r.trade_date, r]));
  const days = [];
  let both = 0, onlyReal = 0, onlySrc = 0, slipSum = 0, slipN = 0, pctDiffSum = 0, pctDiffN = 0, netA = 0, netB = 0, costA = 0, costB = 0;
  for (const ra of (a || []).slice().sort((x, y) => (x.trade_date < y.trade_date ? 1 : -1))) {
    const rb = byB[ra.trade_date];
    if (!rb) continue;
    const pa = posOf(ra), pb = posOf(rb), mb = Object.fromEntries(pb.map(p => [p.code, p]));
    const codes = [];
    for (const p of pa) {
      const q = mb[p.code];
      if (!q) { onlyReal++; codes.push({ code: p.code, name: p.name, real: pick(p), src: null }); continue; }
      both++;
      const slip = p.buyAvg > 0 && q.buyAvg > 0 ? +((p.buyAvg / q.buyAvg - 1) * 100).toFixed(2) : null;
      if (slip != null) { slipSum += slip; slipN++; }
      const dp = p.pct != null && q.pct != null ? +(p.pct - q.pct).toFixed(2) : null;
      if (dp != null) { pctDiffSum += dp; pctDiffN++; }
      codes.push({ code: p.code, name: p.name, real: pick(p), src: pick(q), slip, pctDiff: dp });
    }
    for (const q of pb) if (!pa.some(p => p.code === q.code)) { onlySrc++; codes.push({ code: q.code, name: q.name, real: null, src: pick(q) }); }
    netA += num(ra.net) || 0; netB += num(rb.net) || 0; costA += num(ra.cost) || 0; costB += num(rb.cost) || 0;
    days.push({ date: ra.trade_date, engine: engineOfRow(ra), status: ra.status, real: { net: num(ra.net), pct: num(ra.pct), cost: num(ra.cost), n: pa.length }, src: { net: num(rb.net), pct: num(rb.pct), cost: num(rb.cost), n: pb.length }, codes });
  }
  const pr = (n, c) => (c > 0 ? +(n / c * 100).toFixed(2) : null);
  return { days, totals: { days: days.length, both, onlyReal, onlySrc, slipAvg: slipN ? +(slipSum / slipN).toFixed(2) : null, pctDiffAvg: pctDiffN ? +(pctDiffSum / pctDiffN).toFixed(2) : null,
    real: { net: round(netA), cost: round(costA), pct: pr(netA, costA) }, src: { net: round(netB), cost: round(costB), pct: pr(netB, costB) } } };
}
const pick = p => ({ qty: p.qty, buyAvg: p.buyAvg, sellAvg: p.sellAvg == null ? null : p.sellAvg, pnl: p.pnl, pct: p.pct, state: p.state || null });

function createJournal(deps) {
  const D = deps, now = D.now || Date.now;
  const S = { at: {}, p1: {}, p2: {}, wk: {}, missing: 0, last: null };
  const due = (k, ms) => { const t = S.at[k] || 0; if (now() - t < ms) return false; S.at[k] = now(); return true; };
  const tg = t => (D.sendTelegram ? D.sendTelegram(t).catch(() => {}) : null);
  const inList = a => `(${a.map(encodeURIComponent).join(',')})`;

  const FILLS = { paper: 'paper_fills', dry: 'dry_fills', live: 'live_fills' };
  /* 실제 계좌 체결은 자동매매 것만(사람이 직접 낸 주문 체결은 뺌) — D.autoOnlyLive 가 주문 출처로 거름 */
  const onlyAuto = async (kind, rows) => (kind === 'live' && D.autoOnlyLive ? D.autoOnlyLive(rows || []) : (rows || []));
  async function loadFills(date, kind = 'paper') {
    const r = await D.sbGet(`${FILLS[kind] || FILLS.paper}?select=*&ts=gte.${encodeURIComponent(startIso(date))}&ts=lt.${encodeURIComponent(startIso(nextDate(date)))}&order=ts.asc&limit=5000`);
    return (await onlyAuto(kind, r)).map(normFill);
  }
  async function loadSellsAfter(codes, tsMs, kind = 'paper') {
    if (!codes.length) return [];
    const r = await D.sbGet(`${FILLS[kind] || FILLS.paper}?select=*&side=eq.sell&code=in.${inList(codes)}&ts=gte.${encodeURIComponent(new Date(tsMs).toISOString())}&order=ts.asc&limit=2000`);
    return (await onlyAuto(kind, r)).map(normFill);
  }
  async function loadCloses(date, codes) {
    if (!codes.length) return {};
    const r = await D.sbGet(`daily_price?select=code,close&trade_date=eq.${date}&code=in.${inList(codes)}&limit=2000`).catch(() => []);
    const m = {}; (r || []).forEach(x => { if (+x.close > 0) m[x.code] = +x.close; });
    return m;
  }
  async function loadDaily(date, codes) {   // 그날 일봉 고저(MFE·MAE 근사용)
    if (!codes.length) return {};
    const r = await D.sbGet(`daily_price?select=code,high,low&trade_date=eq.${date}&code=in.${inList(codes)}&limit=2000`).catch(() => []);
    const m = {}; (r || []).forEach(x => { if (+x.high > 0 && +x.low > 0) m[x.code] = { high: +x.high, low: +x.low }; });
    return m;
  }
  async function loadKospi(rows) {   // 코스피 지수(초과수익·주간 요약용) — 가장 오래된 일지 하루 전부터
    const dates = rows.map(r => r.trade_date).filter(Boolean).sort();
    if (!dates.length || !D.sbGet) return [];
    const from = PERF_ADD(dates[0], -7);
    return D.sbGet(`market_daily?select=trade_date,index_close&market=eq.KOSPI&trade_date=gte.${from}&order=trade_date.asc&limit=2000`).catch(() => []);
  }
  /* 지금 가격(장부별 보유의 현재가): { kind: { code: last } } */
  async function marksNow() {
    try { const ps = D.paper && D.paper.state ? await D.paper.state() : null; const m = {}; if (ps && ps.ok) ps.positions.forEach(p => { if (p.last > 0) { const k = p.kind || 'paper'; (m[k] = m[k] || {})[p.code] = p.last; } }); return m; } catch (_) { return {}; }
  }
  async function existingRows(date) {
    const r = await D.sbGet(`auto_journal?select=*&trade_date=eq.${date}&limit=20`).catch(e => { if (isMissing(e)) throw e; return []; });
    return Object.fromEntries((r || []).map(x => [x.strategy_id, x]));
  }

  /* 하루치 일지를 (다시) 만든다. phase: 1=15:40 이후 · 2=전환 이후 · 3=다음 거래일 이후 마무리. 같은 입력이면 같은 결과 */
  async function generateDay(date, { today, min, phase = 1, announce = true } = {}) {
    const runs = await D.readRuns(date);
    if (!runs.length) return { ok: true, none: true, date };
    const [carryAll, A, ex] = await Promise.all([D.readCarry().then(c => Object.values((c && c.items) || {})).catch(() => []), D.actives(), existingRows(date)]);
    const closingId = A.C && A.C.id;
    /* 장부(paper·dry·live)별로 체결을 읽어 그 장부로 산 실행에만 귀속 — 같은 종목을 가상·실전이 각자 사도 섞이지 않게 */
    const engOf = r => (D.engineOfRun ? D.engineOfRun(r) : 'paper');
    const kindOfItem = i => (D.kindOfCarry ? D.kindOfCarry(i) : (i.kind || 'paper'));
    const kinds = [...new Set([...runs.map(engOf), ...carryAll.filter(i => i.from === date).map(kindOfItem)])];
    const att = [];
    for (const k of kinds) {
      const fk = await loadFills(date, k).catch(e => { if (k === 'paper') throw e; return []; });   // 드라이런·실전 장부 테이블이 아직 없어도 가상 일지는 만든다
      att.push(...attribute(date, runs.filter(r => engOf(r) === k), fk, carryAll.filter(i => kindOfItem(i) === k), closingIdFor(closingId, k)).map(f => ({ ...f, kind: k })));
    }
    const want = new Set([...runs.flatMap(r => Object.keys((r.payload && r.payload.orders) || {})), ...runs.flatMap(r => ((r.payload && r.payload.shadow) || []).map(s => s.code))]);
    const closes = date < (today || '9999') ? await loadCloses(date, [...want]) : {};
    const marks = date === today ? await marksNow() : {};
    const exc = D.excursion ? await D.excursion().catch(() => null) : null;
    const daily = date <= (today || '9999') ? await loadDaily(date, [...want]) : {};
    const days = today ? daysBetween(date, today) : 0;
    const rowsOut = [], sums = [];
    const px0All = {};
    for (const run of runs) {
      const sid = run.strategy_id || (run.payload.strategy && run.payload.strategy.id), k = engOf(run);
      const prev = ex[sid] && ex[sid].payload ? ex[sid].payload : {};
      const j = buildIntraday({ date, run, fills: att.filter(f => f.sid === sid && f.leg === 'intraday' && f.kind === k), marks: marks[k] || {}, closes, prev: { px0: prev.px0, src: prev.px0src }, today, exc, daily, kind: k });
      // 공식 종가가 아직 없어도 4일이 지나면 확정(더 기다려도 오지 않음)
      if (!j.closeFinal && days >= 4) j.closeFinal = true;
      const settled = phase >= 2 || date < (today || '9999');
      const status = j.closeFinal ? 'final' : 'draft';
      j.tg = { ...(prev.tg || {}) };
      const wasSent = !!j.tg.day;
      if (announce && phase >= 1 && min != null && min >= JOURNAL_AT && date === today && !wasSent && (j.totals.n > 0)) j.tg.day = now();
      j.settled = settled;
      Object.entries(j.px0 || {}).forEach(([c, v]) => { px0All[`${k}|${c}`] = v; });
      rowsOut.push(toRow(date, sid, 'intraday', j.strategy, status, j));
      sums.push({ j, newlySent: !wasSent && !!j.tg.day });
    }
    // 종가베팅: 그날 넘겨받은 이월 종목(장부별로 따로 — 가상은 종가 전략 ID, 드라이런·실전은 closingdry-·closinglive- 행)
    const closings = [];
    for (const k of ['paper', 'dry', 'live']) {
      const items = carryAll.filter(i => i.from === date && kindOfItem(i) === k).map(i => ({ ...i, px0: px0All[`${k}|${i.code}`] || i.px0 || null }));
      if (!items.length || !A.C) continue;
      const cid = closingIdFor(A.C.id, k);
      const sells = await loadSellsAfter(items.map(i => i.code), Math.min(...items.map(i => i.at || Date.parse(startIso(date)))), k).catch(e => { if (k === 'paper') throw e; return []; });
      const c = buildClosing({ date, items, sells, engine: k, strategy: { id: cid, version: ex[cid] && ex[cid].strategy_version != null ? ex[cid].strategy_version : A.C.version, name: (A.C.name || '종가베팅') + ENG_NAME[k] } });
      const forced = items.every(i => i.state === 'done') || (today && daysBetween(date, today) >= 5);
      const prevC = ex[cid] && ex[cid].payload ? ex[cid].payload : {};
      c.tg = { ...(prevC.tg || {}) };
      const status = c.state === 'done' || forced ? 'final' : 'open';
      const newly = status === 'final' && !c.tg.final && (c.totals.n > 0);
      if (newly && announce && today && date < today) c.tg.final = now();
      rowsOut.push(toRow(date, cid, 'closing', c.strategy, status, c));
      closings.push({ c, newly: newly && announce && !!c.tg.final });
    }
    await D.sbWrite('auto_journal?on_conflict=trade_date,strategy_id', 'POST', rowsOut);
    // 텔레그램은 저장이 끝난 뒤에(보낸 표시가 먼저 저장돼 중복 발송이 없게)
    const send = sums.filter(s => s.newlySent).map(s => s.j);
    if (send.length) await tg(daySummaryText(date, send));
    for (const x of closings) if (x.newly) await tg(closingText(date, x.c));
    const c0 = closings.find(x => x.c.engine === 'paper') || closings[0];
    return { ok: true, date, journals: rowsOut.length, sent: send.length, closing: c0 ? c0.c.state : null };
  }

  /* 서버 30초 타이머에서 호출 — 시각이 됐고 아직 안 했을 때만 일한다 */
  /* E3: 금요일(휴장이면 그 주 마지막 거래일) 16:00 이후 주간 요약 텔레그램 — 주에 한 번(auto_config 'weekly') */
  async function sendWeekly(date, force) {
    const mon = PERF.mondayOf(date);
    if (!force) {
      const r = await D.sbGet('auto_config?select=value&key=eq.weekly&limit=1').catch(() => []);
      if (r && r[0] && r[0].value && r[0].value.last === mon) return { ok: true, skipped: 'sent' };
    }
    const wkAll = await D.sbGet(`auto_journal?select=${LIGHT}&trade_date=gte.${mon}&trade_date=lte.${date}&order=trade_date.asc&limit=200`);
    const allAll = await D.sbGet(`auto_journal?select=${LIGHT}&order=trade_date.desc&limit=900`).catch(() => []);
    const kospi = await D.sbGet(`market_daily?select=trade_date,index_close&market=eq.KOSPI&trade_date=gte.${PERF.addDays(mon, -7)}&order=trade_date.asc&limit=100`).catch(() => []);
    /* 주간 요약은 장부별로 따로(가상 · 드라이런 · 실전) — 성과가 섞이지 않게 */
    const texts = [];
    let sent = false;
    for (const k of ['paper', 'dry', 'live']) {
      const wk = (wkAll || []).filter(r => engineOfRow(r) === k), all = (allAll || []).filter(r => engineOfRow(r) === k);
      const ws = PERF.weekSummary(wk, kospi, date);
      if (!ws.strategies.length && k !== 'paper') continue;
      const exp = PERF.expectancy(PERF.tradesOf(all.filter(r => r.kind === 'intraday')));
      const text = (ENG_TAG[k] ? ENG_TAG[k] + '탭 ' : '') + PERF.weeklyText(ws, { exp });
      texts.push(text);
      if (ws.strategies.length && !force) { await tg(text); sent = true; }
    }
    if (!force) await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'weekly', value: { last: mon, at: now() }, updated_at: new Date().toISOString() }]);
    return { ok: true, sent, week: mon, text: texts.join('\n\n') };
  }
  async function tick(date, min, convertAt) {
    if (S.missing && now() - S.missing < 10 * 60e3) return { ok: true, idle: 'no-table' };
    const out = {};
    try {
      if (min >= JOURNAL_AT && !S.p1[date] && due('p1|' + date, 5 * 60e3)) { const r = await generateDay(date, { today: date, min, phase: 1 }); if (r.ok) S.p1[date] = true; out.day = r; }
      if (min >= (convertAt || 1200) + AFTER_CONVERT && !S.p2[date] && due('p2|' + date, 5 * 60e3)) { const r = await generateDay(date, { today: date, min, phase: 2 }); if (r.ok) S.p2[date] = true; out.convert = r; }
      if (min >= FINISH_AT && min < FINISH_END && due('p3|' + date, 10 * 60e3)) {
        const open = await D.sbGet(`auto_journal?select=trade_date&status=in.(draft,open)&trade_date=lt.${date}&order=trade_date.desc&limit=40`);
        const ds = [...new Set((open || []).map(x => x.trade_date))].slice(0, 6);
        out.finish = [];
        for (const d of ds) out.finish.push(await generateDay(d, { today: date, min, phase: 3 }));
      }
      if (min >= WEEKLY_AT && min < 1380 && D.isTradingDay && !S.wk[date] && PERF.isLastTradingDayOfWeek(date, D.isTradingDay) && due('wk|' + date, 5 * 60e3)) { const r = await sendWeekly(date); if (r.ok) S.wk[date] = true; out.weekly = r; }
      S.missing = 0;
    } catch (e) {
      if (isMissing(e)) { S.missing = now(); S.last = '자동 일지 테이블이 없습니다(DB 설정 auto_journal 필요)'; return { ok: false, err: S.last }; }
      S.last = e.message; return { ok: false, err: e.message };
    }
    return { ok: true, ...out };
  }

  const LIGHT = 'trade_date,strategy_id,kind,strategy_version,strategy_name,status,net,cost,pct,n_pos,wins,losses,memo,updated_at,pos:payload->positions,shadow:payload->shadow,regime:payload->regime,engine:payload->>engine';
  /* side = 'paper'(가상 탭) | 'real'(실전 탭: 드라이런·실전), engine = 'paper'|'dry'|'live'(그 장부만). 예전 행(장부 표시 없음)은 가상 */
  async function list({ sid, from, to, limit, side, engine } = {}) {
    const n = Math.min(Math.max(+limit || 400, 1), 1500);
    const q = [`select=${LIGHT}`, 'order=trade_date.desc,strategy_id.asc', `limit=${side || engine ? Math.min(n * 2, 3000) : n}`];
    if (sid && /^[a-z]+-[a-z0-9]{1,20}$/.test(sid)) q.push(`strategy_id=eq.${sid}`);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q.push(`trade_date=gte.${from}`);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) q.push(`trade_date=lte.${to}`);
    let rows;
    try { rows = await D.sbGet('auto_journal?' + q.join('&')); } catch (e) { if (isMissing(e)) return { ok: true, missing: true, rows: [], perf: summarize([]) }; throw e; }
    if (engine && ENG_NAME[engine] !== undefined) rows = (rows || []).filter(r => engineOfRow(r) === engine).slice(0, n);
    else if (side === 'real' || side === 'paper') rows = (rows || []).filter(r => sideOfEngine(engineOfRow(r)) === side).slice(0, n);
    const light = (rows || []).map(r => ({ date: r.trade_date, sid: r.strategy_id, kind: r.kind, engine: engineOfRow(r), version: r.strategy_version, name: r.strategy_name, status: r.status, net: num(r.net), cost: num(r.cost), pct: num(r.pct), n: r.n_pos || 0, wins: r.wins || 0, losses: r.losses || 0, hasMemo: !!(r.memo && r.memo.trim()), updatedAt: r.updated_at }));
    const kospi = await loadKospi(rows || []);
    const perf = summarize(rows || []);
    perf.extra = PERF.perfExtra(rows || [], kospi);
    const latest = (rows || []).map(r => r.trade_date).sort().pop();
    perf.weeks = latest ? [PERF.weekSummary(rows, kospi, latest), PERF.weekSummary(rows, kospi, PERF.addDays(PERF.mondayOf(latest), -3))] : [];
    return { ok: true, rows: light, perf };
  }
  /* 안전장치용: 한 전략의 일지 행(가벼운 형태) */
  async function raw(sid, limit = 400) {
    if (!/^[a-z]+-[a-z0-9]{1,20}$/.test(String(sid || ''))) return [];
    return (await D.sbGet(`auto_journal?select=${LIGHT}&strategy_id=eq.${sid}&order=trade_date.desc&limit=${limit}`).catch(() => [])) || [];
  }
  async function get(date, sid) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, status: 400, error: '날짜가 올바르지 않습니다' };
    const r = await D.sbGet(`auto_journal?select=*&trade_date=eq.${date}${sid ? `&strategy_id=eq.${encodeURIComponent(sid)}` : ''}&order=strategy_id.asc&limit=20`).catch(e => { if (isMissing(e)) return null; throw e; });
    if (!r) return { ok: true, missing: true, journals: [] };
    return { ok: true, journals: r.map(x => ({ date: x.trade_date, sid: x.strategy_id, kind: x.kind, version: x.strategy_version, name: x.strategy_name, status: x.status, net: num(x.net), cost: num(x.cost), pct: num(x.pct), memo: x.memo || '', payload: x.payload, updatedAt: x.updated_at })) };
  }
  async function memo(date, sid, text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^[a-z]+-[a-z0-9]{1,20}$/.test(String(sid || ''))) return { ok: false, status: 400, error: '날짜·전략이 올바르지 않습니다' };
    if (typeof text !== 'string') return { ok: false, status: 400, error: '메모가 올바르지 않습니다' };
    const t = text.replace(/\r/g, '').slice(0, MEMO_MAX);
    const r = await D.sbGet(`auto_journal?select=trade_date&trade_date=eq.${date}&strategy_id=eq.${encodeURIComponent(sid)}&limit=1`);
    if (!r.length) return { ok: false, status: 404, error: '그 날짜의 일지가 없습니다' };
    await D.sbWrite(`auto_journal?trade_date=eq.${date}&strategy_id=eq.${encodeURIComponent(sid)}`, 'PATCH', { memo: t });
    return { ok: true, memo: t, truncated: text.length > MEMO_MAX };
  }
  /* 사이트 "지금 다시 만들기" — 텔레그램은 보내지 않음 */
  async function run(date, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, status: 400, error: '날짜가 올바르지 않습니다' };
    if (date > today) return { ok: false, status: 400, error: '미래 날짜는 만들 수 없습니다' };
    const r = await generateDay(date, { today, min: null, phase: date < today ? 3 : 2, announce: false }).catch(e => { if (isMissing(e)) return { ok: false, status: 503, error: '자동 일지 테이블이 없습니다(DB 설정 auto_journal 필요)' }; throw e; });
    if (r.ok && r.none) return { ok: false, status: 404, error: '그 날짜의 자동매매 기록이 없습니다' };
    return r;
  }
  /* 실전 탭 전략 ↔ 가상 원본 비교(같은 날·같은 종목): 실전(또는 드라이런) 일지와 원본(가상) 일지를 날짜별로 맞춰
     매수가 차이(슬리피지)·수익률 차이·한쪽만 산 종목을 보여 준다. engine 을 주면 그 장부 행만(실전/드라이런 따로 비교) */
  async function compare({ sid, src, from, to, engine } = {}) {
    const ok = x => /^[a-z]+-[a-z0-9]{1,20}$/.test(String(x || ''));
    if (!ok(sid) || !ok(src)) return { ok: false, status: 400, error: '전략이 올바르지 않습니다' };
    const rng = [from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? `&trade_date=gte.${from}` : '', to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `&trade_date=lte.${to}` : ''].join('');
    const sel = 'trade_date,strategy_id,strategy_name,status,net,cost,pct,pos:payload->positions,funnel:payload->funnel,engine:payload->>engine';
    let a, b;
    try {
      [a, b] = await Promise.all([D.sbGet(`auto_journal?select=${sel}&strategy_id=eq.${sid}${rng}&order=trade_date.desc&limit=400`), D.sbGet(`auto_journal?select=${sel}&strategy_id=eq.${src}${rng}&order=trade_date.desc&limit=400`)]);
    } catch (e) { if (isMissing(e)) return { ok: true, missing: true, days: [] }; throw e; }
    a = (a || []).filter(r => engineOfRow(r) !== 'paper' && (!engine || engineOfRow(r) === engine));
    b = (b || []).filter(r => engineOfRow(r) === 'paper');
    return { ok: true, ...compareRows(a, b) };
  }
  return { tick, sendWeekly, generateDay, raw, list, get, memo, run, compare, status: () => ({ last: S.last, missing: !!S.missing }) };
}

module.exports = { attribute, buildIntraday, buildClosing, compareRows, closingIdFor, engineOfRow, summarize, toRow, daySummaryText, closingText, normFill, whyOf, createJournal, JOURNAL_AT, FINISH_AT, FINISH_END, AFTER_CONVERT, MEMO_MAX };
