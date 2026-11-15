'use strict';
/* 자동매매 1단계(2026-11-15) — 후보 선정·점수·텔레그램 알림·그림자 기록. 주문은 하지 않는다(2단계에서 승인 → 가상 매수 연결).
   기획안 4·5장 그대로:
   · 대상 = 실시간 종목 기본 조건(시총 1조↑ · 종가>60일선>120일선 · 스마트머니 매집 CONT/STALL)
     + 당일 잠정 수급에서 외국인·기관·프로그램 모두 순매수 + 체결강도 100%↑ + 당일 상승 + 시가 대비 +8% 이하
   · 점수(100): 수급 강도 40 · 체결강도 15 · 상승률 구간 15 · 거래대금 15 · 추세 15 → 상위 10개를 추리고 상위 5개를 10:15에 알림
   · 업종당 2종목까지(같은 업종 3번째부터 제외)
   · 승인하지 않은 후보도 auto_runs 에 남겨(그림자 기록) 점수와 내 판단을 나중에 비교한다 */

const EXCL_NAME = /스팩|ETN|KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|SOL |ACE |RISE |PLUS |TIMEFOLIO|WON |BNK |마이티|히어로즈|인버스|레버리지|선물/;
const RULES = Object.freeze({
  capMinEok: 10000,          // 시총 1조(억원)
  cttrMin: 100,              // 체결강도 하한(%)
  openRiseMax: 8,            // 시가 대비 상승률 상한(%)
  sectorMax: 2,              // 업종당 최대 종목 수
  poolTop: 10,               // 점수로 추리는 후보 수
  notifyTop: 5,              // 알림에 싣는 수
  flowFullRatio: 0.10,       // 수급 합계 ÷ 거래대금이 이 값이면 수급 점수 만점
  amtWarnEok: 0,
});

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);

/* 1차: 이름·가격·이평선·매집(DB 값) — 시세 조회 전에 걸러 KIS 호출을 아낀다 */
function baseFilter(pool, scr, smx, held) {
  const out = [];
  for (const r of pool || []) {
    if (!r || !r.code || EXCL_NAME.test(r.name || '')) continue;
    if (held && held.has(r.code)) continue;
    const s = scr && scr[r.code];
    if (!s) continue;
    const close = num(s.close), m60 = num(s.ma60), m120 = num(s.ma120);
    if (!(close > 0 && m60 > 0 && m120 > 0 && close > m60 && m60 > m120)) continue;
    const st = smx && smx[r.code];
    if (!st || (st !== 'CONT' && st !== 'STALL')) continue;
    if (!(r.price > 0) || !(r.changePct > 0)) continue;
    if (r.open > 0 && Math.round((r.price / r.open - 1) * 1e4) / 100 > RULES.openRiseMax) continue;   // 소수 둘째 자리로 맞춰 경계(+8.00%) 부동소수점 오차 방지
    out.push({ ...r, sector: s.sector || '미분류', rs20: num(s.rs20_pctl), smx: st });
  }
  return out;
}

/* 2차: 시세 조회 결과(flow=외인·기관 잠정 수량, power=프로그램, cttr=체결강도)로 수급 조건 판정 */
function evalFlow(c, flow, power, cttr) {
  const fails = [];
  const fq = flow && flow.err == null ? num(flow.fq) : null;
  const oq = flow && flow.err == null ? num(flow.oq) : null;
  const pq = power && power.err == null ? num(power.pgQty) : null;
  const cs = cttr && cttr.err == null ? num(cttr.cttr) : null;
  if (fq == null) fails.push('외국인 수급 없음'); else if (!(fq > 0)) fails.push('외국인 순매도');
  if (oq == null) fails.push('기관 수급 없음'); else if (!(oq > 0)) fails.push('기관 순매도');
  if (pq == null) fails.push('프로그램 없음'); else if (!(pq > 0)) fails.push('프로그램 순매도');
  if (cs == null) fails.push('체결강도 없음'); else if (cs < RULES.cttrMin) fails.push(`체결강도 ${cs.toFixed(0)}%`);
  const p = c.price;
  return {
    pass: fails.length === 0, fails,
    m: {
      fq, oq, pq, cttr: cs,
      fAmt: fq != null ? fq * p : null, oAmt: oq != null ? oq * p : null, pAmt: pq != null ? pq * p : null,
      w52: power && power.err == null ? num(power.w52) : null,
      flowTime: flow && flow.err == null ? { f: flow.ft || null, o: flow.ot || null } : null,
    },
  };
}

