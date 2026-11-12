'use strict';
/* ════════════════════════════════════════════════════════════════════════
   가상매매 (매매 3~4단계) — KIS 모의투자 없이 자체 체결 시뮬레이터 + 자동 매도 엔진
   · 시세·호가: 실전 API 읽기 전용(trade.js getQuote). KIS 주문 API 는 호출하지 않음(이 파일에는 주문 전송 코드가 없음)
   · 주문·체결·보유는 Supabase paper_* 테이블에만 기록(서비스 키, relay 전용)
   · 사람이 내는 주문은 trade.js 의 로그인·거래 PIN 세션·한도·긴급 정지(guard/checkLimits)를 먼저 통과
   · 자동 매도(4단계): 보유 종목마다 익절 1~5단계 지정가 매도를 걸어두고, 현재가가 손절가 이하가 되면
     남은 매도 주문을 모두 취소한 뒤 남은 수량 전부를 시장가로 매도. 장 마감에 당일 주문은 소멸하고
     다음 거래일 첫 시세에서 다시 접수. 긴급 정지 중에도 매도(손절·익절)는 계속함(정지는 신규 매수만 막음)
   · 호가 10단계는 09:00·12:00·15:10(보유·미체결 종목)과 사람 주문·체결·손절 시점에만 저장, 14일 뒤 삭제
   ════════════════════════════════════════════════════════════════════════ */
const E = require('./paper-engine');
const { computeReport } = require('./paper-report');

const MISSING = /42P01|PGRST205|does not exist/;
const SLOTS = [['open', 9 * 60], ['noon', 12 * 60], ['close', 15 * 60 + 10]];
const OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30, SNAP_WINDOW = 10, KEEP_DAYS = 14;
const rnd = () => Math.random().toString(36).slice(2, 6);
const isTp = o => /^tp[1-5]$/.test(String(o.reason || ''));

/* 익절 단계 수량 배분(순수 함수).
   steps: [{n,p,q(원래 계획 수량 = 비중),sold(이미 판 수량)}], avail: 지금 익절에 쓸 수 있는 보유 수량
   계획 전체 수량 base = avail + Σsold 를 원래 비중대로 나눈 뒤(최대 나머지 방식), 이미 판 만큼 뺀다.
   반환: { n: 걸어둘 수량 } — 합계는 항상 avail */
function allocSteps(steps, avail) {
  const S = (steps || []).filter(s => s.q > 0).sort((a, b) => a.n - b.n);
  const out = {};
  for (const s of S) out[s.n] = 0;
  if (!S.length || avail <= 0) return out;
  const sold = S.reduce((a, s) => a + (s.sold || 0), 0), base = avail + sold, W = S.reduce((a, s) => a + s.q, 0);
  // 최대 나머지 방식: 비중대로 내림 배분 후 남는 주식은 소수점이 큰 단계부터(같으면 앞 단계 = 낮은 가격부터) 1주씩
  const quota = S.map(s => base * s.q / W), target = quota.map(Math.floor);
  let left = base - target.reduce((a, x) => a + x, 0);
  const order = S.map((s, i) => i).sort((a, b) => (quota[b] - target[b]) - (quota[a] - target[a]) || a - b);
  for (const i of order) { if (left <= 0) break; target[i]++; left--; }
  const want = S.map((s, i) => Math.max(0, target[i] - (s.sold || 0)));
  let diff = avail - want.reduce((a, x) => a + x, 0);   // 이미 판 수량이 목표보다 많았던 단계 때문에 생긴 차이를 뒤 단계부터 맞춤
  for (let i = S.length - 1; diff !== 0 && i >= 0; i--) {
    if (diff > 0) { want[i] += diff; diff = 0; }
    else { const d = Math.min(want[i], -diff); want[i] -= d; diff += d; }
  }
  S.forEach((s, i) => { out[s.n] = want[i]; });
  return out;
}

