'use strict';
/* 자동매매 3단계(2026-11-15) — 장 마감 판정 · 종가 베팅 전환 · 다음 날 아침 3분할 매도 (가상매매)
   기획안 6·7장(확정):
   · 15:10 판정: 오늘 자동매매로 산 종목(아직 보유) 중 "넘길 자격"이 없는 종목을 텔레그램으로 알림 → /정리 1 3 · /정리 전체 · /유지
     넘길 자격(모두 충족): 현재가 > 매수 평균가 · 현재가 ≥ 당일 고가 × 0.98 · 최근 잠정 수급에서 외국인·기관 중 하나 이상 순매수 · 코스피·코스닥 모두 −1% 초과
     15:18 까지 답이 없으면 정리하지 않고 원래 규칙대로 20시까지 들고 간다. 정리는 승인 즉시 시장가
   · 20:00 전환: 남은 수량은 5분할 익절을 끄고(손절선은 유지) 종가 베팅 매도 계획으로 넘김 → auto_config 'carry'
   · 다음 날: 09:00~09:03 시가가 전일 종가 대비 −3% 이하면 즉시 전량 · 아니면 09:05·09:10·09:15 에 1/3·2/3·전량이 되도록 시장가 매도
     매도 도중 전일 종가 대비 −3% 도달 시 남은 수량 전량. 서버가 늦게 깨어나도 지난 시각만큼 따라잡아 판다
   · 손절(−5%)은 가상매매 엔진이 밤새·아침에도 계속 감시(프리마켓 포함) */

const RULE = Object.freeze({ highNear: 0.98, idxFloor: -1, gapCut: -3, slices: [9 * 60 + 5, 9 * 60 + 10, 9 * 60 + 15] });
const fmt = v => Math.round(v).toLocaleString('ko-KR');

/* 넘길 자격 판정(순수) — why 가 비면 자격 있음 */
function carryCheck({ price, avg, high, flow, idx }) {
  const why = [];
  if (!(price > 0)) return ['시세 없음'];
  if (!(price > avg)) why.push(`매수가 이하(${((price / avg - 1) * 100).toFixed(1)}%)`);
  if (high > 0 && price < high * RULE.highNear) why.push(`고가 대비 ${((price / high - 1) * 100).toFixed(1)}%`);
  const fq = flow && flow.err == null ? flow.fq : null, oq = flow && flow.err == null ? flow.oq : null;
  if (!((fq != null && fq > 0) || (oq != null && oq > 0))) why.push('외국인·기관 모두 순매수 아님');
  for (const [k, v] of Object.entries(idx || {})) if (v != null && v <= RULE.idxFloor) why.push(`${k} ${v.toFixed(2)}%`);
  return why;
}

/* 아침 3분할: 지금 시각까지 팔았어야 할 누적 수량(순수) */
function sliceTarget(q0, min) {
  const k = RULE.slices.filter(t => min >= t).length;
  if (k >= 3) return q0;
  return Math.floor(q0 * k / 3);
}

