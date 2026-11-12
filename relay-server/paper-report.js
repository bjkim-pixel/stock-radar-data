'use strict';
/* ════════════════════════════════════════════════════════════════════════
   가상매매 성과 리포트 (매매 5단계) — 순수 계산(네트워크·DB 없음)
   · 기간 요약: 실현손익·평가손익·합계·실현 수익률(실현손익 ÷ 판 주식의 매수원가)·같은 기간 코스피 등락률
   · 종목별 수익, 월별 실현손익(+누적), 매매 통계(승률·평균 이익/손실·손익비·손절 비율·평균 보유일)
   · 슬리피지(시장가·손절 주문의 기준가 대비 불리한 정도)·지정가 체결 지연/체결률
   · 주문 내역(출처: 직접·자동 익절·자동 손절·장 시작 재접수)·거부된 요청
   "한 번의 매매" = 보유 수량이 0에서 시작해 다시 0이 될 때까지(그 사이 추가 매수·분할 매도 포함)
   손익은 수수료·세금 차감 전. fee 합계는 따로 보여줌
   ════════════════════════════════════════════════════════════════════════ */
const kstDay = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const r2 = x => Math.round(x * 100) / 100;

function sourceOf(o) {
  if (o.reason === 'stop') return '자동 손절';
  if (/^tp[1-5]$/.test(o.reason || '')) return o.note === 'reopen' ? `장 시작 재접수(익절 ${o.reason.slice(2)}단계)` : `자동 익절 ${o.reason.slice(2)}단계`;
  return '직접 주문';
}

/* 보유 0 → 0 을 한 번의 매매로 묶음 */
function roundTrips(fills) {
  const by = new Map();
  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    if (!by.has(f.code)) by.set(f.code, []);
    by.get(f.code).push(f);
  }
  const out = [];
  for (const [code, list] of by) {
    let qty = 0, cur = null;
    for (const f of list) {
      if (f.side === 'buy') {
        if (qty === 0) cur = { code, openTs: f.ts, buyAmt: 0, sellAmt: 0, realized: 0, fee: 0, endedBy: null };
        qty += f.qty; cur.buyAmt += f.amount; cur.fee += f.fee || 0;
      } else if (cur) {
        qty -= f.qty; cur.sellAmt += f.amount; cur.realized += f.realized || 0; cur.fee += f.fee || 0;
        if (qty <= 0) { cur.closeTs = f.ts; cur.endedBy = f.reason || 'manual'; out.push(cur); cur = null; qty = 0; }
      }
    }
  }
  return out;
}

