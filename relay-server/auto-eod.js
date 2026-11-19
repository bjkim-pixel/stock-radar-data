'use strict';
const LOG = require('./auto-log');
/* 자동매매 3단계(2026-11-15) — 장 마감 판정 · 종가 베팅 전환 · 다음 날 아침 3분할 매도 (가상매매)
   기획안 6·7장(확정) + 2026-11-16 개편(정규장/NXT 분리):
   · 14:45 판정(reg): 정규장에서만 거래되는 보유 종목 중 "넘길 자격"이 없는 종목을 텔레그램·사이트로 알림 → /정리 1 3 · /정리 전체 · /유지. 답 마감 15:20
   · 18:30 판정(nxt): NXT 거래 가능 보유 종목을 NXT 애프터마켓 시세로 같은 방식 판정. 답 마감 19:00(무응답이면 유지), 정리는 지정가(매수 호가)
     넘길 자격(모두 충족): 현재가 > 매수 평균가 · 현재가 ≥ 당일 고가 × 0.98 · 최근 잠정 수급에서 외국인·기관 중 하나 이상 순매수 · 코스피·코스닥 모두 −1% 초과
     정리는 반드시 사용자 승인(텔레그램·사이트) 후에만 — 자동 매도 없음. 답이 없으면 정리하지 않고 20시까지 들고 간다
   · 20:00 전환: 남은 수량은 5분할 익절을 끄고(손절선은 유지) 종가 베팅 매도 계획으로 넘김 → auto_config 'carry'
   · 다음 날: 09:00~09:03 시가가 전일 종가 대비 −3% 이하면 즉시 전량 · 아니면 09:05·09:10·09:15 에 1/3·2/3·전량이 되도록 시장가 매도
     매도 도중 전일 종가 대비 −3% 도달 시 남은 수량 전량. 서버가 늦게 깨어나도 지난 시각만큼 따라잡아 판다
   · 손절(−5%)은 가상매매 엔진이 밤새·아침에도 계속 감시(프리마켓 포함) */

const { hhmm } = require('./auto-strategy');
/* 기본값 = 1~3단계 확정값. 실제 값은 전략 설정(deps.rule())에서 옴 */
const RULE = Object.freeze({ highNear: 0.98, idxFloor: -1, gapCut: -3, slices: [9 * 60 + 5, 9 * 60 + 10, 9 * 60 + 15], needAboveAvg: true, carryFlow: 'any',
  overnightStopPct: 5, replyEnd: 15 * 60, nxtJudgeAt: 18 * 60 + 30, nxtReplyEnd: 19 * 60, convertAt: 20 * 60, eodWeak: 'ask', closingOn: true, holdOn: true, holdMode: 'price', holdGraceMin: 0 });
const fmt = v => Math.round(v).toLocaleString('ko-KR');