/* 점수(100) */
function scoreOne(c, m, amtRankPct) {
  const sum = (m.fAmt || 0) + (m.oAmt || 0) + (m.pAmt || 0);
  const ratio = c.amt > 0 ? sum / c.amt : 0;
  const sFlow = 40 * clamp(ratio / RULES.flowFullRatio, 0, 1);
  const sCs = 15 * clamp(((m.cttr || 100) - 100) / 50, 0, 1);
  const r = c.changePct;
  let sRise;
  if (r <= 0) sRise = 0;
  else if (r < 1) sRise = 15 * r;
  else if (r <= 5) sRise = 15;
  else if (r < 10) sRise = 15 - (r - 5) * 2;
  else sRise = 5;
  const sAmt = 15 * clamp(amtRankPct, 0, 1);
  const rsPart = c.rs20 != null ? 10 * clamp(c.rs20 / 100, 0, 1) : 5;
  const near = m.w52 > 0 ? clamp((c.price / m.w52 - 0.85) / 0.15, 0, 1) * 5 : 2.5;   // 52주 고가 85%→0점, 100%→5점
  const sTrend = rsPart + near;
  const parts = { flow: sFlow, cttr: sCs, rise: sRise, amt: sAmt, trend: sTrend };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])), ratio };
}

/* 점수 순위 → 업종당 2종목까지 → 상위 N */
function rankAndPick(list, topN = RULES.poolTop) {
  const sorted = list.slice().sort((a, b) => b.score.total - a.score.total);
  const cnt = {}, pick = [], dropped = [];
  for (const c of sorted) {
    cnt[c.sector] = (cnt[c.sector] || 0) + 1;
    if (cnt[c.sector] > RULES.sectorMax) { dropped.push({ code: c.code, why: `업종 ${c.sector} ${cnt[c.sector]}번째` }); continue; }
    if (pick.length < topN) pick.push(c);
  }
  return { pick, dropped };
}

const won = v => (v == null ? '–' : (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(Math.abs(v) >= 1e10 ? 0 : 1) + '억' : Math.round(v / 1e4) + '만'));
const fmtN = v => Math.round(v).toLocaleString('ko-KR');

/* 텔레그램 메시지 */
function formatMessage(date, picks, ctx = {}) {
  const head = `📈 자동매매 후보 · ${date} ${ctx.timeText || ''}`.trim();
  if (ctx.restDay) return `${head}\n\n오늘은 쉬는 날로 판단했어요.\n사유: ${ctx.restDay}`;
  if (!picks.length) return `${head}\n\n조건을 모두 통과한 종목이 없어요. 오늘은 후보 없음.${ctx.note ? '\n' + ctx.note : ''}`;
  const lines = [head, ''];
  picks.forEach((c, i) => {
    const m = c.m, s = c.score;
    lines.push(`${i + 1}. ${c.name}(${c.code}) ${s.total}점`);
    lines.push(`   ${fmtN(c.price)}원 ${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}% (시가대비 ${c.open > 0 ? ((c.price / c.open - 1) * 100).toFixed(1) : '–'}%) · 체결강도 ${m.cttr.toFixed(0)}%`);
    lines.push(`   순매수 외 ${won(m.fAmt)} · 기 ${won(m.oAmt)} · 프 ${won(m.pAmt)} (거래대금 대비 ${(s.ratio * 100).toFixed(1)}%)`);
    lines.push(`   ${c.sector} · ${(c.reasons || []).join(' · ')}`);
    if (c.warns && c.warns.length) lines.push(`   ⚠ ${c.warns.join(' · ')}`);
  });
  if (ctx.warn) lines.push('', `⚠ ${ctx.warn}`);
  lines.push('', `답장: /매수 1 3 5 (번호) · /매수 전체 · /패스`, `${ctx.deadline || '10:30'}까지 답이 없으면 전부 취소돼요. (자동으로 사지 않습니다)`);
  return lines.join('\n');
}