function parseEodCmd(text, max) {
  const t = String(text || '').trim();
  if (/^\/?유지\s*$/.test(t)) return { kind: 'keep' };
  if (/^\/?정리\s+전체\s*$/.test(t)) return { kind: 'sell', nums: Array.from({ length: max }, (_, i) => i + 1) };
  const m = t.match(/^\/?정리\s+([\d\s,]+)$/);
  if (m) { const nums = [...new Set(m[1].split(/[\s,]+/).filter(Boolean).map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= max); return nums.length ? { kind: 'sell', nums } : { kind: 'bad' }; }
  if (/^\/?정리\s*$/.test(t)) return { kind: 'bad' };
  return null;
}

/* deps: paper{state,place,editPlan} · getQuote · fetchFlow · marketIdx()→{코스피:pct,코스닥:pct} · mutateRun · readRun · mutateCarry(fn) · readCarry() · sendTelegram · now */
function createEod(deps) {
  const D = deps, now = D.now || Date.now;

  async function heldMap() {
    const S = await D.paper.state();
    if (!S || !S.ok) throw new Error('가상매매 상태를 읽지 못했습니다');
    return new Map((S.positions || []).map(p => [p.code, p]));
  }
  const boughtCodes = run => Object.entries((run && run.payload && run.payload.orders) || {}).filter(([, v]) => (v.filled || 0) > 0 || v.st === 'filled').map(([k]) => k);
  const nameOf = (run, code) => (((run && run.payload && run.payload.picks) || []).find(p => p.code === code) || {}).name || code;

  async function sellAll(code, name, why) {
    const H = await heldMap(), p = H.get(code);
    if (!p || !(p.avail > 0)) return { ok: true, qty: 0 };
    const r = await D.paper.place({ code, name, side: 'sell', type: 'market', qty: p.avail });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '매도 거부' };
    const f = r.fills || [], q = f.reduce((a, x) => a + x.qty, 0), amt = f.reduce((a, x) => a + x.amount, 0);
    return { ok: true, qty: q, avg: q ? amt / q : null, why };
  }

  /* 15:10 판정(하루 한 번) */
  async function judge(date) {
    const run = await D.readRun(date);
    if (!run || (run.payload.eod && run.payload.eod.at)) return { ok: true, skipped: true };
    const codes = boughtCodes(run);
    if (!codes.length) { await D.mutateRun(date, r => { r.payload.eod = { at: now(), items: [], none: true }; }); return { ok: true, n: 0 }; }
    const H = await heldMap();
    let idx = {}; try { idx = (await D.marketIdx()) || {}; } catch (_) {}
    const items = [];
    for (const code of codes) {
      const p = H.get(code);
      if (!p || !(p.qty > 0)) continue;                   // 이미 손절·익절로 다 팔림
      let q = null, flow = null;
      try { q = await D.getQuote(code); } catch (_) {}
      try { flow = await D.fetchFlow(code); } catch (_) {}
      const why = carryCheck({ price: q && q.price, avg: p.avg, high: q && q.high, flow, idx });
      items.push({ code, name: p.name || nameOf(run, code), qty: p.qty, avg: p.avg, price: q ? q.price : null, ok: !why.length, why });
    }
    const weak = items.filter(i => !i.ok);
    await D.mutateRun(date, r => { r.payload.eod = { at: now(), items, weak: weak.map(i => i.code), decision: weak.length ? null : { kind: 'none' } }; });
    const L = [`🕒 15:10 종가 판정 · 자동매매 보유 ${items.length}종목`];
    items.filter(i => i.ok).forEach(i => L.push(`✓ ${i.name} ${fmt(i.qty)}주 — 넘길 자격 있음(20시까지 5분할 익절 유지 후 종가 베팅)`));
    if (weak.length) {
      L.push('', '넘길 자격이 없는 종목:');
      weak.forEach((i, n) => L.push(`${n + 1}. ${i.name} ${fmt(i.qty)}주 · 현재 ${i.price ? fmt(i.price) : '–'}원 (평균 ${fmt(i.avg)}원) — ${i.why.join(', ')}`));
      L.push('', '답장: /정리 1 2 (번호) · /정리 전체 · /유지', '15:18까지 답이 없으면 정리하지 않고 20시까지 들고 가요.');
    }
    if (items.length) await D.sendTelegram(L.join('\n'));
    return { ok: true, n: items.length, weak: weak.length };
  }

  /* /정리 · /유지 */
  async function handleCmd(date, text, min) {
    const run = await D.readRun(date).catch(() => null);
    const E = run && run.payload && run.payload.eod;
    const weak = (E && E.weak) || [];
    const a = parseEodCmd(text, Math.max(weak.length, 1));
    if (!a) return null;
    if (!E || !weak.length) return '지금 정리할지 물어본 종목이 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 1~${weak.length} 중에서 골라요. 예) /정리 1`;
    if (E.decision) return `이미 처리했어요(${E.decision.kind === 'sell' ? '정리' : '유지'}).`;
    if (min >= 15 * 60 + 18) return '15:18 응답 마감이 지났어요. 원래 규칙대로 20시까지 들고 갑니다.';
    const pick = a.kind === 'sell' ? a.nums.map(n => weak[n - 1]) : [];
    await D.mutateRun(date, r => { r.payload.eod.decision = { kind: a.kind, codes: pick, at: now() }; });
    if (a.kind === 'keep') return '정리하지 않고 20시까지 들고 갈게요.';
    const L = ['🧹 종가 전 정리(시장가)'];
    for (const code of pick) {
      const it = E.items.find(i => i.code === code) || { name: code };
      const r = await sellAll(code, it.name, 'eod');
      L.push(r.ok ? (r.qty ? `· ${it.name}: ${fmt(r.qty)}주 평균 ${fmt(r.avg)}원 매도` : `· ${it.name}: 남은 수량 없음`) : `· ${it.name}: 매도 실패 — ${r.error}`);
    }
    return L.join('\n');
  }
  async function timeout(date) {
    let hit = false;
    await D.mutateRun(date, r => { const E = r.payload.eod; if (E && (E.weak || []).length && !E.decision) { E.decision = { kind: 'keep', timeout: true, at: now() }; hit = true; } });
    if (hit) await D.sendTelegram('⌛ 15:18 — 답이 없어 정리하지 않았어요. 20시까지 들고 갑니다.');
    return hit;
  }

  /* 20:00 전환: 오늘 산 종목 중 남은 수량 → 익절 끄고(손절 유지) carry 에 등록. 다음 날 아침 08:00~09:00 에 못 했으면 그때 함 */
  async function convert(date) {
    const run = await D.readRun(date);
    if (!run || run.payload.carryDone) return { ok: true, skipped: true };
    const codes = boughtCodes(run);
    const H = await heldMap();
    const add = [];
    for (const code of codes) {
      const p = H.get(code);
      if (!p || !(p.qty > 0)) continue;
      const pl = p.plan || {};
      const keep = pl.stopPct > 0 ? { stopPct: pl.stopPct } : pl.stop > 0 ? { stop: pl.stop } : { stopPct: 5 };
      const e = await D.paper.editPlan({ code, ...keep, steps: [] });   // 5분할 익절 끄기(손절선은 그대로)
      add.push({ code, name: p.name || nameOf(run, code), q0: p.qty, avg: p.avg, from: date, sold: 0, planOk: !!(e && e.ok) });
    }
    await D.mutateCarry(c => { c.items = c.items || {}; for (const a of add) c.items[a.code] = { ...a, at: now(), state: 'wait' }; });
    await D.mutateRun(date, r => { r.payload.carryDone = { at: now(), codes: add.map(a => a.code) }; });
    const L = [`🌙 ${date} 종가 베팅 전환`];
    if (!add.length) L.push('넘길 종목이 없어요(모두 정리됨).');
    else {
      add.forEach(a => L.push(`· ${a.name} ${fmt(a.q0)}주 (평균 ${fmt(a.avg)}원)${a.planOk ? '' : ' ⚠ 익절 해제 실패 — 매매 화면에서 확인'}`));
      L.push('', '다음 거래일 09:05·09:10·09:15 에 1/3씩 시장가 매도. 시가가 전일 종가 대비 −3% 이하이면 즉시 전량. 손절(−5%)은 밤새 유지.');
    }
    await D.sendTelegram(L.join('\n'));
    return { ok: true, n: add.length };
  }

  /* 다음 날 아침 매도(09:00~09:40 주기) */
  async function morning(date, min) {
    const C = await D.readCarry();
    const items = Object.values((C && C.items) || {}).filter(i => i.from < date && i.state !== 'done');
    if (!items.length) return { ok: true, n: 0 };
    const H = await heldMap();
    const msgs = [];
    for (const it of items) {
      const p = H.get(it.code);
      if (!p || !(p.qty > 0)) {   // 손절 등으로 이미 다 팔림
        await D.mutateCarry(c => { c.items[it.code].state = 'done'; c.items[it.code].doneAt = now(); c.items[it.code].why = 'gone'; });
        continue;
      }
      let q = null; try { q = await D.getQuote(it.code); } catch (_) { continue; }
      if (!(q && q.price > 0)) continue;
      const pc = q.prevClose > 0 ? q.prevClose : null, chg = pc ? (q.price / pc - 1) * 100 : 0;
      const cut = pc && chg <= RULE.gapCut;
      let want;
      if (cut) want = p.qty;                                                   // 갭 하락·도중 −3% → 남은 전량
      else { const tgt = sliceTarget(it.q0, min); want = Math.min(p.avail, Math.max(0, tgt - (it.q0 - p.qty))); }   // 판 수량 = 처음 수량 − 지금 보유(손절 등 포함)
      if (min >= RULE.slices[2]) want = p.avail;
      if (!(want > 0)) continue;
      const r = await D.paper.place({ code: it.code, name: it.name, side: 'sell', type: 'market', qty: Math.min(want, p.avail) });
      if (!r || !r.ok) { msgs.push(`⚠ ${it.name}: 종가 베팅 매도 실패 — ${(r && r.error) || '거부'} (다음 주기에 다시 시도)`); continue; }
      const f = r.fills || [], sq = f.reduce((a, x) => a + x.qty, 0), amt = f.reduce((a, x) => a + x.amount, 0);
      const left = p.qty - sq;
      await D.mutateCarry(c => { const x = c.items[it.code]; x.sold = (x.sold || 0) + sq; x.log = [...(x.log || []), { at: now(), qty: sq, avg: sq ? amt / sq : null, cut: !!cut }]; if (left <= 0) { x.state = 'done'; x.doneAt = now(); } else x.state = 'selling'; });
      if (sq) msgs.push(`${cut ? '⚡' : '🔔'} ${it.name}: ${fmt(sq)}주 평균 ${fmt(amt / sq)}원 매도${cut ? ` (전일 종가 대비 ${chg.toFixed(1)}% — 전량)` : ''} · 남은 ${fmt(Math.max(0, left))}주 · 매수 평균 대비 ${(((amt / sq) / it.avg - 1) * 100).toFixed(1)}%`);
    }
    if (msgs.length) await D.sendTelegram(msgs.join('\n'));
    return { ok: true, n: items.length, msgs };
  }

  return { judge, handleCmd, timeout, convert, morning };
}

module.exports = { RULE, carryCheck, sliceTarget, parseEodCmd, createEod };
