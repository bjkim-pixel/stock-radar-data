'use strict';
/* 실거래 전환 3단계(2026-11-18) — 일일 대사(reconciliation).
   "한국투자증권이 아는 오늘" 과 "우리 기록·자동매매 장부" 가 같은지 하루 두 번(15:45 · 20:10) 맞춰 본다.
   ① 우리 주문 ↔ KIS 주문: 접수번호로 짝을 찾아 체결 수량이 같은지, KIS 에 아예 없는 주문은 없는지, 확인 중(unsure) 주문이 남지 않았는지
   ② 자동매매 몫 ↔ 실제 계좌 수량: 자동매매가 "내 몫"이라 믿는 수량이 계좌에 실제로 있는지(없으면 매도 주문이 거부·초과될 위험)
   KIS 에는 있는데 우리 기록에 없는 주문은 "직접 주문(앱·HTS)" 이라 문제가 아니다(건수만 알려 줌).
   불일치가 나오면 그 전략(알 수 없으면 실전 전략 전부)의 신규 매수를 막는다 — 손절·익절은 계속. 다음 날 대사가 깨끗하거나 /대사해제 로 풀린다. */

const ACTIVE = new Set(['open', 'partial', 'filled', 'cancelled']);
const sidOf = origin => { const m = /^auto:(.+)$/.exec(String(origin || '')); return m ? m[1] : null; };

/* 순수 함수: snapshot = live.reconSnapshot() 결과 → { ok, issues:[{kind,sid,code,text}], stats } */
function reconcile(snap) {
  const issues = [], kis = snap.kisRows || [], ours = snap.orders || [];
  const byOdno = new Map(); for (const r of kis) { byOdno.set(r.odno, r); }
  const mineOdno = new Set();
  let matched = 0;
  for (const o of ours) {
    const sid = sidOf(o.origin), nm = o.name || o.code, sd = o.side === 'buy' ? '매수' : '매도';
    if (o.status === 'unsure' || o.status === 'unknown' || o.status === 'pending') {
      issues.push({ kind: 'unsure', sid, code: o.code, text: `${nm} ${sd} ${o.qty}주 — 접수 여부를 확인하지 못한 주문이 남아 있습니다` }); continue;
    }
    if (!o.odno) continue;   // 거부돼 접수번호가 없는 주문
    mineOdno.add(o.odno);
    const r = byOdno.get(o.odno);
    if (!r) { if (ACTIVE.has(o.status)) issues.push({ kind: 'missing', sid, code: o.code, text: `${nm} ${sd} ${o.qty}주 — 우리 기록엔 접수됐는데 한국투자증권 오늘 주문에 없습니다` }); continue; }
    matched++;
    if ((r.filled || 0) !== (o.filled || 0)) issues.push({ kind: 'fill', sid, code: o.code, text: `${nm} ${sd} 체결 수량 불일치 — 우리 ${o.filled || 0}주 · 한국투자증권 ${r.filled || 0}주` });
  }
  const direct = kis.filter(r => !mineOdno.has(r.odno)).length;
  const acct = new Map((snap.positions || []).map(p => [p.code, p.qty]));
  const lastSid = new Map(); for (const o of ours.filter(x => x.side === 'buy' && sidOf(x.origin)).sort((a, b) => a.createdAt - b.createdAt)) lastSid.set(o.code, sidOf(o.origin));
  for (const pl of snap.plans || []) {
    if (!(pl.own > 0)) continue;
    const have = acct.get(pl.code) || 0;
    if (have < pl.own) issues.push({ kind: 'position', sid: lastSid.get(pl.code) || null, code: pl.code, text: `${pl.code} 자동매매 몫 ${pl.own}주인데 실제 계좌엔 ${have}주뿐입니다` });
  }
  return { ok: issues.length === 0, issues, stats: { kisOrders: kis.length, ours: ours.length, matched, direct, positions: acct.size } };
}