function reasonsFor(c) {
  const r = [`수급 외·기·프 동시`, `매집 ${c.smx === 'CONT' ? '지속' : '고점 후 정체'}`];
  if (c.m.cttr >= 120) r.push(`체결강도 강함`);
  return r;
}

/* 승인 명령 파싱: "/매수 1 3 5" · "/매수 전체" · "/패스" */
function parseApproval(text, max) {
  const t = String(text || '').trim();
  if (/^\/?(?:패스|pass|skip)\s*$/i.test(t)) return { kind: 'pass' };
  let m = t.match(/^\/?(?:매수|buy)\s+(전체|all)\s*$/i);
  if (m) return { kind: 'buy', nums: Array.from({ length: max }, (_, i) => i + 1) };
  m = t.match(/^\/?(?:매수|buy)\s+([\d\s,]+)$/i);
  if (m) {
    const nums = [...new Set(m[1].split(/[\s,]+/).filter(Boolean).map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= max);
    if (nums.length) return { kind: 'buy', nums };
    return { kind: 'bad' };
  }
  return null;
}

/* ── 서버에 붙는 부분: deps 로 시세·DB·텔레그램을 받는다(테스트에서 가짜로 교체) ── */
function createAuto(deps) {
  const D = deps;
  const state = { date: null, ranDone: false, noticeDone: false, msgText: null, lastErr: null, running: false, run: null };

  const kstParts = () => D.kstNow();            // { date:'YYYY-MM-DD', min: 분 }
  const isTradingDay = date => D.isTradingDay(date);

  async function enabled() {
    if (D.forceEnabled != null) return !!D.forceEnabled;
    try { const r = await D.sbGet('auto_config?select=key,value&key=eq.main&limit=1'); return !!(r[0] && r[0].value && r[0].value.on); } catch (_) { return false; }
  }
  async function amountEok() {
    try { const r = await D.sbGet('auto_config?select=value&key=eq.main&limit=1'); return (r[0] && r[0].value && +r[0].value.perStockKrw) || 1000000; } catch (_) { return 1000000; }
  }

  async function loadScreener() {
    const d = await D.sbGet('v_screener?select=trade_date&order=trade_date.desc&limit=1');
    const date = d[0] && d[0].trade_date;
    const map = {};
    for (let off = 0; off < 6000; off += 1000) {
      const part = await D.sbGet(`v_screener?select=code,close,ma60,ma120,sector,rs20_pctl&trade_date=eq.${date}&market_cap=gte.${RULES.capMinEok * 1e8}&order=code.asc&limit=1000&offset=${off}`);
      part.forEach(r => { map[r.code] = r; });
      if (part.length < 1000) break;
    }
    return { date, map };
  }
  async function loadSmx() {
    const map = {};
    for (let off = 0; off < 20000; off += 1000) {
      const part = await D.sbGet(`smx_state?select=code,st&win=eq.all&st=in.(CONT,STALL)&order=code.asc&limit=1000&offset=${off}`);
      part.forEach(r => { map[r.code] = r.st; });
      if (part.length < 1000) break;
    }
    return map;
  }
  async function loadHeld() {
    try { const r = await D.sbGet('positions?select=code&portfolio=eq.VIRTUAL&status=eq.OPEN'); return new Set(r.map(x => x.code)); } catch (_) { return new Set(); }
  }

  /* 시장 상태: 코스피 -1% 이하 → 경고(기획안 8장). 지수 조회 실패는 경고 없이 진행 */
  async function marketWarn() {
    try { const w = await D.marketState(); return w || null; } catch (_) { return null; }
  }

  async function select() {
    const [scr, smx, held, pool] = await Promise.all([loadScreener(), loadSmx(), loadHeld(), D.livePool()]);
    const base = baseFilter(pool, scr.map, smx, held).sort((a, b) => b.changePct - a.changePct);
    const stat = { pool: (pool || []).length, base: base.length, flowPass: 0, errs: 0 };
    const passed = [];
    for (const c of base.slice(0, 40)) {
      const [flow, power, cttr] = await Promise.all([D.fetchFlow(c.code), D.fetchPower(c.code), D.fetchCttr(c.code)]);
      const ev = evalFlow(c, flow, power, cttr);
      if (ev.fails.some(f => /없음/.test(f))) stat.errs++;
      if (!ev.pass) { c.fails = ev.fails; c.m = ev.m; c.shadowOnly = false; continue; }
      c.m = ev.m; stat.flowPass++; passed.push(c);
    }
    const byAmt = passed.slice().sort((a, b) => a.amt - b.amt);
    passed.forEach(c => { c.score = scoreOne(c, c.m, byAmt.length > 1 ? byAmt.indexOf(c) / (byAmt.length - 1) : 1); c.reasons = reasonsFor(c); });
    const { pick, dropped } = rankAndPick(passed, RULES.poolTop);
    return { picks: pick, dropped, stat, scrDate: scr.date, passedAll: passed };
  }

  async function recordRun(date, status, payload) {
    await D.sbWrite('auto_runs?on_conflict=trade_date', 'POST', [{ trade_date: date, status, payload, updated_at: new Date().toISOString() }]);
  }
  async function readRun(date) {
    const r = await D.sbGet(`auto_runs?select=*&trade_date=eq.${date}&limit=1`);
    return r[0] || null;
  }

  /* 10:05 선정 + 그림자 기록 → 10:15 알림. 한 번만(auto_runs 에 오늘 기록이 있으면 건너뜀 — 서버 재시작·재호출 안전) */
  async function runSelection(force) {
    const { date } = kstParts();
    if (state.running) return { ok: false, why: '진행 중' };
    state.running = true;
    try {
      if (!force) {
        const ex = await readRun(date).catch(() => null);
        if (ex) { state.date = date; state.run = ex; return { ok: true, skipped: true, status: ex.status }; }
      }
      const warn = await marketWarn();
      const sel = await select();
      const shadow = sel.passedAll.map(c => ({
        code: c.code, name: c.name, score: c.score.total, parts: c.score.parts, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector,
        m: c.m, picked: sel.picks.some(p => p.code === c.code),
      }));
      const payload = {
        selectedAt: new Date().toISOString(), stat: sel.stat, scrDate: sel.scrDate, warn: warn || null,
        picks: sel.picks.slice(0, RULES.notifyTop).map(c => ({ code: c.code, name: c.name, score: c.score.total, ratio: c.score.ratio, amt: c.amt, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector, smx: c.smx, reasons: c.reasons, m: c.m, parts: c.score.parts })),
        shadow, dropped: sel.dropped, approved: [], decision: null, noticeSent: false,
      };
      await recordRun(date, 'selected', payload);
      state.date = date; state.run = { trade_date: date, status: 'selected', payload };
      return { ok: true, picks: sel.picks.length, stat: sel.stat };
    } finally { state.running = false; }
  }

  async function sendNotice(force) {
    const { date, min } = kstParts();
    const ex = state.run && state.run.trade_date === date ? state.run : await readRun(date).catch(() => null);
    if (!ex) return { ok: false, why: '선정 기록 없음' };
    if (ex.payload && ex.payload.noticeSent && !force) return { ok: true, skipped: true };
    const picks = (ex.payload.picks || []).map(p => ({ ...p, score: { total: p.score, ratio: p.ratio || 0 }, warns: [] }));
    const text = formatMessage(date, picks, { timeText: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`, warn: ex.payload.warn, deadline: '10:30' });
    await D.sendTelegram(text);
    ex.payload.noticeSent = true; ex.payload.noticeAt = new Date().toISOString();
    await recordRun(date, ex.status === 'selected' ? 'noticed' : ex.status, ex.payload);
    state.run = { ...ex, status: ex.status === 'selected' ? 'noticed' : ex.status };
    return { ok: true, picks: picks.length };
  }

  /* 텔레그램 답장 기록(1단계는 기록만; 2단계에서 onApprove 로 가상 매수 연결) */
  async function handleApproval(text) {
    const { date, min } = kstParts();
    const ex = await readRun(date).catch(() => null);
    const max = ex && ex.payload && ex.payload.picks ? ex.payload.picks.length : 0;
    const a = parseApproval(text, Math.max(max, 1));
    if (!a) return null;
    if (!ex || !max) return '오늘은 승인할 후보가 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 1~${max} 중에서 골라요. 예) /매수 1 3`;
    if (min > 10 * 60 + 30 && !D.allowLateApproval) return '승인 마감(10:30)이 지났어요. 오늘은 취소 처리돼요.';
    if (ex.payload.decision && ex.payload.decision.kind) return `이미 처리했어요: ${ex.payload.decision.kind === 'pass' ? '패스' : '매수 ' + ex.payload.decision.nums.join(',')}`;
    const dec = a.kind === 'pass' ? { kind: 'pass', at: new Date().toISOString() } : { kind: 'buy', nums: a.nums, at: new Date().toISOString() };
    ex.payload.decision = dec;
    ex.payload.approved = a.kind === 'buy' ? a.nums.map(n => ex.payload.picks[n - 1].code) : [];
    await recordRun(date, a.kind === 'pass' ? 'passed' : 'approved', ex.payload);
    state.run = { ...ex, status: a.kind === 'pass' ? 'passed' : 'approved' };
    if (a.kind === 'pass') return '오늘 후보를 모두 패스로 기록했어요.';
    const names = ex.payload.approved.map((c, i) => ex.payload.picks[a.nums[i] - 1].name).join(', ');
    if (D.onApprove) { try { return await D.onApprove(date, ex.payload); } catch (e) { return `승인은 기록했지만 매수 연결 중 오류: ${e.message}`; } }
    return `승인 기록: ${names}\n(자동 매수는 2단계에서 연결됩니다. 지금은 기록만 해요.)`;
  }

  /* 주기 호출: 서버 타이머와 외부 깨우기(/trigger-auto) 둘 다 이걸 부른다. 깨우기가 10분 간격이라 시각 창을 넓게 잡고 "아직 안 했으면 지금 한다"로 보완 */
  async function tick() {
    const { date, min } = kstParts();
    if (min < 10 * 60 + 5 || min >= 11 * 60) return { ok: true, idle: 'outside-window' };   // 창 밖에서는 DB 조회도 하지 않음
    if (!isTradingDay(date)) return { ok: true, idle: 'non-trading' };
    const have = state.run && state.run.trade_date === date;
    if (have && state.run.payload && state.run.payload.noticeSent) return { ok: true, idle: 'done' };
    if (!have && state.checkedAt && Date.now() - state.checkedAt < 25000) return { ok: true, idle: 'busy' };
    state.checkedAt = Date.now();
    if (!(await enabled())) return { ok: true, idle: 'disabled' };
    const out = {};
    out.sel = await runSelection(false).catch(e => { state.lastErr = e.message; return { ok: false, err: e.message }; });
    if (min >= 10 * 60 + 15 && out.sel && out.sel.ok) out.notice = await sendNotice(false).catch(e => { state.lastErr = e.message; return { ok: false, err: e.message }; });
    return { ok: true, date, min, ...out };
  }

  function status() { return { date: state.date, run: state.run && { status: state.run.status, picks: ((state.run.payload || {}).picks || []).length }, lastErr: state.lastErr }; }
  return { tick, runSelection, sendNotice, handleApproval, status, _select: select };
}

module.exports = { RULES, EXCL_NAME, baseFilter, evalFlow, scoreOne, rankAndPick, formatMessage, parseApproval, createAuto };