/* 넘길 자격 판정(순수) — why 가 비면 자격 있음 */
/* 넘길 자격 판정 사유(2026-11-17 개편): 종목 자체 사유(가격·수급)를 숫자와 함께 먼저, 시장 사유는 '시장 약세'로 따로 묶어 표시 */
const f0 = n => Math.round(Math.abs(n)).toLocaleString('ko-KR');
const sq = n => n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${f0(n)}주`;
function carryParts({ price, avg, high, flow, idx }, R = RULE) {
  const stock = [], market = [], facts = [];
  if (!(price > 0)) return { stock: ['시세 없음'], market, facts };
  const pa = avg > 0 ? (price / avg - 1) * 100 : null;
  if (pa != null) facts.push(`매수가 대비 ${pa >= 0 ? '+' : ''}${pa.toFixed(1)}% (평균 ${f0(avg)}원 → 현재 ${f0(price)}원)`);
  if (R.needAboveAvg && !(price > avg)) stock.push(`매수가 이하(${pa.toFixed(1)}%) — ${pa < 0 ? `평균 매수가 ${f0(avg)}원보다 ${f0(avg - price)}원 낮음` : '수익 없이 본전'}`);
  if (high > 0 && price < high * R.highNear) stock.push(`고가 대비 ${((price / high - 1) * 100).toFixed(1)}% — 장중 고가 ${f0(high)}원에서 밀려 상승분 반납`);
  const ok = flow && flow.err == null, fq = ok ? flow.fq : null, oq = ok ? flow.oq : null;
  const fp = fq != null && fq > 0, op = oq != null && oq > 0;
  const fx = `외국인 ${sq(fq)} · 기관 ${sq(oq)}`;
  if (ok && (fq != null || oq != null)) facts.push(`오늘 잠정 순매수 ${fx}`);
  if (R.carryFlow === 'any' && !(fp || op)) stock.push(!ok || (fq == null && oq == null) ? '외국인·기관 수급 확인 안 됨(잠정치 없음)' : `외국인·기관 모두 순매수 아님(${fx}) — 수급 주체 이탈`);
  if (R.carryFlow === 'both' && !(fp && op)) stock.push(`${fp ? '기관' : op ? '외국인' : '외국인·기관'} 순매수 아님(${fx})`);
  const low = Object.entries(idx || {}).filter(([, v]) => v != null && v <= R.idxFloor);
  if (low.length) market.push(`시장 약세 ${low.map(([k, v]) => `${k} ${v.toFixed(2)}%`).join('·')} (기준 ${R.idxFloor}% 이하 — 종목과 무관하게 밤사이 갭 하락 위험)`);
  return { stock, market, facts };
}
function carryCheck(x, R = RULE) { const p = carryParts(x, R); return [...p.stock, ...p.market]; }

/* 아침 3분할: 지금 시각까지 팔았어야 할 누적 수량(순수) */
function sliceTarget(q0, min, slices = RULE.slices) {
  const n = slices.length, k = slices.filter(t => min >= t).length;
  if (k >= n) return q0;
  return Math.floor(q0 * k / n);
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

/* NXT 애프터마켓은 시장가 주문이 안 돼서, 수량이 다 걸리는 매수 호가까지 내려 낸 지정가로 판다(바로 체결되는 지정가). 호가가 없으면 null */
function limitSellPrice(q, qty) {
  const bids = ((q && q.bids) || []).filter(l => l && l.p > 0 && l.q > 0);
  if (!bids.length) return null;
  let acc = 0, p = bids[0].p;
  for (const l of bids) { acc += l.q; p = l.p; if (acc >= qty) break; }
  return p;
}

/* deps: paper{state,place,editPlan} · getQuote · fetchFlow · marketIdx()→{코스피:pct,코스닥:pct} · mutateRun · readRun · mutateCarry(fn) · readCarry() · sendTelegram · now */
function createEod(deps) {
  const D = deps, now = D.now || Date.now;
  const rule = async () => ({ ...RULE, ...(D.rule ? await D.rule().catch(() => ({})) : {}) });
  /* 매매 엔진(실거래 전환 1단계): 이 전략의 broker. 이월 종목은 넘겨준 전략(it.sid)의 엔진으로(brokerFor) — 가상·실전이 섞여도 각자 엔진에서 판다 */
  const B = D.broker || D.paper;
  const Bof = it => (D.brokerFor ? (D.brokerFor(it && it.sid) || B) : B);
  /* 실전매매 자동매매(2026-11-19): 가상·드라이런·실전 장부가 같은 종목을 각자 넘길 수 있어 이월 키에 장부를 붙임(가상은 예전처럼 종목코드) */
  const ckey = (code, kind) => (!kind || kind === 'paper' ? code : `${code}@${kind}`);
  const keyOfItem = it => it.key || ckey(it.code, it.kind);

  async function heldMap(b = B) {
    const S = await b.state();
    if (!S || !S.ok) throw new Error(`${(b && b.label) || '가상'}매매 상태를 읽지 못했습니다`);
    return new Map((S.positions || []).map(p => [p.code, p]));
  }
  /* 여러 종목을 돌 때 엔진별로 한 번만 읽음 */
  const heldCache = () => { const m = new Map(); return async b => { const k = (b && b.kind) || 'paper'; if (!m.has(k)) m.set(k, await heldMap(b)); return m.get(k); }; };
  const boughtCodes = run => Object.entries((run && run.payload && run.payload.orders) || {}).filter(([, v]) => (v.filled || 0) > 0 || v.st === 'filled').map(([k]) => k);
  const nameOf = (run, code) => (((run && run.payload && run.payload.picks) || []).find(p => p.code === code) || {}).name || code;

  async function sellAll(code, name, why, phase, date) {
    const H = await heldMap(), p = H.get(code);
    if (!p || !(p.avail > 0)) return { ok: true, qty: 0 };
    const o = { code, name, side: 'sell', type: 'market', qty: p.avail, cid: `eod${phase === 'nxt' ? 'n' : 'r'}_${code}_${String(date || '').replace(/-/g, '')}` };
    if (phase === 'nxt') {
      let q = null; try { q = await D.getQuote(code); } catch (_) {}
      const px = limitSellPrice(q, p.avail);
      if (!px) return { ok: false, error: 'NXT 매수 호가를 읽지 못했어요' };
      o.type = 'limit'; o.price = px;
    }
    const r = await B.place(o);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '매도 거부' };
    const f = r.fills || [], q = f.reduce((a, x) => a + x.qty, 0), amt = f.reduce((a, x) => a + x.amount, 0);
    return { ok: true, qty: q, avg: q ? amt / q : null, left: Math.max(0, p.avail - q), why };
  }
  const keyOf = ph => (ph === 'nxt' ? 'eodN' : 'eod');
  const kstHHMM = () => hhmm(Math.floor((now() + 9 * 3600e3) / 60e3) % 1440);

  /* 판정(하루 한 번씩): phase 'reg' = 14:45 정규장 종목 · 'nxt' = 18:30 NXT 거래 종목 (알림 → 답 마감 15:00·19:00, 무응답이면 유지) */
  async function judge(date, phase = 'reg') {
    const key = keyOf(phase), nx = phase === 'nxt';
    const run = await D.readRun(date);
    if (!run || (run.payload[key] && run.payload[key].at)) return { ok: true, skipped: true };
    const codes = [...new Set([...boughtCodes(run), ...(D.intraCodes ? D.intraCodes(date) : [])])], tag = nx ? 'NXT 종가 판정' : '종가 판정';
    /* 종가베팅 전략이 꺼져 있으면 장중 종목은 이월·종가 전 정리 판단 없이 매도 계획(손절·익절)만으로 거래 — 묻지도 팔지도 않음 */
    if ((await rule()).closingOn === false) { await D.mutateRun(date, r => { r.payload[key] = { at: now(), items: [], none: true, off: true }; LOG.push(r.payload, 'judge', `${tag}: 종가베팅 전략이 꺼져 있어 이월·정리 판단 없이 매도 계획대로 거래(건너뜀)`, null, now()); }); return { ok: true, n: 0, off: true }; }
    if (!codes.length) { await D.mutateRun(date, r => { r.payload[key] = { at: now(), items: [], none: true }; LOG.push(r.payload, 'judge', `${tag}: 오늘 산 종목이 없어 건너뜀`, null, now()); }); return { ok: true, n: 0 }; }
    const H = await heldMap();
    let idx = {}; try { idx = (await D.marketIdx()) || {}; } catch (_) {}
    const R = await rule();
    const items = [], other = [];
    for (const code of codes) {
      const p = H.get(code);
      if (!p || !(p.qty > 0)) continue;                   // 이미 손절·익절로 다 팔림
      let q = null, flow = null;
      try { q = await D.getQuote(code); } catch (_) {}
      if (!!(q && q.info && q.info.nxt) !== nx) { other.push({ code, name: p.name || nameOf(run, code) }); continue; }   // 다른 시간대에 판정할 종목
      try { flow = await D.fetchFlow(code); } catch (_) {}
      const pt = R.closingOn ? carryParts({ price: q && q.price, avg: p.avg, high: q && q.high, flow, idx }, R) : { stock: ['종가베팅 전략 꺼짐'], market: [], facts: [] };
      const why = [...pt.stock, ...pt.market];
      items.push({ code, name: p.name || nameOf(run, code), qty: p.qty, avg: p.avg, price: q ? q.price : null, nxt: nx, nxtKnown: !!(q && q.info && q.info.nxt != null), ok: !why.length, why, whyS: pt.stock, whyM: pt.market, facts: pt.facts, mktOnly: !pt.stock.length && pt.market.length > 0 });
    }
    const weak = items.filter(i => !i.ok);
    // 약한 종목: 정리는 항상 사용자 승인 후에만(자동 매도 없음). 설정이 '유지'면 묻지 않고 유지
    const pre = !weak.length ? { kind: 'none' } : R.eodWeak === 'keep' ? { kind: 'keep', auto: true, at: now() } : null;
    const end = nx ? R.nxtReplyEnd : R.replyEnd;
    await D.mutateRun(date, r => { r.payload[key] = { at: now(), items, weak: weak.map(i => i.code), decision: pre, ...(other.length ? { other: other.map(o => o.code) } : {}), ...(!items.length ? { none: true } : {}) };
      LOG.push(r.payload, 'judge', `${tag}: ${nx ? 'NXT 거래 ' : '정규장 '}보유 ${items.length}종목 · 넘길 자격 ${items.length - weak.length} · 약함 ${weak.length}${weak.length ? ' (' + weak.map(i => `${i.name}: ${i.why.join(', ')}`).join(' / ') + ')' : ''}${pre && pre.kind === 'keep' && weak.length ? ' → 설정대로 유지' : ''}${other.length ? ` · ${nx ? '정규장' : 'NXT'} 종목 ${other.length}개는 ${nx ? '앞서' : hhmm(R.nxtJudgeAt || 19 * 60) + '에'} 판정` : ''}`, null, now()); });
    const conv = hhmm(R.convertAt);
    const L = [nx ? `🌙 ${kstHHMM()} NXT 종가 판정 · NXT 거래 보유 ${items.length}종목 (애프터마켓 시세 기준)` : `🕒 ${kstHHMM()} 종가 판정 · 정규장 보유 ${items.length}종목`];
    items.filter(i => i.ok).forEach(i => L.push(`✓ ${i.name} ${fmt(i.qty)}주 — 넘길 자격 있음(${conv}까지 분할 익절 유지 후 종가 베팅)`));
    if (weak.length) {
      L.push('', '넘길 자격이 없는 종목:');
      weak.forEach((i, n) => { L.push(`${n + 1}. ${i.name} ${fmt(i.qty)}주 · 현재 ${i.price ? fmt(i.price) : '–'}원 (평균 ${fmt(i.avg)}원)`); (i.whyS || []).forEach(w => L.push(`   - ${w}`)); (i.whyM || []).forEach(w => L.push(`   - ${w}`)); if (i.mktOnly) L.push(`   ※ 종목 자체(가격·수급)는 기준 충족 — 시장 하락만 해당${(i.facts || []).length ? ': ' + i.facts.join(' / ') : ''}`); });
      if (!pre) L.push('', '정리는 답장하신 종목만 진행해요(자동으로 팔지 않아요).', `답장: /정리 1 2 (번호) · /정리 전체 · /유지   (사이트에서도 가능)`, `${hhmm(end)}까지 답이 없으면 '유지'로 자동 결정해요(정리 안 함, ${conv}까지 들고 감).${nx ? ' 정리는 NXT 지정가(매수 호가)로 내요.' : ''}`);
      else L.push('', `설정에 따라 묻지 않고 ${conv}까지 들고 가요.`);
    }
    if (other.length && !nx) L.push('', `ℹ NXT 거래 가능 ${other.length}종목(${other.map(o => o.name).join(', ')})은 ${hhmm(R.nxtJudgeAt || 19 * 60)}에 따로 판정해요.`);
    if (items.length || (other.length && !nx)) await D.sendTelegram(L.join('\n'));
    return { ok: true, n: items.length, weak: weak.length, other: other.length };
  }

  async function sellCodes(codes, items, why, phase, date) {
    const out = [];
    for (const code of codes) {
      const it = items.find(i => i.code === code) || { name: code };
      const r = await sellAll(code, it.name, why, phase, date);
      out.push(r.ok ? (r.qty ? `· ${it.name}: ${fmt(r.qty)}주 평균 ${fmt(r.avg)}원 매도${r.left ? ` · ${fmt(r.left)}주는 아직 체결 전(주문 유지)` : ''}` : r.left ? `· ${it.name}: 주문은 냈지만 아직 체결 전이에요(20:00까지 유지)` : `· ${it.name}: 남은 수량 없음`) : `· ${it.name}: 매도 실패 — ${r.error}`);
    }
    return out;
  }

  /* 지금 답을 기다리는 판정 시간대('nxt' | 'reg' | null) */
  /* 2026-11-16: 정규장(reg)이 먼저 — 그리고 NXT 는 NXT 판정 시각(nxtFrom, 분)이 된 뒤에만 답을 받는다. 시각 전에 온 /유지·/정리 가 아직 안 온 NXT 종목을 처리하던 문제 방지 */
  const pendingPhase = (P, min, nxtFrom) => {
    const waitR = P && P.eod && (P.eod.weak || []).length && !P.eod.decision, waitN = P && P.eodN && (P.eodN.weak || []).length && !P.eodN.decision;
    if (waitR) return 'reg';
    if (waitN && (min == null || nxtFrom == null || min >= nxtFrom)) return 'nxt';
    return null;
  };

  /* /정리 · /유지 (opts.phase 없으면 답을 기다리는 시간대, 없으면 약한 종목이 있는 시간대) */
  async function handleCmd(date, text, min, opts = {}) {
    const run = await D.readRun(date).catch(() => null);
    const P = (run && run.payload) || {}, R = await rule();
    const phase = opts.phase || pendingPhase(P, min, R.nxtJudgeAt) || ((P.eodN && (P.eodN.weak || []).length && min >= R.nxtJudgeAt) ? 'nxt' : 'reg'), nx = phase === 'nxt', key = keyOf(phase);
    const E = P[key];
    const weak = (E && E.weak) || [];
    const a = parseEodCmd(text, Math.max(weak.length, 1));
    if (!a) return null;
    if (!E || !weak.length) return '지금 정리할지 물어본 종목이 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 1~${weak.length} 중에서 골라요. 예) /정리 1`;
    if (E.decision) return `이미 처리했어요(${E.decision.kind === 'sell' ? '정리' : '유지'}).`;
    const end = nx ? R.nxtReplyEnd : R.replyEnd, hardEnd = nx ? 19 * 60 + 55 : 930;
    if (opts.late ? min >= hardEnd : min >= end) return opts.late ? `${nx ? '거래 시간(20:00)이 거의 끝나' : '장 마감(15:30)이 지나'} 정리할 수 없어요.` : `${hhmm(end)} 응답 마감이 지났어요. 설정에 따라 처리합니다.`;
    const pick = a.kind === 'sell' ? a.nums.map(n => weak[n - 1]) : [];
    await D.mutateRun(date, r => { r.payload[key].decision = { kind: a.kind, codes: pick, at: now() }; LOG.push(r.payload, 'eod', a.kind === 'keep' ? `${nx ? 'NXT ' : ''}약한 종목 유지 결정` : `${nx ? 'NXT ' : ''}약한 종목 정리 결정(승인): ${pick.map(c => ((E.items || []).find(i => i.code === c) || {}).name || c).join(', ')}`, null, now()); });
    if (a.kind === 'keep') return `정리하지 않고 ${hhmm(R.convertAt)}까지 들고 갈게요.`;
    return [nx ? '🧹 NXT 종가 전 정리(지정가·매수 호가)' : '🧹 종가 전 정리(시장가)', ...(await sellCodes(pick, E.items, 'eod', phase, date))].join('\n');
  }
  /* 답 마감: 무응답이면 정리하지 않고 유지(자동 매도 없음) */
  async function timeout(date, phase = 'reg') {
    const R = await rule(), key = keyOf(phase), end = phase === 'nxt' ? R.nxtReplyEnd : R.replyEnd;
    let hit = false;
    await D.mutateRun(date, r => { const E = r.payload[key]; if (E && (E.weak || []).length && !E.decision) { E.decision = { kind: 'keep', timeout: true, at: now() }; hit = true; LOG.push(r.payload, 'eod', `${phase === 'nxt' ? 'NXT ' : ''}정리 질문에 답이 없어 유지`, null, now()); } });
    if (hit) await D.sendTelegram(`⌛ ${hhmm(end)} — 답이 없어 '유지'로 자동 결정했어요(정리 안 함). ${hhmm(R.convertAt)}까지 들고 갑니다.`);
    return hit;
  }

  /* 20:00 전환: 오늘 산 종목 중 남은 수량 → 익절 끄고(손절 유지) carry 에 등록. 다음 날 아침 08:00~09:00 에 못 했으면 그때 함 */
  async function convert(date) {
    const run = await D.readRun(date);
    if (!run || run.payload.carryDone) return { ok: true, skipped: true };
    const codes = boughtCodes(run);
    const R = await rule();
    if (!R.closingOn) {   // 종가베팅 전략이 꺼져 있으면 이월하지 않음
      await D.mutateRun(date, r => { r.payload.carryDone = { at: now(), codes: [], off: true }; LOG.push(r.payload, 'convert', '이월 전환: 종가베팅 전략이 꺼져 있어 넘기지 않음', null, now()); });
      const H0 = await heldMap(), left = codes.filter(c => (H0.get(c) || {}).qty > 0);
      if (left.length) await D.sendTelegram(`🌙 ${date} 종가베팅 전략이 꺼져 있어 이월하지 않았어요. 남은 자동매매 보유 ${left.length}종목은 매매 화면에서 확인하세요.`);
      return { ok: true, n: 0, off: true };
    }
    const H = await heldMap();
    const add = [];
    for (const code of codes) {
      const p = H.get(code);
      if (!p || !(p.qty > 0)) continue;
      const pl = p.plan || null, plan0 = pl ? { stopPct: pl.stopPct || null, steps: (pl.steps || []).map(x => ({ n: x.n, p: x.p, q: x.q, ...(x.runner ? { runner: true } : {}) })), ratchet: pl.ratchet || null } : null;   // 아침에 보류·장중 전환할 때 되돌릴 원래 매도 계획
      const e = await B.editPlan({ code, stopPct: R.overnightStopPct, steps: [], ratchet: null });   // 분할 익절 끄기, 손절은 종가베팅 설정값(기본 −5%)
      const kind = (B && B.kind) || 'paper';
      add.push({ code, name: p.name || nameOf(run, code), q0: p.qty, avg: p.avg, from: date, sold: 0, planOk: !!(e && e.ok), sid: D.tag || null, kind, key: ckey(code, kind), ...(plan0 ? { plan0 } : {}) });   // sid = 넘겨준 장중 전략 · kind = 그 전략의 장부
    }
    await D.mutateCarry(c => { c.items = c.items || {}; for (const a of add) c.items[a.key] = { ...a, at: now(), state: 'wait' }; });
    await D.mutateRun(date, r => { r.payload.carryDone = { at: now(), codes: add.map(a => a.code) }; LOG.push(r.payload, 'convert', add.length ? `이월 전환: ${add.map(a => `${a.name} ${a.q0}주`).join(', ')} — 분할 익절 끄고 손절 −${R.overnightStopPct}% 유지, 다음 날 ${R.slices.map(hhmm).join('·')} 분할 매도` : '이월 전환: 넘길 종목 없음(모두 정리됨)', null, now()); });
    const L = [`🌙 ${date} 종가 베팅 전환`];
    if (!add.length) L.push('넘길 종목이 없어요(모두 정리됨).');
    else {
      add.forEach(a => L.push(`· ${a.name} ${fmt(a.q0)}주 (평균 ${fmt(a.avg)}원)${a.planOk ? '' : ' ⚠ 익절 해제 실패 — 매매 화면에서 확인'}`));
      L.push('', `다음 거래일 ${R.slices.map(hhmm).join('·')} 에 ${R.slices.length}분할 시장가 매도. 시가가 전일 종가 대비 ${R.gapCut}% 이하이면 즉시 전량. 손절(−${R.overnightStopPct}%)은 밤새 유지.`);
    }
    await D.sendTelegram(L.join('\n'));
    return { ok: true, n: add.length };
  }

  /* 아침 보류: 종가베팅 매도 대신 원래(장중) 매도 계획을 다시 걸고 carry 상태를 'intra' 로 바꿈 → 오늘 장중 정리 판정·20:00 재이월 대상 */
  async function hold(it, p, q, date) {
    let plan = null;
    try { plan = D.restorePlan ? await D.restorePlan(it, p) : null; } catch (_) {}
    if (!plan || !(plan.stopPct > 0)) return null;
    const e = await Bof(it).editPlan({ code: it.code, stopPct: plan.stopPct, steps: plan.steps || [], ratchet: plan.ratchet || null });
    if (!e || !e.ok) return null;
    await D.mutateCarry(c => { const x = c.items[keyOfItem(it)]; x.state = 'intra'; x.holdDate = date; x.holdAt = now(); x.holdOpen = q.open; x.holdPrice = q.price; x.holdQty = p.qty; x.holdSrc = plan.src || null; x.log = [...(x.log || []), { at: now(), hold: true, open: q.open, price: q.price }]; });
    const tp = (plan.steps || []).length ? `익절 ${plan.steps.length}단계` : '익절 없음';
    return `⏸ ${it.name}: 시가 ${fmt(q.open)}원 · 현재 ${fmt(q.price)}원 — 매수 평균 ${fmt(p.avg)}원보다 낮아 아침 매도를 보류하고 장중 전략으로 전환 (손절 −${plan.stopPct}% · ${tp}${plan.src ? ' · ' + plan.src : ''})`;
  }

  /* 20:00: 장중으로 전환했던 종목을 다시 종가베팅 이월로 되돌림(기존 규칙대로 재이월) */
  async function reconvert(date) {
    const C = await D.readCarry();
    const items = Object.values((C && C.items) || {}).filter(i => i.state === 'intra' && i.holdDate === date);
    if (!items.length) return { ok: true, n: 0 };
    const hOf = heldCache(), R = await rule(), add = [], gone = [];
    for (const it of items) {
      const b = Bof(it), H = await hOf(b), p = H.get(it.code);
      if (!p || !(p.qty > 0) || !R.closingOn) { gone.push([keyOfItem(it), !p || !(p.qty > 0) ? 'gone' : 'closing-off']); continue; }
      const e = await b.editPlan({ code: it.code, stopPct: R.overnightStopPct, steps: [], ratchet: null });
      add.push({ key: keyOfItem(it), code: it.code, q0: p.qty, avg: p.avg, ok: !!(e && e.ok), name: it.name });
    }
    await D.mutateCarry(c => {
      for (const [k, why] of gone) { const x = c.items[k]; if (x) { x.state = 'done'; x.doneAt = now(); x.why = why; } }
      for (const a of add) { const x = c.items[a.key]; if (x) { x.state = 'wait'; x.from = date; x.q0 = a.q0; x.avg = a.avg; x.sold = 0; x.reconv = (x.reconv || 0) + 1; x.at = now(); } }
    });
    if (add.length) await D.sendTelegram(`🌙 ${date} 장중 전환 종목 재이월: ${add.map(a => `${a.name} ${fmt(a.q0)}주`).join(', ')} — 다시 종가베팅 매도 계획(손절 −${R.overnightStopPct}% 유지)으로 넘겼어요.`);
    return { ok: true, n: add.length };
  }

  /* 다음 날 아침 매도(09:00~09:40 주기) */
  async function morning(date, min) {
    const C = await D.readCarry();
    const items = Object.values((C && C.items) || {}).filter(i => i.from < date && i.state !== 'done' && !(i.state === 'intra' && i.holdDate === date));   // 오늘 장중 전환한 종목은 아침 매도 대상 아님
    if (!items.length) return { ok: true, n: 0 };
    const hOf = heldCache(), R = await rule(), last = R.slices[R.slices.length - 1];
    const msgs = [];
    for (const it of items) {
      const b = Bof(it), H = await hOf(b), p = H.get(it.code);
      /* 실전은 주문 응답에 체결이 오지 않아(체결조회로 나중에 옴) it.sold 가 늘지 않는다 → 처음 수량과 지금 보유의 차이로 판 수량을 본다. 가상은 지금과 같게 */
      const soldSoFar = b && b.real ? Math.max(it.sold || 0, (it.q0 || 0) - (p ? p.qty : 0)) : (it.sold || 0);
      if (!p || !(p.qty > 0)) {   // 손절 등으로 이미 다 팔림
        await D.mutateCarry(c => { const x = c.items[keyOfItem(it)]; if (x) { x.state = 'done'; x.doneAt = now(); x.why = 'gone'; } });
        continue;
      }
      let q = null; try { q = await D.getQuote(it.code); } catch (_) { continue; }
      if (!(q && q.price > 0)) continue;
      if (R.holdOn !== false && it.state !== 'intra' && !(soldSoFar > 0) && q.open > 0 && p.avg > 0) {   // 매수가보다 낮게 시작 → 급히 팔지 않고 장중 전략 계획으로 전환
        const below = R.holdMode === 'price' ? q.price < p.avg : (q.open < p.avg && q.price < p.avg);
        if (below) { const h = await hold(it, p, q, date); if (h) { msgs.push(h); continue; } }
      }
      const pc = q.prevClose > 0 ? q.prevClose : null, chg = pc ? (q.price / pc - 1) * 100 : 0;
      const cut = pc && chg <= R.gapCut;
      let want;
      if (cut) want = p.qty;                                                   // 갭 하락·도중 −3% → 남은 전량
      else { const tgt = sliceTarget(it.q0, min, R.slices); want = Math.min(p.avail, Math.max(0, tgt - (it.q0 - p.qty))); }   // 판 수량 = 처음 수량 − 지금 보유(손절 등 포함)
      if (min >= last) want = p.avail;
      if (!(want > 0)) continue;
      const r = await b.place({ code: it.code, name: it.name, side: 'sell', type: 'market', qty: Math.min(want, p.avail) });
      if (!r || !r.ok) { msgs.push(`⚠ ${it.name}: 종가 베팅 매도 실패 — ${(r && r.error) || '거부'} (다음 주기에 다시 시도)`); continue; }
      const f = r.fills || [], sq = f.reduce((a, x) => a + x.qty, 0), amt = f.reduce((a, x) => a + x.amount, 0);
      const left = p.qty - sq;
      await D.mutateCarry(c => { const x = c.items[keyOfItem(it)]; x.sold = (x.sold || 0) + sq; x.log = [...(x.log || []), { at: now(), qty: sq, avg: sq ? amt / sq : null, cut: !!cut }]; if (left <= 0) { x.state = 'done'; x.doneAt = now(); } else x.state = 'selling'; });
      if (sq) msgs.push(`${cut ? '⚡' : '🔔'} ${it.name}: ${fmt(sq)}주 평균 ${fmt(amt / sq)}원 매도${cut ? ` (전일 종가 대비 ${chg.toFixed(1)}% — 전량)` : ''} · 남은 ${fmt(Math.max(0, left))}주 · 매수 평균 대비 ${(((amt / sq) / it.avg - 1) * 100).toFixed(1)}%`);
    }
    if (msgs.length) await D.sendTelegram(msgs.join('\n'));
    return { ok: true, n: items.length, msgs };
  }

  return { judge, handleCmd, timeout, convert, morning, reconvert, pendingPhase, ckey, keyOfItem };
}

module.exports = { carryParts, RULE, carryCheck, sliceTarget, parseEodCmd, createEod, limitSellPrice };
