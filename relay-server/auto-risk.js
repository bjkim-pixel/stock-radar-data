'use strict';
/* 자동매매 보강 E2-1(2026-11-16): 총 노출·최대 손실 계산 + 총액 상한 점검. 순수 함수(가상매매 상태를 받아 계산만).
   · 총 노출 = 자동매매가 들고 있는 종목의 평가금액 + 아직 체결 안 된 매수 주문 금액
   · 손절 시 손실 = 모든 종목이 손절선에서 팔렸을 때, 매수 평균가 대비 손실(손절선이 평균가 위로 올라간 종목은 0으로 봄 — 이익은 세지 않음)
   · 총액 상한(전략 조건값 totalCapKrw, 0 = 없음)은 새 주문이 상한을 넘기면 그 종목만 사지 않음(기존 보유는 건드리지 않음) */

const num = v => (Number.isFinite(+v) ? +v : 0);

/* ps: paper.state() 결과({positions, orders}), codes: 자동매매 종목 코드 집합(없으면 전부) */
function exposureOf(ps, codes) {
  const pos = ((ps && ps.positions) || []).filter(p => !codes || codes.has(p.code));
  const rows = pos.map(p => {
    const qty = num(p.qty), avg = num(p.avg), last = num(p.last) > 0 ? num(p.last) : avg, stop = num(p.stop) > 0 ? num(p.stop) : null;
    const cost = qty * avg, value = qty * last;
    const lossAtStop = stop != null && stop < avg ? qty * (avg - stop) : 0;      // 매수가 기준 손절 손실(양수로 표기)
    const lossFromNow = stop != null && stop < last ? qty * (last - stop) : 0;   // 지금 가격에서 손절선까지 더 빠질 수 있는 금액
    return { code: p.code, name: p.name || p.code, qty, avg, last, stop, cost, value, lossAtStop, lossFromNow, noStop: stop == null };
  });
  const pending = ((ps && ps.orders) || []).filter(o => o.side === 'buy' && (o.status === 'open' || o.status === 'partial') && (!codes || codes.has(o.code)))
    .reduce((a, o) => a + Math.max(0, num(o.qty) - num(o.filled)) * num(o.price), 0);
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const value = sum('value'), cost = sum('cost');
  return {
    n: rows.length, cost: Math.round(cost), value: Math.round(value), pending: Math.round(pending), total: Math.round(value + pending),
    lossAtStop: Math.round(sum('lossAtStop')), lossFromNow: Math.round(sum('lossFromNow')), noStop: rows.filter(r => r.noStop).length,
    pnl: Math.round(value - cost), rows,
  };
}

/* 새 매수(add 원)가 상한을 넘기는지. cap<=0 이면 항상 통과 */
function capCheck(cap, exp, add) {
  cap = num(cap);
  if (!(cap > 0)) return { ok: true };
  const now = num(exp && exp.total), next = now + num(add);
  if (next <= cap) return { ok: true, now, next, cap };
  return { ok: false, now, next, cap, why: `총액 상한 ${fmt(cap)}원 초과(현재 ${fmt(now)}원 + ${fmt(add)}원)` };
}
const fmt = v => Math.round(v).toLocaleString('ko-KR');

/* 화면·알림용 한 줄 */
function exposureLine(exp, cap) {
  if (!exp || (!exp.n && !exp.pending)) return null;
  const c = num(cap) > 0 ? ` · 상한 ${fmt(cap)}원(${Math.round(exp.total / cap * 100)}%)` : '';
  return `💼 총 노출 ${fmt(exp.total)}원(${exp.n}종목${exp.pending ? ` + 주문 ${fmt(exp.pending)}원` : ''}) · 모두 손절되면 −${fmt(exp.lossAtStop)}원${c}`;
}

module.exports = { exposureOf, capCheck, exposureLine };
