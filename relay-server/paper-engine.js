'use strict';
/* ════════════════════════════════════════════════════════════════════════
   가상매매 체결 시뮬레이터 — 순수 계산(네트워크·DB 없음) · 매매 3단계 (2026-11-12)
   KIS 모의투자를 쓰지 않고, 실전 시세·호가(읽기 전용)로 가상 체결을 계산합니다.
   규칙(보수적):
   · 즉시 체결  : 매수는 매도호가를 낮은 것부터, 매도는 매수호가를 높은 것부터 잔량만큼 소진. 한 번 쓴 잔량은 그 시세 안에서 다시 쓰지 않음
   · 시장가     : 10호가를 다 써도 남으면 마지막 호가보다 2호가단위 불리한 가격으로 체결(상·하한가 안에서)
   · 대기 주문  : 내 가격의 앞 대기 잔량(queueAhead)을 먼저 체결량이 소진한 뒤에야 체결. 가격이 내 가격을 지나쳐 거래됐을 때도 앞 잔량은 먼저 소진
   · 체결량 상한: 시세 조회 사이에 늘어난 거래량(누적거래량 차이)을 넘겨 체결하지 않음
   수수료·세금은 여기서 다루지 않음(기본 0, 호출하는 쪽이 설정값으로 계산)
   ════════════════════════════════════════════════════════════════════════ */
const TICKS = [[2000, 1], [5000, 5], [20000, 10], [50000, 50], [200000, 100], [500000, 500]];
const tickOf = p => { for (const [lim, t] of TICKS) if (p < lim) return t; return 1000; };
const floorTick = p => { const t = tickOf(p); return Math.floor(p / t + 1e-9) * t; };
const validTick = p => Number.isFinite(p) && p > 0 && Math.abs(p - floorTick(p)) < 1e-9;

const cloneBook = q => ({
  asks: (q.asks || []).map(x => ({ p: +x.p, q: +x.q })),
  bids: (q.bids || []).map(x => ({ p: +x.p, q: +x.q })),
});
const liveLevels = lv => lv.filter(l => l.p > 0 && l.q > 0);

/* 호가를 소진하며 체결. limit=null 이면 시장가.
   반환: { fills:[{p,q}], rem, hitLimit(가격 제한에 막혀 멈춤), noLiquidity(체결 가능한 호가가 아예 없음) } — book 을 직접 줄임 */
function takeBook(side, limit, qty, book) {
  const lv = side === 'buy' ? book.asks : book.bids;
  if (!liveLevels(lv).length) return { fills: [], rem: qty, hitLimit: limit != null, noLiquidity: true };
  const fills = []; let rem = qty, hitLimit = false;
  for (const l of lv) {
    if (rem <= 0) break;
    if (!(l.p > 0) || !(l.q > 0)) continue;
    if (limit != null && (side === 'buy' ? l.p > limit : l.p < limit)) { hitLimit = true; break; }
    const t = Math.min(rem, l.q);
    fills.push({ p: l.p, q: t }); l.q -= t; rem -= t;
  }
  return { fills, rem, hitLimit, noLiquidity: false };
}

/* 10호가를 다 써도 남은 수량의 체결가: 마지막 호가에서 2호가단위 불리하게, 상·하한가 안, 지정가 안 */
function penaltyPrice(side, q, limit) {
  const lv = liveLevels(side === 'buy' ? q.asks || [] : q.bids || []);   // 소진되기 전 원래 호가의 마지막 단계
  const last = lv.length ? lv[lv.length - 1].p : (q.price || 0);
  let p = side === 'buy' ? last + 2 * tickOf(last) : last - 2 * tickOf(Math.max(1, last - 1));
  p = floorTick(p);
  if (side === 'buy') { if (q.upper > 0) p = Math.min(p, q.upper); if (limit != null) p = Math.min(p, limit); }
  else { if (q.lower > 0) p = Math.max(p, q.lower); if (limit != null) p = Math.max(p, limit); }
  return p;
}

/* 지정가가 호가창에 걸릴 때 내 앞의 대기 잔량 */
function queueAhead(side, price, q) {
  const lv = liveLevels(side === 'buy' ? q.bids || [] : q.asks || []);
  const same = lv.find(l => l.p === price);
  if (same) return same.q;
  if (!lv.length) return 0;
  const edge = lv[lv.length - 1];                      // 10호가 맨 끝
  if (side === 'buy' ? price < edge.p : price > edge.p) return edge.q;   // 호가창 밖 = 끝 잔량으로 근사(보수적 추정)
  return 0;                                            // 호가 사이이거나 내가 최우선
}

/* 새 주문: 즉시 체결분을 계산하고 남으면 대기로.
   order: { side, type:'limit'|'market', price, qty }, q: 시세
   반환: { fills, rest(대기 수량), state:{queueAhead,lastVol,lowSeen,highSeen}, reject? } */
