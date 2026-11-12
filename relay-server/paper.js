'use strict';
/* ════════════════════════════════════════════════════════════════════════
   가상매매 (2026-11-12 · 매매 3단계) — KIS 모의투자 없이 자체 체결 시뮬레이터
   · 시세·호가: 실전 API 읽기 전용(trade.js getQuote). 주문 API 는 호출하지 않음(이 파일에는 주문 코드가 없음)
   · 주문·체결·보유는 Supabase paper_* 테이블에만 기록(서비스 키, relay 전용)
   · 모든 주문은 trade.js 의 로그인·거래 PIN 세션·한도·긴급 정지(guard/checkLimits)를 먼저 통과해야 함
   · 호가 10단계는 09:00·12:00·15:10(보유·미체결 종목)과 주문·체결 시점에만 저장, 14일 뒤 삭제
   ════════════════════════════════════════════════════════════════════════ */
const E = require('./paper-engine');

const MISSING = /42P01|PGRST205|does not exist/;
const SLOTS = [['open', 9 * 60], ['noon', 12 * 60], ['close', 15 * 60 + 10]];
const OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30, SNAP_WINDOW = 10, KEEP_DAYS = 14;
const rnd = () => Math.random().toString(36).slice(2, 6);

function createPaper(deps) {
  const now = deps.now || Date.now;
  const fees = deps.fees || { buy: 0, sell: 0 };   // % — 기본 0(수수료·세금 무시), 나중에 켜서 재계산할 수 있게 체결 행에 fee 를 따로 저장
  const orders = new Map(), positions = new Map(), lastPx = new Map();
  let fills = [];                                   // 오늘 체결(최신이 앞)
  const snapDone = new Set();
  const dirty = { orders: new Map(), fills: new Map(), pos: new Map() };
  let loaded = false, missing = false, ticking = false, lastPurge = '', persistAlerted = false;

  /* ── 시간 ── */
  const kst = () => {
    const d = new Date(now() + 9 * 3600e3);
    return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(), dow: d.getUTCDay() };
  };
  const dayStartIso = () => new Date(Date.parse(kst().day + 'T00:00:00+09:00')).toISOString();
  const fresh = q => {
    const h = /^(\d\d)(\d\d)(\d\d)$/.exec(String(q.hour || ''));
    if (!h) return false;
    const d = kst().sec - (+h[1] * 3600 + +h[2] * 60 + +h[3]);
    return d >= -5 && d <= 120;
  };
  /* 닫혀 있으면 이유를, 열려 있으면 null */
  async function closedReason(q) {
    const t = kst();
    if (t.dow === 0 || t.dow === 6) return '주말입니다';
    if (t.min < OPEN_MIN || t.min >= CLOSE_MIN) return '정규장 시간이 아닙니다(09:00~15:30)';
    if (deps.isOpenDay) { let o = null; try { o = await deps.isOpenDay(t.day); } catch (_) {} if (o === false) return '휴장일입니다'; }
    if (q && !fresh(q)) return '시세가 갱신되지 않고 있습니다(휴장·지연)';
    return null;
  }

  /* ── 행 변환 ── */
  const orderRow = o => ({
    id: o.id, created_at: new Date(o.createdAt).toISOString(), updated_at: new Date(o.updatedAt).toISOString(), code: o.code, name: o.name || null,
    side: o.side, type: o.type, price: o.price == null ? null : o.price, qty: o.qty, filled_qty: o.filled, avg_price: o.filled ? o.avg : null, status: o.status,
    queue_ahead: Math.round(o.queueAhead || 0), last_vol: o.lastVol == null ? null : Math.round(o.lastVol), low_seen: o.lowSeen, high_seen: o.highSeen,
    reason: o.reason || 'manual', plan: o.plan || null, note: o.note || null,
  });
  const fromOrder = r => ({
    id: r.id, createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at), code: r.code, name: r.name, side: r.side, type: r.type,
    price: r.price == null ? null : +r.price, qty: +r.qty, filled: +r.filled_qty || 0, avg: r.avg_price == null ? 0 : +r.avg_price, status: r.status,
    queueAhead: +r.queue_ahead || 0, lastVol: r.last_vol == null ? null : +r.last_vol, lowSeen: r.low_seen == null ? null : +r.low_seen, highSeen: r.high_seen == null ? null : +r.high_seen,
    reason: r.reason, plan: r.plan, note: r.note,
  });
  const posRow = p => ({ code: p.code, name: p.name || null, qty: p.qty, avg_price: p.avg, opened_at: new Date(p.openedAt).toISOString(), updated_at: new Date(p.updatedAt).toISOString(), plan: p.plan || null });
  const fromPos = r => ({ code: r.code, name: r.name, qty: +r.qty, avg: +r.avg_price, openedAt: Date.parse(r.opened_at), updatedAt: Date.parse(r.updated_at), plan: r.plan });
  const fillRow = f => ({ id: f.id, ts: new Date(f.ts).toISOString(), order_id: f.orderId, code: f.code, side: f.side, price: f.price, qty: f.qty, amount: f.amount, fee: f.fee, realized: f.realized, reason: f.reason });
  const fromFill = r => ({ id: r.id, ts: Date.parse(r.ts), orderId: r.order_id, code: r.code, side: r.side, price: +r.price, qty: +r.qty, amount: +r.amount, fee: +r.fee || 0, realized: r.realized == null ? null : +r.realized, reason: r.reason });

  /* ── 저장 ── */
  const W = (path, method, body) => deps.sbWrite(path, method, body);
  async function flush() {
    let err = null;
    for (const [id, o] of [...dirty.orders]) { try { await W('paper_orders', 'POST', [orderRow(o)]); dirty.orders.delete(id); } catch (e) { err = e; } }
    if (dirty.fills.size) {
      const rows = [...dirty.fills.values()];
      try { await W('paper_fills', 'POST', rows.map(fillRow)); for (const f of rows) dirty.fills.delete(f.id); } catch (e) { err = e; }
    }
    for (const [code, p] of [...dirty.pos]) {
      try { if (p) await W('paper_positions', 'POST', [posRow(p)]); else await W(`paper_positions?code=eq.${code}`, 'DELETE'); dirty.pos.delete(code); } catch (e) { err = e; }
    }
    if (err) {
      console.warn('[paper] 저장 실패(다시 시도 예정):', err.message);
      if (!persistAlerted) { persistAlerted = true; deps.alert && deps.alert('가상매매 기록 저장에 실패했습니다. 다음 주기에 다시 시도합니다.', '가상매매'); }
    } else persistAlerted = false;
    return !err;
  }
  async function snap(kind, code, q, orderId) {
    const row = { ts: new Date(now()).toISOString(), code, kind, price: q.price, asks: q.asks.filter(l => l.p > 0).map(l => [l.p, l.q]), bids: q.bids.filter(l => l.p > 0).map(l => [l.p, l.q]), order_id: orderId || null };
    try { await W('paper_book_snaps', 'POST', [row]); return true; } catch (e) { console.warn('[paper] 호가 스냅 저장 실패:', e.message); return false; }
  }

  /* ── 불러오기(서버 재시작 복구) ── */
  async function init() {
    if (loaded || !deps.sbGet) return loaded;
    try {
      const since = encodeURIComponent(dayStartIso());
      const [open, today, pos, fl, sn] = await Promise.all([
        deps.sbGet('paper_orders?select=*&status=in.(open,partial)&limit=500'),
        deps.sbGet(`paper_orders?select=*&created_at=gte.${since}&order=created_at.asc&limit=1000`),
        deps.sbGet('paper_positions?select=*&limit=200'),
        deps.sbGet(`paper_fills?select=*&ts=gte.${since}&order=ts.desc&limit=500`),
        deps.sbGet(`paper_book_snaps?select=code,kind&kind=in.(open,noon,close)&ts=gte.${since}&limit=1000`),
      ]);
      orders.clear(); positions.clear(); snapDone.clear();
      for (const r of [...open, ...today]) {
        const o = fromOrder(r);
        if (isOpen(o)) { o.lastVol = null; o.lowSeen = null; o.highSeen = null; }   // 재시작 사이의 거래량은 알 수 없으므로 첫 시세부터 다시 추적(그 사이 체결은 인정하지 않음 = 보수적)
        orders.set(r.id, o);
      }
      for (const r of pos) positions.set(r.code, fromPos(r));
      fills = fl.map(fromFill);
      const day = kst().day; for (const s of sn) snapDone.add(`${day}|${s.kind}|${s.code}`);
      loaded = true; missing = false;
      console.log(`[paper] 복구: 미체결 ${open.length}건 · 보유 ${pos.length}종목 · 오늘 체결 ${fl.length}건`);
    } catch (e) {
      if (MISSING.test(String(e.message))) { missing = true; }
      else console.warn('[paper] 불러오기 실패:', e.message);
      loaded = false;
    }
    return loaded;
  }

  /* ── 직렬화(주문·취소·체결 처리가 동시에 돌지 않게) ── */
  let chain = Promise.resolve();
  const lock = fn => { const p = chain.then(() => fn(), () => fn()); chain = p.catch(() => {}); return p; };

  /* ── 집계 ── */
  const isOpen = o => o.status === 'open' || o.status === 'partial';
  const reservedSell = code => [...orders.values()].filter(o => isOpen(o) && o.side === 'sell' && o.code === code).reduce((a, o) => a + (o.qty - o.filled), 0);
  function dayBuyKrw() {
    const since = Date.parse(dayStartIso());
    let sum = 0;
    for (const o of orders.values()) {
      if (o.side !== 'buy' || o.createdAt < since || o.status === 'rejected') continue;
      sum += isOpen(o) ? (o.price || o.avg || 0) * (o.qty - o.filled) + o.avg * o.filled : o.avg * o.filled;
    }
    return sum;
  }
  const heldCodes = () => { const s = new Set(positions.keys()); for (const o of orders.values()) if (isOpen(o) && o.side === 'buy') s.add(o.code); return s; };

  /* 체결을 주문·보유·체결 목록에 반영 */
  function applyFills(o, list, reasonOverride) {
    const out = [];
    for (const f of list) {
      if (!(f.q > 0) || !(f.p > 0)) continue;
      const pos = positions.get(o.code);
      const r = E.applyFill(pos ? { qty: pos.qty, avg: pos.avg } : null, o.side, f.p, f.q);
      o.avg = (o.avg * o.filled + f.p * f.q) / (o.filled + f.q); o.filled += f.q;
      const amount = f.p * f.q;
      const row = { id: `f${now().toString(36)}${rnd()}${out.length}`, ts: now(), orderId: o.id, code: o.code, side: o.side, price: f.p, qty: f.q, amount,
        fee: amount * (o.side === 'buy' ? fees.buy : fees.sell) / 100, realized: o.side === 'sell' ? r.realized : null, reason: reasonOverride || o.reason || 'manual' };
      out.push(row); fills.unshift(row); dirty.fills.set(row.id, row);
      if (r.pos) {
        const np = { code: o.code, name: o.name || (pos && pos.name), qty: r.pos.qty, avg: r.pos.avg, openedAt: pos ? pos.openedAt : now(), updatedAt: now(), plan: (o.side === 'buy' && o.plan) ? o.plan : (pos && pos.plan) || null };
        positions.set(o.code, np); dirty.pos.set(o.code, np);
      } else { positions.delete(o.code); dirty.pos.set(o.code, null); }
    }
    o.status = o.filled >= o.qty ? 'filled' : o.filled > 0 ? 'partial' : 'open';
    o.updatedAt = now();
    dirty.orders.set(o.id, o);
    if (fills.length > 600) fills.length = 600;
    return out;
  }

  /* ── 주문 ── */
  const bad = (status, error) => ({ ok: false, status, error });
  function cleanPlan(p) {
    if (!p || typeof p !== 'object') return null;
    const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
    const steps = Array.isArray(p.steps) ? p.steps.slice(0, 5).map(s => ({ n: Math.floor(num(s && s.n, 1, 5) || 0), p: num(s && s.p, 1, 1e8), q: Math.floor(num(s && s.q, 1, 1e7) || 0) })).filter(s => s.n && s.p && s.q) : [];
    return { stopPct: num(p.stopPct, 0.1, 50), stop: num(p.stop, 1, 1e8), target: num(p.target, 1, 1e8), steps };
  }
  async function place(body, req) {
    if (!(await init())) return bad(503, missing ? 'paper tables missing' : 'paper store unavailable');
    const code = String(body.code || ''), side = body.side, type = body.type, qty = Number(body.qty);
    if (!/^\d{6}$/.test(code)) return bad(400, 'bad code');
    if (side !== 'buy' && side !== 'sell') return bad(400, 'bad side');
    if (type !== 'limit' && type !== 'market') return bad(400, 'bad type');
    if (!Number.isInteger(qty) || qty < 1 || qty > 1e7) return bad(400, 'bad qty');
    const price = type === 'limit' ? Number(body.price) : null;
    if (type === 'limit' && !E.validTick(price)) return bad(400, '호가 단위에 맞지 않는 가격입니다');
    const g = deps.guard(side, 'VIRTUAL');
    if (!g.ok) return bad(403, g.error);
    let q;
    try { q = await deps.getQuote(code); } catch (_) { return bad(502, '시세를 가져오지 못했습니다'); }
    const closed = await closedReason(q);
    if (closed) return bad(409, closed);
    if (q.vi) return bad(409, 'VI 발동 중에는 주문할 수 없습니다');
    if ((q.warnings || []).includes('거래정지')) return bad(409, '거래정지 종목입니다');
    if (type === 'limit' && ((q.upper > 0 && price > q.upper) || (q.lower > 0 && price < q.lower))) return bad(400, '상·하한가 범위를 벗어났습니다');
    const name = String(body.name || '').slice(0, 40) || null;
    return lock(async () => {
      if (side === 'sell') {
        const pos = positions.get(code), avail = (pos ? pos.qty : 0) - reservedSell(code);
        if (qty > avail) return bad(400, `매도 가능 수량 부족 (가능 ${Math.max(0, avail)}주)`);
      } else {
        const ref = type === 'limit' ? price : ((q.asks.find(l => l.p > 0) || {}).p || q.price);
        const isNew = !heldCodes().has(code);
        const lim = deps.checkLimits({ mode: 'VIRTUAL', orderKrw: ref * qty, dayKrw: dayBuyKrw(), positions: heldCodes().size, isNewPosition: isNew });
        if (!lim.ok) return bad(403, lim.error);
      }
      const sub = E.submit({ side, type, price, qty }, q);
      if (sub.reject) return bad(409, sub.reject);
      const t = now();
      const o = { id: `o${t.toString(36)}${rnd()}`, createdAt: t, updatedAt: t, code, name, side, type, price, qty, filled: 0, avg: 0, status: 'open',
        queueAhead: sub.state.queueAhead, lastVol: sub.state.lastVol, lowSeen: sub.state.lowSeen, highSeen: sub.state.highSeen,
        reason: 'manual', plan: side === 'buy' ? cleanPlan(body.plan) : null, note: null };
      try { await W('paper_orders', 'POST', [orderRow(o)]); } catch (e) { console.warn('[paper] 주문 저장 실패:', e.message); return bad(503, '주문을 저장하지 못했습니다'); }
      orders.set(o.id, o);
      const f = applyFills(o, sub.fills);
      lastPx.set(code, { price: q.price, ts: t });
      await flush();
      snap(f.length ? 'fill' : 'order', code, q, o.id);
      return { ok: true, order: pubOrder(o), fills: f.map(pubFill) };
    });
  }
  function cancel(id) {
    return lock(async () => {
      if (!(await init())) return bad(503, 'paper store unavailable');
      const o = orders.get(String(id || ''));
      if (!o) return bad(404, '주문을 찾을 수 없습니다');
      if (!isOpen(o)) return bad(409, '이미 끝난 주문입니다');
      o.status = 'cancelled'; o.updatedAt = now(); dirty.orders.set(o.id, o);
      await flush();
      return { ok: true, order: pubOrder(o) };
    });
  }

  /* ── 조회 ── */
  const pubOrder = o => ({ id: o.id, ts: o.createdAt, code: o.code, name: o.name, side: o.side, type: o.type, price: o.price, qty: o.qty, filled: o.filled, avg: o.filled ? o.avg : null, status: o.status, queueAhead: o.queueAhead, reason: o.reason });
  const pubFill = f => ({ id: f.id, ts: f.ts, orderId: f.orderId, code: f.code, side: f.side, price: f.price, qty: f.qty, amount: f.amount, fee: f.fee, realized: f.realized, reason: f.reason });
  async function state() {
    if (!(await init())) return bad(503, missing ? 'paper tables missing' : 'paper store unavailable');
    const since = Date.parse(dayStartIso());
    const list = [...orders.values()].filter(o => isOpen(o) || o.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
    const todayFills = fills.filter(f => f.ts >= since);
    const reason = await closedReason(null);
    return {
      ok: true, now: now(), market: { open: !reason, reason },
      positions: [...positions.values()].map(p => ({ code: p.code, name: p.name, qty: p.qty, avg: p.avg, plan: p.plan, last: (lastPx.get(p.code) || {}).price || null })),
      orders: list.map(pubOrder), fills: todayFills.slice(0, 60).map(pubFill),
      dayBuyKrw: Math.round(dayBuyKrw()), realizedToday: Math.round(todayFills.reduce((a, f) => a + (f.realized || 0), 0)),
      limits: deps.limits || null,
    };
  }

  /* ── 장중 루프: 대기 주문 체결 판단 + 호가 스냅 + 14일 지난 스냅 삭제 ── */
  async function tick() {
    if (ticking || !deps.enabled()) return;
    ticking = true;
    try {
      if (!(await init())) return;
      if (dirty.orders.size || dirty.fills.size || dirty.pos.size) await lock(flush);
      const t = kst();
      if (lastPurge !== t.day) {
        lastPurge = t.day;
        const cut = new Date(now() - KEEP_DAYS * 86400e3).toISOString();
        W(`paper_book_snaps?ts=lt.${encodeURIComponent(cut)}`, 'DELETE').catch(e => console.warn('[paper] 오래된 스냅 삭제 실패:', e.message));
      }
      if (t.dow === 0 || t.dow === 6 || t.min < OPEN_MIN || t.min >= CLOSE_MIN) return;
      const codes = new Set([...heldCodes()]);
      for (const o of orders.values()) if (isOpen(o)) codes.add(o.code);
      for (const code of codes) {
        let q; try { q = await deps.getQuote(code); } catch (_) { continue; }
        if (await closedReason(q)) continue;
        lastPx.set(code, { price: q.price, ts: now() });
        await lock(async () => {
          const shared = E.cloneBook(q); let any = false;
          for (const o of [...orders.values()].filter(x => isOpen(x) && x.code === code).sort((a, b) => a.createdAt - b.createdAt)) {
            const before = o.queueAhead, list = E.restFill(o, q, shared);
            if (list.length) { applyFills(o, list); any = true; }
            else if (o.queueAhead !== before) dirty.orders.set(o.id, o);   // 대기 큐 위치가 줄었을 때만 저장(재시작 복구용)
          }
          await flush();
          if (any) snap('fill', code, q);
        });
        for (const [kind, at] of SLOTS) {
          const key = `${t.day}|${kind}|${code}`;
          if (t.min >= at && t.min < at + SNAP_WINDOW && !snapDone.has(key) && (positions.has(code) || [...orders.values()].some(o => isOpen(o) && o.code === code))) {
            if (await snap(kind, code, q)) snapDone.add(key);
          }
        }
      }
    } catch (e) { console.warn('[paper] 루프 오류:', e.message); }
    finally { ticking = false; }
  }
  let timer = null;
  function start(ms = 5000) { if (timer) return; timer = setInterval(() => { tick(); }, ms); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { place, cancel, state, tick, start, stop, init, _orders: orders, _positions: positions, _dirty: dirty };
}

module.exports = { createPaper };
