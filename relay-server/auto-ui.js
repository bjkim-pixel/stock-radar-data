'use strict';
/* 자동매매 4단계 — 사이트 "자동매매" 카드가 쓰는 조회·성과 계산(순수 함수 + 얇은 조립)
   입력은 auto_runs / auto_config / paper_fills 행. 계산은 전부 여기서 하고 화면은 그리기만 한다. */

const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const kstDate = ts => new Date(Date.parse(ts) + 9 * 3600e3).toISOString().slice(0, 10);

/* auto_runs 한 행 → 화면용 요약(큰 payload 를 그대로 보내지 않음). full=true 면 오늘용(후보 지표·사유 포함) */
function summarizeRun(r, full) {
  const p = (r && r.payload) || {}, ords = p.orders || {};
  const names = {}; (p.picks || []).forEach(x => { names[x.code] = x.name; }); (p.shadow || []).forEach(x => { if (!names[x.code]) names[x.code] = x.name; });
  const sid = r.strategy_id || (p.strategy && p.strategy.id) || 'intraday-default';
  const out = {
    date: r.trade_date, status: r.status, sid, key: `${r.trade_date}|${sid}`, letter: p.letter || null,
    decision: p.decision ? { kind: p.decision.kind, nums: p.decision.nums || null } : null,
    warn: p.warn || null, noticeSent: !!p.noticeSent,
    picks: (p.picks || []).map(x => full
      ? { code: x.code, name: x.name, score: x.score, price: x.price, open: x.open, changePct: x.changePct, sector: x.sector, smx: x.smx, reasons: x.reasons || [], m: x.m || null, parts: x.parts || null, ratio: x.ratio || null, ev: x.ev || [] }
      : { code: x.code, name: x.name, score: x.score, price: x.price }),
    orders: Object.entries(ords).map(([code, v]) => ({ code, name: names[code] || code, st: v.st, filled: v.filled || 0, avg: v.avg || null, buy: v.buy || null, qty: v.qty || null, why: v.why || null,
      ...(full ? { buy2: v.buy2 || null, target: v.target || (v.plan && v.plan.target) || null, mode: v.mode || null, pick: v.pick || null, plan: v.plan || null, snap: v.snap || null,
        at: v.at || null, placedAt: v.placedAt || null, modifiedAt: v.modifiedAt || null, filledAt: v.filledAt || null, cancelledAt: v.cancelledAt || null, lowSeen: v.lowSeen || null, noReprice: !!v.noReprice } : {}) })),
    shadow: (p.shadow || []).map(s => ({ code: s.code, name: s.name, price: s.price, score: s.score, changePct: s.changePct, picked: !!s.picked })),
    stat: p.stat || null,
    eod: p.eod ? { at: p.eod.at, none: !!p.eod.none, items: (p.eod.items || []).map(i => ({ code: i.code, name: i.name, ok: !!i.ok, why: i.why || [] })), decision: p.eod.decision ? { kind: p.eod.decision.kind, timeout: !!p.eod.decision.timeout } : null } : null,
    carry: p.carryDone ? (p.carryDone.codes || []) : null,
    strategy: p.strategy || null, regime: p.regime || null, events: p.events || [],
  };
  if (full) {
    out.rejected = (p.rejected || []).map(x => ({ code: x.code, name: x.name, changePct: x.changePct, fails: x.fails || [] }));
    out.dropped = (p.dropped || []).map(x => ({ code: x.code, why: x.why }));
    out.decisionAt = p.decision && p.decision.at || null; out.noticeAt = p.noticeAt || null; out.selectedAt = p.selectedAt || null;
    out.weak = p.eod && p.eod.weak || [];
    out.log = Array.isArray(p.log) ? p.log : [];   // F1 진행 기록(시각순)
    out.shadow = (p.shadow || []).map(s => ({ code: s.code, name: s.name, price: s.price, score: s.score, changePct: s.changePct, picked: !!s.picked, parts: s.parts || null }));
  }
  return out;
}