function submit(order, q) {
  const book = cloneBook(q), limit = order.type === 'limit' ? order.price : null;
  const t = takeBook(order.side, limit, order.qty, book);
  if (order.type === 'market' && t.noLiquidity) return { reject: '체결 가능한 호가가 없습니다', fills: [], rest: 0 };
  const fills = t.fills.slice(); let rem = t.rem;
  if (rem > 0 && !t.hitLimit && !t.noLiquidity) {       // 보이는 호가를 다 썼는데도 남음 → 불리한 가격으로 체결
    fills.push({ p: penaltyPrice(order.side, q, limit), q: rem }); rem = 0;
  }
  const rest = rem;
  return { fills, rest, state: restState(order, q, rest > 0) };
}
function restState(order, q, resting) {
  return {
    queueAhead: resting ? queueAhead(order.side, order.price, q) : 0,
    lastVol: q.vol || 0, lowSeen: q.low || null, highSeen: q.high || null,
  };
}

/* 대기 주문 1건을 새 시세로 갱신. o: { side, price, qty, filled, queueAhead, lastVol, lowSeen, highSeen }
   o 의 대기 상태(queueAhead 등)를 직접 갱신하고 새 체결 [{p,q}] 를 돌려줌(o.filled 는 호출하는 쪽이 올림) */
function restFill(o, q, sharedBook) {
  const rem = o.qty - (o.filled || 0);
  const out = [];
  if (rem <= 0) return out;
  const book = sharedBook || cloneBook(q);
  // 1) 호가가 내 가격을 넘어와 있으면(상대 호가가 내 가격 이내) 먼저 그 호가를 소진 — 내 가격보다 유리한 가격으로 체결
  const t = takeBook(o.side, o.price, rem, book);
  let left = rem;
  for (const f of t.fills) { out.push(f); left -= f.q; }
  // 2) 남은 수량: 체결(거래량) 기반
  const dv = o.lastVol == null ? 0 : Math.max(0, (q.vol || 0) - o.lastVol);   // 기준 거래량이 없으면(서버 재시작 직후) 이번엔 체결 인정 안 함
  const buy = o.side === 'buy';
  // 기준 저가·고가를 모르면(재시작·시세 출처 변경 직후) 새 저가·고가로 보지 않음 — 다른 시간대의 고저가로 '지나쳐 거래됨'을 잘못 판단하지 않게
  const newLow = q.low > 0 && o.lowSeen != null && q.low < o.lowSeen;
  const newHigh = q.high > 0 && o.highSeen != null && q.high > o.highSeen;
  const through = buy ? (q.price < o.price || (newLow && q.low < o.price)) : (q.price > o.price || (newHigh && q.high > o.price));
  const at = q.price === o.price;
  if (left > 0) {
    if (through) {
      const f = Math.min(left, Math.max(0, dv - (o.queueAhead || 0)));
      o.queueAhead = 0;
      if (f > 0) { out.push({ p: o.price, q: f }); left -= f; }
    } else if (at) {
      if (dv > (o.queueAhead || 0)) {
        const f = Math.min(left, dv - (o.queueAhead || 0)); o.queueAhead = 0;
        out.push({ p: o.price, q: f }); left -= f;
      } else o.queueAhead = (o.queueAhead || 0) - dv;
    }
  }
  o.lastVol = q.vol || 0;
  if (q.low > 0) o.lowSeen = o.lowSeen == null ? q.low : Math.min(o.lowSeen, q.low);
  if (q.high > 0) o.highSeen = o.highSeen == null ? q.high : Math.max(o.highSeen, q.high);
  return out;
}

/* 체결 목록 → 평균가·수량 */
function summarize(fills) {
  const qty = fills.reduce((a, f) => a + f.q, 0), amt = fills.reduce((a, f) => a + f.p * f.q, 0);
  return { qty, amt, avg: qty ? amt / qty : 0 };
}

/* 포지션에 체결 반영. pos: {qty, avg}|null. 반환 { pos(수량 0이면 null), realized } */
function applyFill(pos, side, price, qty) {
  const cur = pos ? { qty: pos.qty, avg: pos.avg } : { qty: 0, avg: 0 };
  if (side === 'buy') {
    const nq = cur.qty + qty;
    return { pos: { qty: nq, avg: (cur.avg * cur.qty + price * qty) / nq }, realized: 0 };
  }
  const sq = Math.min(qty, cur.qty), realized = (price - cur.avg) * sq, nq = cur.qty - sq;
  return { pos: nq > 0 ? { qty: nq, avg: cur.avg } : null, realized };
}

module.exports = { tickOf, floorTick, validTick, cloneBook, takeBook, penaltyPrice, queueAhead, submit, restFill, summarize, applyFill };