/* from/to: 'YYYY-MM-DD'(KST, 포함). positions: [{code,name,qty,avg,last}] 지금 보유. kospi: [{trade_date,index_close}] 오름차순 */
function computeReport({ fills = [], orders = [], positions = [], kospi = [], rejects = [], from, to, names = {} }) {
  const inR = ms => { const d = kstDay(ms); return (!from || d >= from) && (!to || d <= to); };
  const oById = new Map(orders.map(o => [o.id, o]));
  const F = fills.filter(f => inR(f.ts));
  const nameOf = c => names[c] || (positions.find(p => p.code === c) || {}).name || (orders.find(o => o.code === c && o.name) || {}).name || c;

  // 기간 요약
  const sells = F.filter(f => f.side === 'sell'), buys = F.filter(f => f.side === 'buy');
  const realized = sells.reduce((a, f) => a + (f.realized || 0), 0);
  const costSold = sells.reduce((a, f) => a + (f.amount - (f.realized || 0)), 0);
  const unrealized = positions.reduce((a, p) => a + (p.last ? (p.last - p.avg) * p.qty : 0), 0);
  let kospiPct = null;
  if (kospi.length) {
    const before = kospi.filter(k => !from || k.trade_date < from), within = kospi.filter(k => (!from || k.trade_date >= from) && (!to || k.trade_date <= to));
    const base = before.length ? +before[before.length - 1].index_close : (within.length ? +within[0].index_close : null);
    const end = within.length ? +within[within.length - 1].index_close : null;
    if (base && end) kospiPct = r2((end / base - 1) * 100);
  }
  const summary = {
    realized: Math.round(realized), unrealized: Math.round(unrealized), total: Math.round(realized + unrealized),
    retPct: costSold > 0 ? r2(realized / costSold * 100) : null, kospiPct,
    buyAmt: Math.round(buys.reduce((a, f) => a + f.amount, 0)), sellAmt: Math.round(sells.reduce((a, f) => a + f.amount, 0)),
    fee: Math.round(F.reduce((a, f) => a + (f.fee || 0), 0)), fills: F.length,
  };

  // 매매(0→0) 단위
  const trips = roundTrips(fills).filter(t => inR(t.closeTs));
  const wins = trips.filter(t => t.realized > 0), losses = trips.filter(t => t.realized <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.realized, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.realized, 0) / losses.length : null;
  const stats = {
    trades: trips.length, wins: wins.length, winRate: trips.length ? r2(wins.length / trips.length * 100) : null,
    avgWin: avgWin == null ? null : Math.round(avgWin), avgLoss: avgLoss == null ? null : Math.round(avgLoss),
    payoff: avgWin != null && avgLoss ? r2(avgWin / Math.abs(avgLoss)) : null,
    stopRate: trips.length ? r2(trips.filter(t => t.endedBy === 'stop').length / trips.length * 100) : null,
    avgHoldDays: trips.length ? r2(trips.reduce((a, t) => a + (t.closeTs - t.openTs) / 86400e3, 0) / trips.length) : null,
  };

  // 종목별
  const byCode = new Map();
  const row = c => { if (!byCode.has(c)) byCode.set(c, { code: c, name: nameOf(c), buyAmt: 0, sellAmt: 0, realized: 0, costSold: 0, trades: 0, unrealized: 0, qty: 0 }); return byCode.get(c); };
  for (const f of F) { const r = row(f.code); if (f.side === 'buy') r.buyAmt += f.amount; else { r.sellAmt += f.amount; r.realized += f.realized || 0; r.costSold += f.amount - (f.realized || 0); } }
  for (const t of trips) row(t.code).trades++;
  for (const p of positions) { const r = row(p.code); r.qty = p.qty; r.unrealized = p.last ? (p.last - p.avg) * p.qty : 0; }
  const codes = [...byCode.values()].map(r => ({ ...r, buyAmt: Math.round(r.buyAmt), sellAmt: Math.round(r.sellAmt), realized: Math.round(r.realized), unrealized: Math.round(r.unrealized),
    realizedPct: r.costSold > 0 ? r2(r.realized / r.costSold * 100) : null, costSold: undefined }))
    .sort((a, b) => (b.realized + b.unrealized) - (a.realized + a.unrealized));

  // 월별(전체 기간, 기간 선택과 무관)
  const mon = new Map();
  for (const f of fills) if (f.side === 'sell') { const m = kstDay(f.ts).slice(0, 7); mon.set(m, (mon.get(m) || 0) + (f.realized || 0)); }
  let cum = 0;
  const monthly = [...mon.keys()].sort().map(m => { cum += mon.get(m); return { month: m, realized: Math.round(mon.get(m)), cum: Math.round(cum) }; });

  // 슬리피지: 시장가·손절 주문의 평균 체결가가 기준가(주문 순간 매도/매수 1호가, 손절은 손절가)보다 불리한 정도
  const agg = new Map();
  const fillByOrder = new Map();
  for (const f of F) { if (!fillByOrder.has(f.orderId)) fillByOrder.set(f.orderId, []); fillByOrder.get(f.orderId).push(f); }
  const delays = []; let limQty = 0, limFilled = 0;
  for (const [oid, list] of fillByOrder) {
    const o = oById.get(oid); if (!o) continue;
    const qty = list.reduce((a, f) => a + f.qty, 0), avg = list.reduce((a, f) => a + f.amount, 0) / qty;
    if ((o.type === 'market' || o.reason === 'stop') && o.refPrice > 0) {
      const adv = o.side === 'buy' ? (avg - o.refPrice) / o.refPrice : (o.refPrice - avg) / o.refPrice;
      const k = o.reason === 'stop' ? '손절(시장가)' : o.side === 'buy' ? '시장가 매수' : '시장가 매도';
      const a = agg.get(k) || { kind: k, n: 0, pctSum: 0, krw: 0, worst: -Infinity };
      a.n++; a.pctSum += adv * 100; a.krw += adv * o.refPrice * qty; a.worst = Math.max(a.worst, adv * 100); agg.set(k, a);
    }
    if (o.type === 'limit') { const first = Math.min(...list.map(f => f.ts)); delays.push((first - o.createdAt) / 60000); }
  }
  for (const o of orders) if (o.type === 'limit' && inR(o.createdAt) && !['open', 'partial'].includes(o.status)) { limQty += o.qty; limFilled += o.filled; }
  const slippage = {
    rows: [...agg.values()].map(a => ({ kind: a.kind, orders: a.n, avgPct: r2(a.pctSum / a.n), krw: Math.round(a.krw), worstPct: r2(a.worst) })),
    limitFillRate: limQty ? r2(limFilled / limQty * 100) : null,
    limitDelayMin: delays.length ? r2(delays.reduce((a, x) => a + x, 0) / delays.length) : null,
  };

  // 주문 내역(기간, 최신순)
  const list = orders.filter(o => inR(o.createdAt)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(o => ({
    id: o.id, ts: o.createdAt, code: o.code, name: o.name || nameOf(o.code), side: o.side, type: o.type, price: o.price, qty: o.qty,
    filled: o.filled, avg: o.filled ? o.avg : null, status: o.status, source: sourceOf(o), note: o.note || null,
  }));

  return { ok: true, from, to, summary, stats, codes, monthly, slippage, orders: list, rejects: rejects.slice(0, 200) };
}

module.exports = { computeReport, roundTrips, sourceOf, kstDay };