/* 매도 체결 → 가장 가까운 지난 실행(그 종목을 실제로 산 날)에 실현손익을 붙임. sells: [{code, ts, realized}] */
function attributeRealized(runs, sells) {
  const byDate = runs.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const res = {};
  const K = r => r.key || r.date;
  byDate.forEach(r => { res[K(r)] = { realized: 0, n: 0 }; });
  for (const s of sells) {
    const d = kstDate(s.ts);
    let hit = null;
    for (const r of byDate) { if (r.date <= d && r.orders.some(o => o.code === s.code && o.filled > 0)) hit = r; }   // 날짜 오름차순이라 마지막 일치 = 가장 최근
    if (hit) { res[K(hit)].realized += +s.realized || 0; res[K(hit)].n++; }
  }
  return res;
}

/* 그림자 비교: 선정 시점 가격 → 그날 종가 수익률(%). closes: { 'YYYY-MM-DD': { code: close } } */
function shadowReturns(run, closes) {
  const cl = closes[run.date] || {};
  const ret = (price, code) => (price > 0 && cl[code] > 0) ? (cl[code] / price - 1) * 100 : null;
  const all = run.shadow.map(s => ret(s.price, s.code)), picked = run.shadow.filter(s => s.picked).map(s => ret(s.price, s.code));
  const bought = run.orders.filter(o => o.filled > 0 && o.avg).map(o => ret(o.avg, o.code));
  const n = a => a.filter(x => x != null).length;
  return { all: mean(all), allN: n(all), picked: mean(picked), pickedN: n(picked), bought: mean(bought), boughtN: n(bought) };
}

/* 일별 성과 표 + 누적. runs: 최신순 summarizeRun 배열, realized: attributeRealized 결과, closes */
function buildHistory(runs, realized, closes, today) {
  const rows = runs.map(r => {
    const cost = r.orders.reduce((a, o) => a + (o.filled || 0) * (o.avg || 0), 0);
    const re = realized[r.key || r.date] || { realized: 0, n: 0 };
    const sh = r.date < today ? shadowReturns(r, closes) : null;
    return {
      date: r.date, status: r.status, decision: r.decision, sid: r.sid || null, strategy: r.strategy ? r.strategy.name : null,
      picks: r.picks.length, shadowN: r.shadow.length,
      bought: r.orders.filter(o => o.filled > 0).map(o => ({ code: o.code, name: o.name, qty: o.filled, avg: o.avg })),
      cost: Math.round(cost), realized: Math.round(re.realized), sells: re.n,
      pct: cost > 0 && re.n > 0 ? re.realized / cost * 100 : null,
      shadow: sh,
    };
  });
  const done = rows.filter(r => r.cost > 0 && r.sells > 0);
  const totals = {
    days: rows.length, tradedDays: rows.filter(r => r.cost > 0).length, doneDays: done.length,
    realized: done.reduce((a, r) => a + r.realized, 0), cost: done.reduce((a, r) => a + r.cost, 0),
    wins: done.filter(r => r.realized > 0).length,
    shadowAll: mean(rows.map(r => r.shadow && r.shadow.all)), shadowPicked: mean(rows.map(r => r.shadow && r.shadow.picked)), shadowBought: mean(rows.map(r => r.shadow && r.shadow.bought)),
  };
  totals.pct = totals.cost > 0 ? totals.realized / totals.cost * 100 : null;
  return { rows, totals };
}

/* 설정 검증: { on?: boolean, perStockKrw?: 정수(원) } → 정리된 값 또는 에러 문자열 */
const PER_MIN = 100000, PER_MAX = 50000000, PER_STEP = 10000;
function checkConfig(b) {
  const out = {};
  if (b && b.on !== undefined) { if (typeof b.on !== 'boolean') return { err: 'on 값이 올바르지 않습니다' }; out.on = b.on; }
  if (b && b.perStockKrw !== undefined) {
    const v = +b.perStockKrw;
    if (!Number.isInteger(v) || v < PER_MIN || v > PER_MAX || v % PER_STEP) return { err: `종목당 금액은 ${PER_MIN.toLocaleString('ko-KR')}~${PER_MAX.toLocaleString('ko-KR')}원, ${PER_STEP.toLocaleString('ko-KR')}원 단위여야 합니다` };
    out.perStockKrw = v;
  }
  if (!Object.keys(out).length) return { err: '바꿀 값이 없습니다' };
  return { val: out };
}

module.exports = { summarizeRun, attributeRealized, shadowReturns, buildHistory, checkConfig, kstDate, PER_MIN, PER_MAX, PER_STEP };