/* 상태 저장·스케줄·차단. deps: live(reconSnapshot) · sbGet · sbWrite · notify(text) · kstNow() {date,min} · isTradingDay(d) · authority() */
function createRecon(deps = {}) {
  const KEY = 'recon', SLOTS = [['a', 945], ['b', 1210]];
  let st = { day: null, runs: {}, last: null, blocks: {} }, loaded = false, loadAt = 0, busy = false;
  async function load(force) {
    if (!force && loaded && Date.now() - loadAt < 10000) return st;
    try { const r = await deps.sbGet(`auto_config?select=value&key=eq.${KEY}&limit=1`); if (r && r[0] && r[0].value) st = { day: null, runs: {}, last: null, blocks: {}, ...r[0].value }; loaded = true; loadAt = Date.now(); }
    catch (_) { loadAt = Date.now(); }
    return st;
  }
  const save = () => deps.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: KEY, value: st, updated_at: new Date().toISOString() }]).catch(e => console.warn('[대사] 저장 실패:', e.message));

  /* 한 번 대사. slot 은 자동 실행의 구분('a' 15:45 · 'b' 20:10), 수동이면 null */
  async function run(slot) {
    if (busy || !deps.live) return { ok: false, error: busy ? '대사 진행 중' : '실전 엔진 없음' };
    busy = true;
    try {
      await load(true);
      const snap = await deps.live.reconSnapshot();
      if (!snap || !snap.ok) { const msg = (snap && snap.error) || '조회 실패'; deps.notify(`⚠ 일일 대사를 하지 못했습니다 — ${msg}`); return { ok: false, error: msg }; }
      const res = reconcile(snap), day = snap.day, now = Date.now();
      const bad = new Set(res.issues.map(i => i.sid || '*'));
      // 새 불일치 → 차단 추가(전략을 모르면 '*' = 실전 전략 전부)
      for (const i of res.issues) { const k = i.sid || '*'; if (!st.blocks[k]) st.blocks[k] = { day, at: now, why: i.text }; }
      // 이전 날 차단은 오늘 깨끗하면 풀림(같은 날 만든 차단은 풀지 않음)
      for (const k of Object.keys(st.blocks)) if (!bad.has(k) && st.blocks[k].day < day) { delete st.blocks[k]; }
      const same = st.day === day;
      st.day = day; st.last = { day, at: now, slot: slot || 'manual', ok: res.ok, issues: res.issues.slice(0, 20), stats: res.stats };
      st.runs = slot ? { ...(same ? st.runs : {}), [slot]: now } : (same ? st.runs : {});
      await save();
      if (!res.ok) deps.notify(`🚨 일일 대사 불일치 ${res.issues.length}건 — 해당 전략의 신규 매수를 멈췄습니다(손절·익절은 계속)\n${res.issues.slice(0, 6).map(i => '· ' + i.text).join('\n')}\n한국투자증권 앱에서 확인한 뒤 /대사해제 로 풀 수 있습니다.`);
      else if (slot === 'b' && res.stats.ours > 0) deps.notify(`✅ 일일 대사 이상 없음 — 우리 주문 ${res.stats.ours}건 · 직접 주문 ${res.stats.direct}건 · 보유 ${res.stats.positions}종목`);
      return { ok: true, clean: res.ok, issues: res.issues, stats: res.stats, day };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { busy = false; }
  }
  /* 서버가 30초마다 호출: 거래일 15:45·20:10 이후 아직 안 돌았으면 실행 */
  async function tick() {
    if (!deps.live || (deps.authority && !deps.authority())) return null;
    const { date, min } = deps.kstNow();
    if (!deps.isTradingDay(date)) return null;
    await load();
    const done = st.day === date ? st.runs : {};
    for (const [slot, at] of SLOTS) if (min >= at && !done[slot]) { if (slot === 'a' && min >= 1210) continue; return run(slot); }   // 늦게 깨어났으면 15:45 몫은 건너뛰고 20:10 몫만
    return null;
  }
  /* 전략 하나의 신규 매수를 막을 이유(문자열) 또는 null */
  async function blockedFor(sid) {
    await load();
    const b = st.blocks[sid] || st.blocks['*'];
    return b ? `일일 대사 불일치로 신규 매수 정지 — ${b.why}` : null;
  }
  async function clear(sid) {
    await load(true);
    const keys = sid ? [sid] : Object.keys(st.blocks);
    const n = keys.filter(k => st.blocks[k]).length;
    for (const k of keys) delete st.blocks[k];
    await save();
    return n;
  }
  const state = async () => { await load(); return { last: st.last, blocks: Object.fromEntries(Object.entries(st.blocks).map(([k, v]) => [k, { day: v.day, why: v.why }])) }; };
  return { run, tick, blockedFor, clear, state };
}
module.exports = { reconcile, createRecon, sidOf };