function createPaper(deps) {
  const now = deps.now || Date.now;
  const fees = deps.fees || { buy: 0, sell: 0 };   // % — 기본 0(수수료·세금 무시), 체결 행에 fee 를 따로 저장해 나중에 재계산 가능
  const orders = new Map(), positions = new Map(), lastPx = new Map();
  let fills = [];                                   // 오늘 체결(최신이 앞)
  const snapDone = new Set(), cids = new Map(), warned = new Map(), reopen = new Set();   // reopen: 전날 소멸한 익절 주문을 다시 거는 종목(내역에 '장 시작 재접수'로 표시)
  const dirty = { orders: new Map(), fills: new Map(), pos: new Map() };
  const hb = { day: '', open: false, close: false, lastTick: 0, restartPending: false };
  let loaded = false, missing = false, ticking = false, lastPurge = '', persistAlerted = false;

  /* ── 시간 ── */
  const kstOf = ms => {
    const d = new Date(ms + 9 * 3600e3);
    return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(), dow: d.getUTCDay() };
  };
  const kst = () => kstOf(now());
  const dayStartIso = () => new Date(Date.parse(kst().day + 'T00:00:00+09:00')).toISOString();
  const inSession = t => !(t.dow === 0 || t.dow === 6 || t.min < OPEN_MIN || t.min >= CLOSE_MIN);
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

  /* ── 알림(같은 내용은 10분에 한 번) · 이벤트 기록 ── */
  function notify(text, key) {
    if (key) { const t = warned.get(key); if (t && now() - t < 600000) return; warned.set(key, now()); }
    try { deps.alert && deps.alert(text, '가상매매'); } catch (_) {}
  }
  function event(kind, code, detail) {
    W('paper_events', 'POST', [{ ts: new Date(now()).toISOString(), kind, code: code || null, detail: detail || null }]).catch(() => {});
  }

  /* ── 행 변환 ── */
  const orderRow = o => ({
    id: o.id, created_at: new Date(o.createdAt).toISOString(), updated_at: new Date(o.updatedAt).toISOString(), code: o.code, name: o.name || null,
    side: o.side, type: o.type, price: o.price == null ? null : o.price, qty: o.qty, filled_qty: o.filled, avg_price: o.filled ? o.avg : null, status: o.status,
    queue_ahead: Math.round(o.queueAhead || 0), last_vol: o.lastVol == null ? null : Math.round(o.lastVol), low_seen: o.lowSeen, high_seen: o.highSeen,
    reason: o.reason || 'manual', plan: o.plan || null, note: o.note || null, ref_price: o.refPrice || null,
  });
  const fromOrder = r => ({
    id: r.id, createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at), code: r.code, name: r.name, side: r.side, type: r.type,
    price: r.price == null ? null : +r.price, qty: +r.qty, filled: +r.filled_qty || 0, avg: r.avg_price == null ? 0 : +r.avg_price, status: r.status,
    queueAhead: +r.queue_ahead || 0, lastVol: r.last_vol == null ? null : +r.last_vol, lowSeen: r.low_seen == null ? null : +r.low_seen, highSeen: r.high_seen == null ? null : +r.high_seen,
    reason: r.reason, plan: r.plan, note: r.note, refPrice: r.ref_price == null ? null : +r.ref_price,
  });
  const posRow = p => ({ code: p.code, name: p.name || null, qty: p.qty, avg_price: p.avg, opened_at: new Date(p.openedAt).toISOString(), updated_at: new Date(p.updatedAt).toISOString(), plan: p.plan || null });
  const fromPos = r => ({ code: r.code, name: r.name, qty: +r.qty, avg: +r.avg_price, openedAt: Date.parse(r.opened_at), updatedAt: Date.parse(r.updated_at), plan: r.plan, lowSeen: null });
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
      if (!persistAlerted) { persistAlerted = true; notify('가상매매 기록 저장에 실패했습니다. 다음 주기에 다시 시도합니다.'); }
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
        if (isOpen(o)) { o.lastVol = null; o.lowSeen = null; o.highSeen = null; }   // 재시작 사이의 거래량은 알 수 없으므로 첫 시세부터 다시 추적(그 사이 체결은 인정 안 함 = 보수적)
        orders.set(r.id, o);
      }
      for (const r of pos) positions.set(r.code, fromPos(r));
      fills = fl.map(fromFill);
      const day = kst().day; for (const s of sn) snapDone.add(`${day}|${s.kind}|${s.code}`);
      loaded = true; missing = false;
      const planned = [...positions.values()].filter(p => p.plan).length;
      console.log(`[paper] 복구: 미체결 ${open.length}건 · 보유 ${pos.length}종목(자동 매도 계획 ${planned}) · 오늘 체결 ${fl.length}건`);
      if (planned && inSession(kst())) hb.restartPending = true;   // 장중 재시작이면 첫 감시 때 알림
    } catch (e) {
      if (MISSING.test(String(e.message))) { missing = true; }
      else console.warn('[paper] 불러오기 실패:', e.message);
      loaded = false;
    }
    return loaded;
  }

  /* ── 직렬화(주문·취소·체결·자동 매도가 동시에 돌지 않게) ── */
  let chain = Promise.resolve();
  const lock = fn => { const p = chain.then(() => fn(), () => fn()); chain = p.catch(() => {}); return p; };

  /* ── 집계 ── */
  function isOpen(o) { return o.status === 'open' || o.status === 'partial'; }
  const openFor = (code, pred) => [...orders.values()].filter(o => isOpen(o) && o.code === code && (!pred || pred(o)));
  const remainOf = list => list.reduce((a, o) => a + (o.qty - o.filled), 0);
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
  /* 손절가: 계획에 % 가 있으면 실제 평균 매수가 기준으로 계산(호가 단위 내림), 없으면 고정 가격 */
  const stopOf = p => !p || !p.plan ? null : (p.plan.stopPct > 0 ? E.floorTick(p.avg * (1 - p.plan.stopPct / 100)) : (p.plan.stop > 0 ? p.plan.stop : null));

  /* 체결을 주문·보유·체결 목록·익절 진행에 반영 */
  function applyFills(o, list) {
    const out = [];
    for (const f of list) {
      if (!(f.q > 0) || !(f.p > 0)) continue;
      const pos = positions.get(o.code);
      const r = E.applyFill(pos ? { qty: pos.qty, avg: pos.avg } : null, o.side, f.p, f.q);
      o.avg = (o.avg * o.filled + f.p * f.q) / (o.filled + f.q); o.filled += f.q;
      const amount = f.p * f.q;
      const row = { id: `f${now().toString(36)}${rnd()}${out.length}`, ts: now(), orderId: o.id, code: o.code, side: o.side, price: f.p, qty: f.q, amount,
        fee: amount * (o.side === 'buy' ? fees.buy : fees.sell) / 100, realized: o.side === 'sell' ? r.realized : null, reason: o.reason || 'manual' };
      out.push(row); fills.unshift(row); dirty.fills.set(row.id, row);
      if (r.pos) {
        let plan = pos && pos.plan || null;
        if (o.side === 'buy' && o.plan && !(plan && plan.orderId === o.id)) {   // 새 매수 주문의 계획으로 교체(같은 주문의 부분 체결이면 진행 상황 유지)
          plan = { ...JSON.parse(JSON.stringify(o.plan)), orderId: o.id, stopped: false };
          plan.steps = (plan.steps || []).map(s => ({ ...s, sold: 0 }));
        }
        if (plan && o.side === 'sell' && isTp(o)) { const st = (plan.steps || []).find(s => 'tp' + s.n === o.reason); if (st) st.sold = (st.sold || 0) + f.q; }
        const np = { code: o.code, name: o.name || (pos && pos.name), qty: r.pos.qty, avg: r.pos.avg, openedAt: pos ? pos.openedAt : now(), updatedAt: now(), plan, lowSeen: pos ? pos.lowSeen : null };
        positions.set(o.code, np); dirty.pos.set(o.code, np);
      } else { positions.delete(o.code); dirty.pos.set(o.code, null); }
    }
    o.status = o.filled >= o.qty ? 'filled' : o.filled > 0 ? 'partial' : 'open';
    o.updatedAt = now();
    dirty.orders.set(o.id, o);
    if (fills.length > 600) fills.length = 600;
    return out;
  }

  const bad = (status, error) => ({ ok: false, status, error });
  /* 주문 1건 생성(잠금 안에서만 호출). 즉시 체결분까지 반영 */
  async function createOrder({ code, name, side, type, price, qty, reason, plan, q, ref, note }) {
    const sub = E.submit({ side, type, price, qty }, q);
    if (sub.reject) return bad(409, sub.reject);
    const t = now();
    const o = { id: `o${t.toString(36)}${rnd()}`, createdAt: t, updatedAt: t, code, name: name || null, side, type, price: type === 'limit' ? price : null, qty, filled: 0, avg: 0, status: 'open',
      queueAhead: sub.state.queueAhead, lastVol: sub.state.lastVol, lowSeen: sub.state.lowSeen, highSeen: sub.state.highSeen, reason: reason || 'manual', plan: plan || null, note: note || null,
      // 슬리피지 기준가: 손절은 손절가, 시장가는 주문 순간 상대 1호가, 지정가는 지정가
      refPrice: ref || (type === 'limit' ? price : ((side === 'buy' ? q.asks : q.bids).find(l => l.p > 0) || {}).p || q.price) };
    try { await W('paper_orders', 'POST', [orderRow(o)]); } catch (e) { console.warn('[paper] 주문 저장 실패:', e.message); return bad(503, '주문을 저장하지 못했습니다'); }
    orders.set(o.id, o);
    const f = applyFills(o, sub.fills);
    lastPx.set(code, { price: q.price, ts: t });
    return { ok: true, order: o, fills: f };
  }
  function cancelOrder(o, note) { o.status = 'cancelled'; o.note = note || o.note || null; o.updatedAt = now(); dirty.orders.set(o.id, o); }

  /* ── 사람이 내는 주문 ── */
  function cleanPlan(p) {
    if (!p || typeof p !== 'object') return null;
    const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
    const steps = Array.isArray(p.steps) ? p.steps.slice(0, 5).map(s => ({ n: Math.floor(num(s && s.n, 1, 5) || 0), p: num(s && s.p, 1, 1e8), q: Math.floor(num(s && s.q, 1, 1e7) || 0) }))
      .filter(s => s.n && s.p && s.q && E.validTick(s.p)) : [];
    const seen = new Set(), uniq = steps.filter(s => !seen.has(s.n) && seen.add(s.n));
    const stop = num(p.stop, 1, 1e8);
    return { stopPct: num(p.stopPct, 0.1, 50), stop: stop && E.validTick(stop) ? stop : (stop ? E.floorTick(stop) : null), target: num(p.target, 1, 1e8), steps: uniq };
  }
  async function place(body) {
    if (!(await init())) return bad(503, missing ? 'paper tables missing' : 'paper store unavailable');
    const code = String(body.code || ''), side = body.side, type = body.type, qty = Number(body.qty);
    if (!/^\d{6}$/.test(code)) return bad(400, 'bad code');
    if (side !== 'buy' && side !== 'sell') return bad(400, 'bad side');
    if (type !== 'limit' && type !== 'market') return bad(400, 'bad type');
    if (!Number.isInteger(qty) || qty < 1 || qty > 1e7) return bad(400, 'bad qty');
    const price = type === 'limit' ? Number(body.price) : null;
    if (type === 'limit' && !E.validTick(price)) return bad(400, '호가 단위에 맞지 않는 가격입니다');
    // 같은 주문 버튼 연타 방지: 화면이 주문마다 만드는 cid 가 같으면 처음 결과를 그대로 돌려줌(10분 보관)
    const cid = /^[A-Za-z0-9_-]{8,40}$/.test(String(body.cid || '')) ? String(body.cid) : null;
    if (cid && cids.has(cid)) { const c = cids.get(cid); return c.p ? c.p : { ...c.r, duplicate: true }; }
    const g = deps.guard(side, 'VIRTUAL');
    if (!g.ok) return bad(403, g.error);
    const run = (async () => {
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
          // 수동 매도: 걸려 있는 익절 주문을 먼저 취소(남은 수량으로 다음 감시 때 다시 배분)
          const pos = positions.get(code);
          const avail = (pos ? pos.qty : 0) - remainOf(openFor(code, o => o.side === 'sell' && !isTp(o)));
          if (qty > avail) return bad(400, `매도 가능 수량 부족 (가능 ${Math.max(0, avail)}주)`);
          for (const o of openFor(code, o => o.side === 'sell' && isTp(o))) cancelOrder(o, 'manual_sell');
        } else {
          const ref = type === 'limit' ? price : ((q.asks.find(l => l.p > 0) || {}).p || q.price);
          const lim = deps.checkLimits({ mode: 'VIRTUAL', orderKrw: ref * qty, dayKrw: dayBuyKrw(), positions: heldCodes().size, isNewPosition: !heldCodes().has(code) });
          if (!lim.ok) return bad(403, lim.error);
        }
        const r = await createOrder({ code, name, side, type, price, qty, reason: 'manual', plan: side === 'buy' ? cleanPlan(body.plan) : null, q });
        await flush();
        if (!r.ok) return r;
        if (side === 'sell' && !positions.has(code)) event('plan_end', code, { why: 'manual_sell' });
        snap(r.fills.length ? 'fill' : 'order', code, q, r.order.id);
        return { ok: true, order: pubOrder(r.order), fills: r.fills.map(pubFill) };
      });
    })();
    if (cid) { cids.set(cid, { p: run }); if (cids.size > 500) cids.delete(cids.keys().next().value); }
    const res = await run;
    if (cid) { if (res.ok) cids.set(cid, { r: res, t: now() }); else cids.delete(cid); }
    return res;
  }
  function cancel(id) {
    return lock(async () => {
      if (!(await init())) return bad(503, 'paper store unavailable');
      const o = orders.get(String(id || ''));
      if (!o) return bad(404, '주문을 찾을 수 없습니다');
      if (!isOpen(o)) return bad(409, '이미 끝난 주문입니다');
      if (isTp(o) || o.reason === 'stop') return bad(409, '자동 매도 주문은 보유 종목의 계획 수정으로 바꾸세요');
      cancelOrder(o, 'user');
      await flush();
      return { ok: true, order: pubOrder(o) };
    });
  }
  /* 보유 중 계획 수정: 손절(% 또는 가격)·목표가·익절 단계. 단계 수량 합계 = 지금 익절에 쓸 수 있는 수량이어야 함 */
  function editPlan(body) {
    return lock(async () => {
      if (!(await init())) return bad(503, 'paper store unavailable');
      const code = String(body.code || ''), pos = positions.get(code);
      if (!pos) return bad(404, '보유하지 않은 종목입니다');
      const p = cleanPlan(body);
      if (!p.stopPct && !p.stop) return bad(400, '손절가(또는 %)를 입력하세요');
      const avail = pos.qty - remainOf(openFor(code, o => o.side === 'sell' && !isTp(o)));
      const sum = p.steps.reduce((a, s) => a + s.q, 0);
      if (p.steps.length && sum !== avail) return bad(400, `익절 단계 수량 합계(${sum})가 매도 가능 수량(${avail})과 달라 저장할 수 없습니다`);
      if (p.steps.some(s => s.p <= pos.avg * 0.5)) return bad(400, '익절 가격이 너무 낮습니다');
      for (const o of openFor(code, o => o.side === 'sell' && isTp(o))) cancelOrder(o, 'plan_edit');
      pos.plan = { ...p, steps: p.steps.map(s => ({ ...s, sold: 0 })), orderId: pos.plan && pos.plan.orderId || null, stopped: false };
      pos.updatedAt = now(); dirty.pos.set(code, pos);
      await flush();
      event('plan_edit', code, { stop: stopOf(pos), steps: p.steps.length });
      return { ok: true, position: pubPos(pos) };
    });
  }

  /* ── 자동 매도(잠금 안에서, 종목별로 매 주기) ── */
  /* 반환: 손절 조건이 성립했는지(성립하면 이번 주기엔 익절 주문을 다시 걸지 않음) */
  async function stopCheck(code, q) {
    const pos = positions.get(code);
    if (!pos || !pos.plan) return false;
    const sp = stopOf(pos);
    const newLow = q.low > 0 && pos.lowSeen != null && q.low < pos.lowSeen;   // 시세 사이에 잠깐 찍고 올라온 저가도 잡음(재시작 직후 첫 시세는 기준만 잡음)
    if (q.low > 0) pos.lowSeen = pos.lowSeen == null ? q.low : Math.min(pos.lowSeen, q.low);
    if (!sp || !(q.price <= sp || (newLow && q.low <= sp))) return false;
    if (q.vi) { notify(`손절 조건이지만 VI 발동 중이라 대기합니다: ${pos.name || code}`, 'vi|' + code); return true; }
    // 1) 걸려 있는 매도 주문(익절·수동) 모두 취소  2) 남은 수량 전부 시장가 매도
    for (const o of openFor(code, o => o.side === 'sell')) cancelOrder(o, 'stop');
    const qty = pos.qty - remainOf(openFor(code, o => o.side === 'sell'));   // 취소가 안 된 매도분은 빼고(실전 어댑터에서 취소 실패 대비)
    if (qty <= 0) return true;
    const r = await createOrder({ code, name: pos.name, side: 'sell', type: 'market', price: null, qty, reason: 'stop', q, ref: sp });
    if (!r.ok) { notify(`손절 매도 실패(${r.error}) — 다음 주기에 다시 시도: ${pos.name || code}`, 'stopfail|' + code); return true; }   // 손절 조건이면 익절 주문은 다시 걸지 않음
    const s = E.summarize(r.fills.map(f => ({ p: f.price, q: f.qty })));
    const realized = r.fills.reduce((a, f) => a + (f.realized || 0), 0);
    pos.plan.stopped = true;
    event('stop', code, { stop: sp, price: q.price, qty: s.qty, avg: s.avg, realized });
    notify(`손절: ${pos.name || code} ${s.qty}주 평균 ${Math.round(s.avg).toLocaleString('ko-KR')}원 (손절가 ${sp.toLocaleString('ko-KR')}원, 손익 ${Math.round(realized).toLocaleString('ko-KR')}원)`);
    snap('fill', code, q, r.order.id);
    return true;
  }
  async function syncTp(code, q) {
    const pos = positions.get(code), tps = openFor(code, o => o.side === 'sell' && isTp(o));
    if (!pos || !pos.plan || pos.plan.stopped || !(pos.plan.steps || []).length) { for (const o of tps) cancelOrder(o, 'no_plan'); return; }
    const avail = pos.qty - remainOf(openFor(code, o => o.side === 'sell' && !isTp(o)));
    const want = allocSteps(pos.plan.steps, avail);
    for (const st of pos.plan.steps) {
      const mine = tps.filter(o => o.reason === 'tp' + st.n), w = want[st.n] || 0;
      if (mine.length === 1 && mine[0].price === st.p && mine[0].qty - mine[0].filled === w) continue;   // 그대로 유지(대기 순서 보존)
      for (const o of mine) cancelOrder(o, 'resync');
      if (w > 0) {
        const r = await createOrder({ code, name: pos.name, side: 'sell', type: 'limit', price: st.p, qty: w, reason: 'tp' + st.n, q, note: reopen.has(code) ? 'reopen' : null });
        if (!r.ok) { notify(`익절 ${st.n}단계 주문을 걸지 못했습니다(${r.error}): ${pos.name || code}`, `tpfail|${code}|${st.n}`); continue; }
        if (r.fills.length) event('tp', code, { step: st.n, qty: r.fills.reduce((a, f) => a + f.qty, 0), price: st.p, immediate: true });
      }
    }
    reopen.delete(code);
  }
  /* 장 마감(15:30)이 지난 당일 주문과 지난 날짜의 주문은 소멸 */
  function expireOld() {
    const t = kst(), cut = t.min >= CLOSE_MIN ? Infinity : Date.parse(t.day + 'T00:00:00+09:00');
    let n = 0;
    for (const o of orders.values()) if (isOpen(o) && (o.createdAt < cut)) { cancelOrder(o, 'expired'); n++; if (isTp(o)) reopen.add(o.code); }
    return n;
  }

  /* ── 조회 ── */
  const pubOrder = o => ({ id: o.id, ts: o.createdAt, code: o.code, name: o.name, side: o.side, type: o.type, price: o.price, qty: o.qty, filled: o.filled, avg: o.filled ? o.avg : null, status: o.status, queueAhead: o.queueAhead, reason: o.reason, note: o.note });
  const pubFill = f => ({ id: f.id, ts: f.ts, orderId: f.orderId, code: f.code, side: f.side, price: f.price, qty: f.qty, amount: f.amount, fee: f.fee, realized: f.realized, reason: f.reason });
  const pubPos = p => ({ code: p.code, name: p.name, qty: p.qty, avg: p.avg, plan: p.plan, stop: stopOf(p), last: (lastPx.get(p.code) || {}).price || null,
    avail: p.qty - remainOf(openFor(p.code, o => o.side === 'sell' && !isTp(o))) });
  async function state() {
    if (!(await init())) return bad(503, missing ? 'paper tables missing' : 'paper store unavailable');
    const since = Date.parse(dayStartIso());
    const list = [...orders.values()].filter(o => isOpen(o) || o.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80);
    const todayFills = fills.filter(f => f.ts >= since);
    const reason = await closedReason(null);
    return {
      ok: true, now: now(), market: { open: !reason, reason },
      engine: { lastTick: hb.lastTick || null, running: !!timer, enabled: !!deps.enabled() },
      positions: [...positions.values()].map(pubPos),
      orders: list.map(pubOrder), fills: todayFills.slice(0, 80).map(pubFill),
      dayBuyKrw: Math.round(dayBuyKrw()), realizedToday: Math.round(todayFills.reduce((a, f) => a + (f.realized || 0), 0)),
      limits: deps.limits || null,
    };
  }

  /* ── 성과 리포트(5단계): 기간 'YYYY-MM-DD'(KST, 포함) ── */
  async function report(from, to) {
    if (!(await init())) return bad(503, missing ? 'paper tables missing' : 'paper store unavailable');
    const D = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !D.test(from)) || (to && !D.test(to))) return bad(400, 'bad date');
    const iso = (d, end) => encodeURIComponent(new Date(Date.parse(d + 'T00:00:00+09:00') + (end ? 86400e3 : 0)).toISOString());
    const kFrom = from ? new Date(Date.parse(from) - 10 * 86400e3).toISOString().slice(0, 10) : null;
    try {
      const [fl, od, kp, rj] = await Promise.all([
        deps.sbGet('paper_fills?select=*&order=ts.asc&limit=20000'),
        deps.sbGet('paper_orders?select=*&order=created_at.desc&limit=5000'),
        deps.sbGet(`market_daily?select=trade_date,index_close&market=eq.KOSPI${kFrom ? '&trade_date=gte.' + kFrom : ''}${to ? '&trade_date=lte.' + to : ''}&order=trade_date.asc&limit=2000`).catch(() => []),
        deps.sbGet(`trade_audit?select=ts,detail&event=eq.paper_reject${from ? '&ts=gte.' + iso(from) : ''}${to ? '&ts=lt.' + iso(to, true) : ''}&order=ts.desc&limit=200`).catch(() => []),
      ]);
      const pos = [];
      for (const p of positions.values()) {
        let last = (lastPx.get(p.code) || {}).price || null;
        if (!last) { try { last = (await deps.getQuote(p.code)).price || null; } catch (_) {} }
        pos.push({ code: p.code, name: p.name, qty: p.qty, avg: p.avg, last });
      }
      const rejects = rj.map(r => ({ ts: Date.parse(r.ts), error: r.detail && r.detail.error, code: r.detail && r.detail.code, side: r.detail && r.detail.side, qty: r.detail && r.detail.qty, price: r.detail && r.detail.price }));
      return computeReport({ fills: fl.map(fromFill), orders: od.map(fromOrder), positions: pos, kospi: kp, rejects, from, to });
    } catch (e) { console.warn('[paper] 리포트 실패:', e.message); return bad(502, '리포트를 만들지 못했습니다'); }
  }

  /* ── 장중 루프: 체결 판단 → 손절 → 익절 주문 맞추기 → 호가 스냅 ── */
  async function tick() {
    if (ticking || !deps.enabled()) return;
    ticking = true;
    try {
      if (!(await init())) return;
      const t = kst();
      await lock(async () => { if (expireOld() || dirty.orders.size || dirty.fills.size || dirty.pos.size) await flush(); });
      if (lastPurge !== t.day) {
        lastPurge = t.day;
        const cut = new Date(now() - KEEP_DAYS * 86400e3).toISOString();
        W(`paper_book_snaps?ts=lt.${encodeURIComponent(cut)}`, 'DELETE').catch(e => console.warn('[paper] 오래된 스냅 삭제 실패:', e.message));
      }
      if (hb.day !== t.day) { hb.day = t.day; hb.open = false; hb.close = false; for (const p of positions.values()) p.lowSeen = null; }   // 저가는 날마다 새로
      if (!inSession(t)) {
        if (t.min >= CLOSE_MIN && hb.open && !hb.close) {                         // 장 마감 요약(그날 감시를 했을 때만)
          hb.close = true;
          const since = Date.parse(dayStartIso()), fl = fills.filter(f => f.ts >= since);
          notify(`가상매매 장 마감: 오늘 체결 ${fl.length}건 · 실현손익 ${Math.round(fl.reduce((a, f) => a + (f.realized || 0), 0)).toLocaleString('ko-KR')}원 · 보유 ${positions.size}종목`);
        }
        return;
      }
      if (deps.isOpenDay) { let od = null; try { od = await deps.isOpenDay(t.day); } catch (_) {} if (od === false) return; }
      hb.lastTick = now();
      const planned = [...positions.values()].filter(p => p.plan && !p.plan.stopped);
      if (!hb.open) { hb.open = true; if (planned.length) notify(`가상 자동 매도 감시 시작 — 보유 ${planned.length}종목`); }
      if (hb.restartPending) { hb.restartPending = false; notify(`relay 재시작 — 가상 보유 ${planned.length}종목 자동 매도 감시를 다시 시작했습니다`); }
      const codes = new Set([...heldCodes()]);
      for (const o of orders.values()) if (isOpen(o)) codes.add(o.code);
      for (const code of codes) {
        let q; try { q = await deps.getQuote(code); } catch (_) { notify(`시세 조회 실패로 감시가 멈춰 있습니다: ${code}`, 'quotefail|' + code); continue; }
        if (await closedReason(q)) continue;
        lastPx.set(code, { price: q.price, ts: now() });
        await lock(async () => {
          const shared = E.cloneBook(q); let any = false;
          for (const o of openFor(code).sort((a, b) => a.createdAt - b.createdAt)) {
            const before = o.queueAhead, list = E.restFill(o, q, shared);
            if (list.length) {
              const f = applyFills(o, list); any = true;
              if (isTp(o)) {
                const n = f.reduce((a, x) => a + x.qty, 0), pl = f.reduce((a, x) => a + (x.realized || 0), 0);
                event('tp', code, { step: +o.reason.slice(2), qty: n, price: o.price, realized: pl });
                notify(`익절 ${o.reason.slice(2)}단계: ${o.name || code} ${n}주 ${o.price.toLocaleString('ko-KR')}원 (손익 ${Math.round(pl).toLocaleString('ko-KR')}원)`);
              }
            } else if (o.queueAhead !== before) dirty.orders.set(o.id, o);   // 대기 큐 위치가 줄었을 때만 저장(재시작 복구용)
          }
          const stopped = await stopCheck(code, q);
          if (!stopped) await syncTp(code, q);
          await flush();
          if (any) snap('fill', code, q);
        });
        for (const [kind, at] of SLOTS) {
          const key = `${t.day}|${kind}|${code}`;
          if (t.min >= at && t.min < at + SNAP_WINDOW && !snapDone.has(key) && (positions.has(code) || openFor(code).length)) {
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

  return { place, cancel, editPlan, state, report, tick, start, stop, init, _orders: orders, _positions: positions, _dirty: dirty };
}

module.exports = { createPaper, allocSteps };
