'use strict';
/* 자동매매 1~2단계(2026-11-15) — 후보 선정·점수·텔레그램 알림·그림자 기록(1단계) + 승인 → 가상 매수·손절·5분할 익절(2단계, auto-exec.js).
   기획안 4·5장 그대로:
   · 대상 = 실시간 종목 기본 조건(시총 1조↑ · 종가>60일선>120일선 · 스마트머니 매집 CONT/STALL)
     + 당일 잠정 수급에서 외국인·기관·프로그램 모두 순매수 + 체결강도 100%↑ + 당일 상승 + 시가 대비 +8% 이하
   · 점수(100): 수급 강도 40 · 체결강도 15 · 상승률 구간 15 · 거래대금 15 · 추세 15 → 상위 10개를 추리고 상위 5개를 10:15에 알림
   · 업종당 2종목까지(같은 업종 3번째부터 제외)
   · 승인하지 않은 후보도 auto_runs 에 남겨(그림자 기록) 점수와 내 판단을 나중에 비교한다 */

const ST = require('./auto-strategy');
const DEFP = Object.freeze(ST.defaults('intraday'));   // 기본 장중 전략 조건값(= 1~3단계 확정값). 함수 인자를 안 주면 이 값
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
function baseFilter(pool, scr, smx, held, P = DEFP) {
  const out = [];
  for (const r of pool || []) {
    if (!r || !r.code || EXCL_NAME.test(r.name || '')) continue;
    if (held && held.has(r.code)) continue;
    const s = scr && scr[r.code];
    if (!s) continue;
    const close = num(s.close), m60 = num(s.ma60), m120 = num(s.ma120);
    if (!(close > 0)) continue;
    if (P.maTrend && !(m60 > 0 && m120 > 0 && close > m60 && m60 > m120)) continue;
    const st = (smx && smx[r.code]) || null;
    if (P.smx !== 'off' && !(st === 'CONT' || (P.smx === 'cont_stall' && st === 'STALL'))) continue;
    if (!(r.price > 0) || !(r.changePct > 0)) continue;
    if (r.open > 0 && Math.round((r.price / r.open - 1) * 1e4) / 100 > P.openRiseMax) continue;   // 소수 둘째 자리로 맞춰 경계(+8.00%) 부동소수점 오차 방지
    out.push({ ...r, sector: s.sector || '미분류', rs20: num(s.rs20_pctl), smx: st });
  }
  return out;
}

/* 2차: 시세 조회 결과(flow=외인·기관 잠정 수량, power=프로그램, cttr=체결강도)로 수급 조건 판정 */
function evalFlow(c, flow, power, cttr, P = DEFP) {
  const fails = [];
  const fq = flow && flow.err == null ? num(flow.fq) : null;
  const oq = flow && flow.err == null ? num(flow.oq) : null;
  const pq = power && power.err == null ? num(power.pgQty) : null;
  const cs = cttr && cttr.err == null ? num(cttr.cttr) : null;
  const need = (mode, v, miss, neg) => { if (mode !== 'req') return; if (v == null) fails.push(miss); else if (!(v > 0)) fails.push(neg); };   // 필수만 탈락 사유, 가점·무시는 통과
  need(P.flowForeign, fq, '외국인 수급 없음', '외국인 순매도');
  need(P.flowInst, oq, '기관 수급 없음', '기관 순매도');
  need(P.flowProgram, pq, '프로그램 없음', '프로그램 순매도');
  if (cs == null) fails.push('체결강도 없음'); else if (cs < P.cttrMin) fails.push(`체결강도 ${cs.toFixed(0)}%`);
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
function scoreOne(c, m, amtRankPct, P = DEFP) {
  const W = P.weights, use = (mode, v) => (mode === 'ignore' ? 0 : mode === 'req' ? (v || 0) : Math.max(0, v || 0));   // 필수는 통과했으니 양수, 가점은 순매수일 때만 더함
  const sum = use(P.flowForeign, m.fAmt) + use(P.flowInst, m.oAmt) + use(P.flowProgram, m.pAmt);
  const ratio = c.amt > 0 ? sum / c.amt : 0;
  const sFlow = W.flow * clamp(ratio / RULES.flowFullRatio, 0, 1);
  const sCs = W.cttr * clamp(((m.cttr || 100) - 100) / 50, 0, 1);
  const r = c.changePct;
  let sRise;
  if (r <= 0) sRise = 0;
  else if (r < 1) sRise = 15 * r;
  else if (r <= 5) sRise = 15;
  else if (r < 10) sRise = 15 - (r - 5) * 2;
  else sRise = 5;
  sRise *= W.rise / 15;
  const sAmt = W.amt * clamp(amtRankPct, 0, 1);
  const rsPart = c.rs20 != null ? 10 * clamp(c.rs20 / 100, 0, 1) : 5;
  const near = m.w52 > 0 ? clamp((c.price / m.w52 - 0.85) / 0.15, 0, 1) * 5 : 2.5;   // 52주 고가 85%→0점, 100%→5점
  const sTrend = (rsPart + near) * W.trend / 15;
  const parts = { flow: sFlow, cttr: sCs, rise: sRise, amt: sAmt, trend: sTrend };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])), ratio };
}

/* 점수 순위 → 업종당 2종목까지 → 상위 N */
function rankAndPick(list, topN = DEFP.poolTop, sectorMax = DEFP.sectorMax) {
  const sorted = list.slice().sort((a, b) => b.score.total - a.score.total);
  const cnt = {}, pick = [], dropped = [];
  for (const c of sorted) {
    cnt[c.sector] = (cnt[c.sector] || 0) + 1;
    if (cnt[c.sector] > sectorMax) { dropped.push({ code: c.code, why: `업종 ${c.sector} ${cnt[c.sector]}번째` }); continue; }
    if (pick.length < topN) pick.push(c);
  }
  return { pick, dropped };
}

const won = v => (v == null ? '–' : (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(Math.abs(v) >= 1e10 ? 0 : 1) + '억' : Math.round(v / 1e4) + '만'));
const fmtN = v => Math.round(v).toLocaleString('ko-KR');

/* 텔레그램 메시지 */
/* 시장 상태 점수(E1) → 종목당 금액 배수. 전략 조건값 regimeMode 가 'scale' 일 때만(기본 '표시만') */
const REGIME_KO = { attack: '공격', normal: '보통', caution: '보수', defense: '방어' };
function regimeMult(P, rg) {
  if (!P || P.regimeMode !== 'scale' || !rg) return 1;
  if (rg.stage === 'caution') return (+P.regimeCaution || 100) / 100;
  if (rg.stage === 'defense') return (+P.regimeDefense || 100) / 100;
  return 1;
}
function regimeLine(rg, P, perStock) {
  if (!rg) return null;
  const m = regimeMult(P, rg), d = String(rg.date || '').slice(5).replace('-', '/');
  return `📊 시장 상태 ${REGIME_KO[rg.stage] || rg.stage} ${rg.score}점(${d} 종가 기준)` + (m < 1 ? ` — 종목당 금액 ${Math.round(m * 100)}%${perStock ? `(${fmtN(perStock)}원)` : ''}` : P && P.regimeMode === 'scale' ? '' : ' · 표시만');
}

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
  if (ctx.regime) lines.push(ctx.warn ? ctx.regime : '\n' + ctx.regime);
  if (ctx.events) lines.push(ctx.regime || ctx.warn || ctx.exposure ? ctx.events : '\n' + ctx.events);
  if (ctx.exposure) lines.push(ctx.regime || ctx.warn ? ctx.exposure : '\n' + ctx.exposure);
  if (ctx.auto) lines.push('', '🤖 자동 매수 설정 — 알림 직후 위 후보를 모두 가상 매수합니다.');
  else lines.push('', `답장: /매수 1 3 5 (번호) · /매수 전체 · /패스`, `${ctx.deadline || '10:30'}까지 답이 없으면 전부 취소돼요. (자동으로 사지 않습니다)`);
  return lines.join('\n');
}

function reasonsFor(c, P = DEFP) {
  const allReq = P.flowForeign === 'req' && P.flowInst === 'req' && P.flowProgram === 'req';
  const pos = [['외', c.m.fAmt], ['기', c.m.oAmt], ['프', c.m.pAmt]].filter(([, v]) => v > 0).map(([k]) => k);
  const r = [allReq ? `수급 외·기·프 동시` : pos.length ? `순매수 ${pos.join('·')}` : '수급 조건 없음'];
  if (c.smx) r.push(`매집 ${c.smx === 'CONT' ? '지속' : '고점 후 정체'}`);
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

/* 승인 명령(여러 전략): "/매수 A1 B2" · "/매수 1 3"(대기 중인 전략이 하나일 때) · "/매수 전체" · "/패스" */
function parseCmdMulti(text, verb) {
  const t = String(text || '').trim();
  const V = verb === 'buy' ? '(?:매수|buy)' : '정리';
  if (verb === 'buy' && /^\/?(?:패스|pass|skip)\s*$/i.test(t)) return { kind: 'pass' };
  if (verb === 'eod' && /^\/?유지\s*$/.test(t)) return { kind: 'keep' };
  if (new RegExp(`^\\/?${V}\\s+(?:전체|all)\\s*$`, 'i').test(t)) return { kind: 'all' };
  const m = t.match(new RegExp(`^\\/?${V}\\s+([A-Za-z\\d\\s,]+)$`, 'i'));
  if (m) {
    const items = [];
    for (const tok of m[1].split(/[\s,]+/).filter(Boolean)) {
      const x = /^([A-Ca-c])?(\d{1,2})$/.exec(tok);
      if (!x) return { kind: 'bad' };
      items.push({ letter: x[1] ? x[1].toUpperCase() : null, n: +x[2] });
    }
    return items.length ? { kind: 'pick', items } : { kind: 'bad' };
  }
  if (new RegExp(`^\\/?${V}\\s*$`, 'i').test(t)) return { kind: 'bad' };
  return null;
}

/* ── 서버에 붙는 부분: deps 로 시세·DB·텔레그램을 받는다(테스트에서 가짜로 교체) ──
   C단계(2026-11-16): 켜진 장중 전략(최대 3, 글자 A·B·C)마다 하루 기록(auto_runs: 날짜+전략) · 매수 실행 · 종가 판정을 따로 돌린다.
   종가베팅 전략은 하나(장중 보유분을 15:10에 넘겨받음). 같은 종목은 먼저 산 전략만 보유 */
function createAuto(deps) {
  const D = deps;
  const state = { date: null, lastErr: null, running: false, runs: {}, runsAt: 0, checkedAt: {}, carry: null, carryAt: 0, multi: false };
  const DEF_SID = 'intraday-default';
  const RISK = require('./auto-risk'), EV = require('./auto-events'), EXC = require('./auto-excursion');
  const JR_AT = require('./auto-journal').JOURNAL_AT, JR_FIN = require('./auto-journal').FINISH_AT;

  const kstParts = () => D.kstNow();            // { date:'YYYY-MM-DD', min: 분 }
  const store = D.strategies || ST.createStore({ sbGet: D.sbGet, sbWrite: D.sbWrite, now: D.now || Date.now });   // 전략(조건값). 테이블이 없으면 기본 전략
  const CDEF = ST.defaults('closing');
  const fallback = () => {
    const I = { id: DEF_SID, name: '기본', version: 1, enabled: true, params: DEFP, letter: 'A', T: ST.timesOf(DEFP, CDEF) };
    return { Is: [I], C: { id: 'closing-default', version: 1, enabled: true, params: CDEF } };
  };
  const actives = async () => {
    if (store.actives) return store.actives().catch(fallback);
    const P = await store.pair().catch(() => null);   // 테스트용 단순 저장소(pair 만 있음)
    if (!P) return fallback();
    return { Is: P.I.enabled ? [{ ...P.I, letter: 'A', T: P.T }] : [], C: P.C };
  };
  /* 전략 id → 조건값(보관·삭제된 전략의 지난 기록도 처리할 수 있게 목록 전체에서 찾고, 없으면 기본값) */
  async function intraOf(sid) {
    const A = await actives();
    const a = A.Is.find(i => i.id === sid);
    if (a) return { I: a, C: A.C };
    const r = store.byId ? await store.byId(sid).catch(() => null) : null;
    const I = r && r.kind === 'intraday' ? r : { id: sid, name: sid, version: 1, enabled: false, params: DEFP };
    return { I: { ...I, T: ST.timesOf(I.params, A.C.params) }, C: A.C };
  }
  const pair = async () => { const A = await actives(); const I = A.Is[0] || (await intraOf(DEF_SID)).I; return { I, C: A.C, T: I.T }; };
  const isTradingDay = date => D.isTradingDay(date);

  async function masterOn() {
    if (D.forceEnabled != null) return !!D.forceEnabled;
    try { const r = await D.sbGet('auto_config?select=key,value&key=eq.main&limit=1'); return !!(r[0] && r[0].value && r[0].value.on); } catch (_) { return false; }
  }

  async function loadScreener(P) {
    const d = await D.sbGet('v_screener?select=trade_date&order=trade_date.desc&limit=1');
    const date = d[0] && d[0].trade_date;
    const map = {};
    for (let off = 0; off < 6000; off += 1000) {
      const part = await D.sbGet(`v_screener?select=code,close,ma60,ma120,sector,rs20_pctl&trade_date=eq.${date}&market_cap=gte.${P.capMinEok * 1e8}&order=code.asc&limit=1000&offset=${off}`);
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
  async function loadHeld() {   // 가상매매에서 이미 보유·주문 중인 종목은 후보에서 제외
    try { return D.paper && D.paper.heldCodes ? new Set(D.paper.heldCodes()) : new Set(); } catch (_) { return new Set(); }
  }

  /* 시장 상태: 코스피 -1% 이하 → 경고(기획안 8장). 지수 조회 실패는 경고 없이 진행 */
  async function marketWarn() {
    try { const w = await D.marketState(); return w || null; } catch (_) { return null; }
  }

  async function select(P = DEFP) {
    const [scr, smx, held, pool] = await Promise.all([loadScreener(P), loadSmx(), loadHeld(), D.livePool(P.capMinEok)]);
    const base = baseFilter(pool, scr.map, smx, held, P).sort((a, b) => b.changePct - a.changePct);
    const stat = { pool: (pool || []).length, base: base.length, flowPass: 0, errs: 0 };
    const passed = [], rejected = [];
    for (const c of base.slice(0, 40)) {
      const [flow, power, cttr] = await Promise.all([D.fetchFlow(c.code), D.fetchPower(c.code), D.fetchCttr(c.code)]);
      const ev = evalFlow(c, flow, power, cttr, P);
      if (ev.fails.some(f => /없음/.test(f))) stat.errs++;
      if (!ev.pass) { c.fails = ev.fails; c.m = ev.m; rejected.push({ code: c.code, name: c.name, changePct: c.changePct, fails: ev.fails }); continue; }
      c.m = ev.m; stat.flowPass++; passed.push(c);
    }
    const byAmt = passed.slice().sort((a, b) => a.amt - b.amt);
    passed.forEach(c => { c.score = scoreOne(c, c.m, byAmt.length > 1 ? byAmt.indexOf(c) / (byAmt.length - 1) : 1, P); c.reasons = reasonsFor(c, P); });
    const { pick, dropped } = rankAndPick(passed, P.poolTop, P.sectorMax);
    return { picks: pick, dropped, stat, scrDate: scr.date, passedAll: passed, rejected };
  }

  /* auto_runs(날짜+전략) 쓰기는 모두 이 잠금 안에서 "새로 읽기 → 고치기 → 저장" — 알림·승인·주문 관리가 서로 덮어쓰지 않게 */
  let chain = Promise.resolve();
  const lock = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const sidOf = run => (run && (run.strategy_id || (run.payload && run.payload.strategy && run.payload.strategy.id))) || DEF_SID;
  async function writeRun(run) {
    const st = run.payload && run.payload.strategy, sid = sidOf(run);
    await D.sbWrite('auto_runs?on_conflict=trade_date,strategy_id', 'POST', [{ trade_date: run.trade_date, strategy_id: sid, strategy_version: st ? st.version : null, status: run.status, payload: run.payload, updated_at: new Date().toISOString() }]);
    run.strategy_id = sid;
    if (state.date === run.trade_date) state.runs[sid] = run;
  }
  async function readRun(date, sid = DEF_SID) {
    const r = await D.sbGet(`auto_runs?select=*&trade_date=eq.${date}&strategy_id=eq.${encodeURIComponent(sid)}&limit=1`);
    return r[0] || null;
  }
  async function readRuns(date) {
    const r = await D.sbGet(`auto_runs?select=*&trade_date=eq.${date}&order=strategy_id.asc&limit=20`);
    return r || [];
  }
  function mutateRun(date, sid, fn) {
    if (typeof sid === 'function') { fn = sid; sid = DEF_SID; }   // 예전 호출(전략 하나) 호환
    return lock(async () => {
      const run = await readRun(date, sid);
      if (!run) throw new Error('오늘 자동매매 기록이 없습니다');
      run.payload = run.payload || {};
      const ret = await fn(run);
      await writeRun(run);
      return ret;
    });
  }

  /* 시장 상태 점수: 오늘 이전 가장 최근 날(전날 종가 기준). 10분 캐시, 테이블이 없으면 null */
  async function regimeOf(date) {
    const c = state.regime;
    if (c && c.date === date && Date.now() - c.at < 600e3) return c.row;
    let row = null;
    try { const r = await D.sbGet(`market_regime?select=trade_date,score,stage,parts&trade_date=lt.${date}&order=trade_date.desc&limit=1`); if (r && r[0]) row = { date: r[0].trade_date, score: +r[0].score, stage: r[0].stage, parts: r[0].parts || null }; } catch (_) {}
    state.regime = { date, row, at: Date.now() };
    return row;
  }
  async function perStockOf(sid) {
    const { I } = await intraOf(sid);
    if (!store.isMissing()) {
      const m = regimeMult(I.params, await regimeOf(kstParts().date));
      return m < 1 ? Math.max(10000, Math.floor(I.params.perStockKrw * m / 10000) * 10000) : I.params.perStockKrw;
    }
    try { const r = await D.sbGet('auto_config?select=value&key=eq.main&limit=1'); return (r[0] && r[0].value && +r[0].value.perStockKrw) || 1000000; } catch (_) { return 1000000; }   // 전략 테이블 전: 예전 설정
  }
  const perStock = async () => { const { I } = await pair(); return store.isMissing() ? perStockOf(I.id) : I.params.perStockKrw; };   // 설정 표시용(시장 상태 조절 전 금액)
  /* 엔진별로 쓰는 형태 */
  async function execOpt(sid) {
    const p = (await intraOf(sid)).I.params;
    return { stopPct: p.stopPct, rr: p.rr, trail: p.trail, split: p.split, minPct: p.minPct, recheckPct: p.recheckPct, openRiseMax: p.openRiseMax, cttrMin: p.cttrMin, buyPick: p.buyPick, fillWaitMs: p.fillWaitMin * 60e3, totalCapKrw: +p.totalCapKrw || 0 };
  }
  async function eodRule(sid) {
    const { I, C } = await intraOf(sid), c = C.params, T = ST.timesOf(I.params, c);
    return { highNear: 1 - c.highNearPct / 100, idxFloor: c.idxFloor, gapCut: c.gapCut, slices: T.slices, needAboveAvg: c.needAboveAvg, carryFlow: c.carryFlow,
      overnightStopPct: c.overnightStopPct, replyEnd: T.reply, convertAt: T.convert, eodWeak: I.params.eodWeak, eodTimeout: I.params.eodTimeout, closingOn: !!C.enabled };
  }
  /* 종가 베팅 넘긴 종목(auto_config 'carry') — 같은 잠금 안에서 읽기 → 고치기 → 저장 */
  async function readCarry() {
    const r = await D.sbGet('auto_config?select=value&key=eq.carry&limit=1');
    return (r[0] && r[0].value) || { items: {} };
  }
  function mutateCarry(fn) {
    return lock(async () => {
      const c = await readCarry(); c.items = c.items || {};
      const ret = await fn(c);
      for (const [k, v] of Object.entries(c.items)) if (v.state === 'done' && v.doneAt && Date.now() - v.doneAt > 7 * 864e5) delete c.items[k];   // 끝난 지 7일 지난 기록 정리
      await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'carry', value: c, updated_at: new Date().toISOString() }]);
      state.carry = c; state.carryAt = Date.now();
      return ret;
    });
  }
  /* 전략이 여럿이면 텔레그램 메시지 앞에 [A · 이름]을 붙인다(답할 때 번호 앞에 그 글자) */
  const labelOf = sid => { const r = state.runs[sid]; const p = r && r.payload; return p && p.letter ? `${p.letter} · ${(p.strategy && p.strategy.name) || sid}` : sid; };
  const tgFor = sid => t => D.sendTelegram(state.multi ? `[${labelOf(sid)}] ${(state.runs[sid] && state.runs[sid].payload.letter) ? `— 답할 때 번호 앞에 ${state.runs[sid].payload.letter} (예: ${state.runs[sid].payload.letter}1)` : ''}\n${t}` : t);
  /* E2-1: 자동매매가 들고 있는(또는 주문 중인) 종목의 총 노출·손절 시 손실. 자동매매 종목 = 오늘 모든 전략의 주문 + 아직 안 판 이월 종목 */
  async function autoCodes(date) {
    const set = new Set();
    for (const r of await readRuns(date).catch(() => [])) for (const [code, o] of Object.entries((r.payload && r.payload.orders) || {})) if (['intent', 'open', 'modified', 'filled', 'partial_done'].includes(o.st) || o.filled > 0) set.add(code);
    const c = await readCarry().catch(() => ({ items: {} }));
    Object.values((c && c.items) || {}).filter(i => i.state !== 'done').forEach(i => set.add(i.code));
    return set;
  }
  /* E2-3: 보유 중 최고·최저(MFE·MAE) 기록 — 30초 tick 마다 자동매매 종목의 현재가를 훑음. 저장은 바뀔 때 최대 60초에 한 번 */
  async function excStore() {
    if (state.exc) return state.exc;
    let v = null; try { const r = await D.sbGet('auto_config?select=value&key=eq.excursion&limit=1'); v = r && r[0] && r[0].value; } catch (_) {}
    return (state.exc = v && typeof v === 'object' ? { pos: v.pos || {}, done: v.done || [] } : EXC.fresh());
  }
  async function excTick(date, min) {
    if (!D.paper || !D.paper.state || min < 540 || min > 935) return null;
    const ps = await D.paper.state();
    if (!ps || !ps.ok) return null;                      // 상태를 못 읽었을 때 "다 팔았다"로 오해하지 않도록 건너뜀
    const watch = new Set();
    if (!state.carry || Date.now() - (state.carryAt || 0) > 60000) { state.carry = await readCarry().catch(() => state.carry); state.carryAt = Date.now(); }
    for (const r of Object.values(state.runs)) for (const [code, o] of Object.entries((r.payload && r.payload.orders) || {})) if (['intent', 'open', 'modified', 'filled', 'partial_done'].includes(o.st) || o.filled > 0) watch.add(code);
    Object.values((state.carry && state.carry.items) || {}).filter(i => i.state !== 'done').forEach(i => watch.add(i.code));
    const st = await excStore(), nDone = st.done.length;
    const r = EXC.update(st, ps.positions, watch, date);
    if (r.changed) state.excDirty = true;
    if (state.excDirty && (st.done.length !== nDone || Date.now() - (state.excSavedAt || 0) > 60e3)) {
      state.excSavedAt = Date.now(); state.excDirty = false;
      await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'excursion', value: st, updated_at: new Date().toISOString() }]).catch(() => { state.excDirty = true; });
    }
    return { n: Object.keys(st.pos).length };
  }
  async function exposureNow() {
    if (!D.paper || !D.paper.state) return null;
    const ps = await D.paper.state();
    if (!ps || !ps.ok) return null;
    return RISK.exposureOf(ps, await autoCodes(kstParts().date));
  }
  const execs = {}, eods = {};
  const execFor = sid => D.paper ? (execs[sid] = execs[sid] || require('./auto-exec').createExec({
    paper: D.paper, getQuote: D.getQuote, loadChart: D.loadChart, sendTelegram: tgFor(sid), now: D.now,
    mutateRun: (d, fn) => mutateRun(d, sid, fn), readRun: d => readRun(d, sid), perStock: () => perStockOf(sid), opt: () => execOpt(sid), exposure: exposureNow,
  })) : null;
  const eodFor = sid => D.paper ? (eods[sid] = eods[sid] || require('./auto-eod').createEod({
    paper: D.paper, getQuote: D.getQuote, fetchFlow: D.fetchFlow, marketIdx: D.marketIdx || (async () => ({})), sendTelegram: tgFor(sid), now: D.now,
    mutateRun: (d, fn) => mutateRun(d, sid, fn), readRun: d => readRun(d, sid), mutateCarry, readCarry, rule: () => eodRule(sid), tag: sid,
  })) : null;
  const exec = D.paper ? execFor(DEF_SID) : null;   // 아래 존재 여부 확인용
  const eodAny = D.paper ? require('./auto-eod').createEod({   // 아침 매도: 이월 종목 전체(전략 구분 없음)
    paper: D.paper, getQuote: D.getQuote, fetchFlow: D.fetchFlow, marketIdx: D.marketIdx || (async () => ({})), sendTelegram: D.sendTelegram, now: D.now,
    mutateRun: (d, fn) => mutateRun(d, DEF_SID, fn), readRun: d => readRun(d, DEF_SID), mutateCarry, readCarry, rule: () => eodRule(DEF_SID),
  }) : null;

  /* D단계: 전략별 장부 + 자동 일지(15:40 작성 · 전환 뒤 이월 반영 · 다음 거래일 아침 종가베팅 결과로 확정) */
  const JR = require('./auto-journal').createJournal({ sbGet: D.sbGet, sbWrite: D.sbWrite, sendTelegram: D.sendTelegram, now: D.now, paper: D.paper, readRuns, readCarry, actives, excursion: excStore });

  /* 선정 + 그림자 기록(전략별 하루 한 번 — 오늘 기록이 있으면 건너뜀). force(/자동후보)는 아직 승인·주문 전일 때만 다시 고름 */
  async function runSelectionFor(I, force) {
    const { date } = kstParts();
    const ex = await readRun(date, I.id).catch(() => null);
    if (ex && !force) { state.runs[I.id] = ex; return { ok: true, skipped: true, status: ex.status }; }
    if (ex && force && ((ex.payload && ex.payload.decision) || (ex.payload && ex.payload.orders))) return { ok: false, why: '오늘은 이미 승인·주문을 처리해서 다시 고를 수 없어요' };
    const warn = await marketWarn();
    const regime = await regimeOf(date);
    const sel = await select(I.params);
    const evs = await EV.loadEvents(D.sbGet, date);
    const shadow = sel.passedAll.map(c => ({
      code: c.code, name: c.name, score: c.score.total, parts: c.score.parts, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector,
      m: c.m, picked: sel.picks.some(p => p.code === c.code),
    }));
    const payload = {
      selectedAt: new Date().toISOString(), stat: sel.stat, scrDate: sel.scrDate, warn: warn || null,
      regime: regime ? { date: regime.date, score: regime.score, stage: regime.stage, mult: regimeMult(I.params, regime), mode: I.params.regimeMode || 'info' } : null,
      strategy: { id: I.id, version: I.version, name: I.name }, params: I.params, letter: I.letter || 'A',
      events: EV.marketNotes(evs, date, 1),
      picks: sel.picks.slice(0, I.params.notifyTop).map(c => ({ code: c.code, name: c.name, score: c.score.total, ratio: c.score.ratio, amt: c.amt, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector, smx: c.smx, reasons: c.reasons, m: c.m, parts: c.score.parts, ev: EV.stockBadges(evs, c.code, date) })),
      shadow, dropped: sel.dropped, rejected: sel.rejected.slice(0, 40), approved: [], decision: null, noticeSent: false,
    };
    await lock(() => writeRun({ trade_date: date, strategy_id: I.id, status: 'selected', payload }));
    return { ok: true, picks: sel.picks.length, stat: sel.stat };
  }
  /* /자동후보 등: 켜진 장중 전략 전부(또는 sid 하나) */
  async function runSelection(force, sid) {
    if (state.running) return { ok: false, why: '진행 중' };
    state.running = true;
    try {
      const A = await actives(), L = A.Is.filter(i => !sid || i.id === sid);
      if (!L.length) return { ok: false, why: '켜진 장중 전략이 없어요' };
      let last = null, any = false;
      for (const I of L) { last = await runSelectionFor(I, force); any = any || last.ok; }
      return L.length === 1 ? last : { ok: any, n: L.length, why: any ? undefined : (last && last.why) };
    } finally { state.running = false; }
  }

  async function sendNoticeFor(sid, force) {
    const { date, min } = kstParts();
    const hhmm = ST.hhmm(min);
    let text = null;
    const { I } = await intraOf(sid);
    const exLine = await exposureNow().then(e => RISK.exposureLine(e, I.params.totalCapKrw)).catch(() => null);
    await mutateRun(date, sid, run => {
      if (run.payload.noticeSent && !force) return;
      const picks = (run.payload.picks || []).map(p => ({ ...p, score: { total: p.score, ratio: p.ratio || 0 }, warns: p.ev || [] }));
      const rg = run.payload.regime, ps = rg && rg.mult < 1 ? Math.max(10000, Math.floor(I.params.perStockKrw * rg.mult / 10000) * 10000) : null;
      text = formatMessage(date, picks, { timeText: hhmm, warn: run.payload.warn, regime: regimeLine(rg, I.params, ps), exposure: exLine, events: EV.marketLine(run.payload.events), deadline: ST.hhmm(I.T.deadline), auto: I.params.approval === 'auto' && picks.length > 0 });
      if (state.multi && picks.length) text = text.replace(/\n(\d+)\. /g, `\n${run.payload.letter || 'A'}$1. `).replace('답장: /매수 1 3 5 (번호)', `답장: /매수 ${run.payload.letter || 'A'}1 ${run.payload.letter || 'A'}3 (글자+번호)`);
      run.payload.noticeSent = true; run.payload.noticeAt = new Date().toISOString();
      if (run.status === 'selected') run.status = 'noticed';
      state.runs[sid] = run;
    });
    if (text) await tgFor(sid)(text);
    return { ok: true, sent: !!text };
  }
  async function sendNotice(force, sid) {
    const { date } = kstParts();
    const runs = (await readRuns(date)).filter(r => !sid || sidOf(r) === sid);
    let sent = false;
    for (const r of runs) { const x = await sendNoticeFor(sidOf(r), force); sent = sent || x.sent; }
    return { ok: true, sent };
  }

  /* 승인 처리(한 전략): a = { kind: 'pass' } | { kind: 'buy', nums } | { kind: 'all' } */
  async function approveRun(date, sid, a, min) {
    const { I } = await intraOf(sid);
    if (min > I.T.deadline && !D.allowLateApproval) return `승인 마감(${ST.hhmm(I.T.deadline)})이 지났어요. 오늘은 취소 처리돼요.`;
    const res = await mutateRun(date, sid, run => {
      const max = (run.payload.picks || []).length;
      if (run.payload.decision && run.payload.decision.kind) return { dup: run.payload.decision };
      const nums = a.kind === 'all' ? Array.from({ length: max }, (_, i) => i + 1) : a.nums || [];
      if (a.kind !== 'pass' && (!nums.length || nums.some(n => n < 1 || n > max))) return { bad: max };
      run.payload.decision = a.kind === 'pass' ? { kind: 'pass', at: new Date().toISOString() } : { kind: 'buy', nums, at: new Date().toISOString() };
      run.payload.approved = a.kind === 'pass' ? [] : nums.map(n => run.payload.picks[n - 1].code);
      run.status = a.kind === 'pass' ? 'passed' : 'approved';
      return { payload: JSON.parse(JSON.stringify(run.payload)) };
    });
    if (res.bad) return `번호를 확인해 주세요. 1~${res.bad} 중에서 골라요.`;
    if (res.dup) return `이미 처리했어요: ${res.dup.kind === 'pass' ? '패스' : res.dup.kind === 'expired' ? '만료' : '매수 ' + res.dup.nums.join(',')}`;
    if (a.kind === 'pass') return '오늘 후보를 모두 패스로 기록했어요.';
    const ex = execFor(sid);
    if (!ex) return `승인 기록: ${res.payload.approved.join(', ')}\n(가상매매 엔진이 꺼져 있어 주문은 내지 않았어요.)`;
    try { return await ex.approve(date, res.payload); } catch (e) { return `승인은 기록했지만 가상 매수 중 오류: ${e.message}`; }
  }
  /* 텔레그램 답장: 글자(A·B·C)로 전략을 고름. 대기 중인 전략이 하나면 글자 없이도 됨 */
  async function handleApproval(text, onlySid) {
    const { date, min } = kstParts();
    const a = parseCmdMulti(text, 'buy');
    if (!a) return null;
    const runs = (await readRuns(date).catch(() => [])).filter(r => (!onlySid || sidOf(r) === onlySid) && (r.payload.picks || []).length);
    runs.forEach(r => { state.runs[sidOf(r)] = r; });
    if (!runs.length) return '오늘은 승인할 후보가 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 예) /매수 1 3${runs.length > 1 ? ' · 전략이 여럿이면 /매수 A1 B2' : ''}`;
    const pend = runs.filter(r => !(r.payload.decision && r.payload.decision.kind));
    const byLetter = l => runs.find(r => (r.payload.letter || 'A') === l);
    const jobs = [];
    if (a.kind === 'pass' || a.kind === 'all') {
      const L = pend.length ? pend : runs;
      L.forEach(r => jobs.push([sidOf(r), { kind: a.kind }]));
    } else {
      const g = {};
      for (const it of a.items) {
        let r = it.letter ? byLetter(it.letter) : (pend.length === 1 ? pend[0] : runs.length === 1 ? runs[0] : null);
        if (!r) return it.letter ? `${it.letter} 전략의 오늘 후보가 없어요.` : '전략이 여럿이에요. 번호 앞에 글자를 붙여 주세요. 예) /매수 A1 B2';
        (g[sidOf(r)] = g[sidOf(r)] || []).push(it.n);
      }
      Object.entries(g).forEach(([sid, nums]) => jobs.push([sid, { kind: 'buy', nums: [...new Set(nums)] }]));
    }
    const out = [];
    for (const [sid, job] of jobs) { const r = await approveRun(date, sid, job, min); out.push(jobs.length > 1 || runs.length > 1 ? `[${labelOf(sid)}]\n${r}` : r); }
    return out.join('\n\n');
  }

  /* 승인 마감 넘긴 알림은 '만료'로 기록 */
  async function expireIfNeeded(date, sid) {
    let expired = false;
    const { I } = await intraOf(sid);
    await mutateRun(date, sid, run => { if (run.status === 'noticed' && !run.payload.decision) { run.status = 'expired'; run.payload.decision = { kind: 'expired', at: new Date().toISOString() }; expired = true; } state.runs[sid] = run; });
    if (expired) await tgFor(sid)(`⌛ ${ST.hhmm(I.T.deadline)} 승인 마감 — 오늘 자동매매 후보는 매수하지 않고 기록만 남겼어요.`);
  }

  const activeOrders = run => Object.values((run && run.payload && run.payload.orders) || {}).some(v => v.st === 'intent' || v.st === 'open' || v.st === 'modified');

  /* 주기 호출: 서버 타이머(30초)와 외부 깨우기(/trigger-auto) 둘 다 이걸 부른다. "아직 안 했으면 지금 한다"로 보완.
     시간 창(전략 설정): 08:00~09:00 전날 전환 보완 · 09:00~15:20 아침 분할 매도 · 09:00~15:30 매수 주문 관리 · 전략별 선정~마감+30분
              판정~답 마감 · 답 마감~15:30 무응답 처리 · 전환 시각~ */
  async function tick() {
    const { date, min } = kstParts();
    const W = (a, b) => min >= a && min < b;
    const A = await actives();
    const T0 = (A.Is[0] && A.Is[0].T) || ST.timesOf(DEFP, A.C.params);   // 판정·전환·분할은 종가 전략 기준이라 모두 같음
    const selNow = A.Is.filter(I => W(I.T.sel, I.T.selEnd));
    const hasPaper = !!D.paper;
    const inOrd = hasPaper && W(540, 930), inEodJ = hasPaper && W(T0.judge, T0.reply), inEodT = hasPaper && W(T0.reply, 930);
    const inJr = min >= JR_AT || W(JR_FIN, 930), inConv = hasPaper && min >= T0.convert, inPre = hasPaper && W(480, 540), inMorn = hasPaper && W(540, 920);
    if (!selNow.length && !inJr && !inOrd && !inEodJ && !inEodT && !inConv && !inPre && !inMorn) return { ok: true, idle: 'outside-window' };
    if (!isTradingDay(date)) return { ok: true, idle: 'non-trading' };
    const out = {};
    const err = e => { state.lastErr = e.message; return { ok: false, err: e.message }; };
    if (state.date !== date) { state.date = date; state.runs = {}; state.runsAt = 0; state.checkedAt = {}; }
    if (Date.now() - state.runsAt > 60000) {   // 오늘 기록(전략별)을 1분에 한 번 새로 읽음(재시작 직후 이어받기 포함)
      state.runsAt = Date.now();
      const rs = await readRuns(date).catch(() => null);
      if (rs) rs.forEach(r => { state.runs[sidOf(r)] = r; });
    }
    state.multi = A.Is.length > 1 || Object.keys(state.runs).length > 1;
    const runs = () => Object.values(state.runs);
    // 전날 전환을 못 했으면(서버가 전환 시각에 잠들어 있었음) 아침에 보완 — 아침 매도보다 먼저
    if (state.prevConvChecked && state.prevConvChecked !== date) state.prevConvChecked = null;
    if ((inPre || inMorn) && D.prevTradingDay && !state.prevConvChecked) {
      const prev = D.prevTradingDay(date);
      const prs = prev ? await readRuns(prev).catch(() => null) : null;
      let ok = !!prs;
      for (const pr of prs || []) if (!pr.payload.carryDone) { const c = await eodFor(sidOf(pr)).convert(prev).catch(err); (out.conv = out.conv || []).push(c); if (!c.ok) ok = false; }
      if (ok) state.prevConvChecked = date;
    }
    if (inMorn) {
      if (!state.carry || Date.now() - (state.carryAt || 0) > 60000) { state.carry = await readCarry().catch(() => state.carry); state.carryAt = Date.now(); }
      const pend = Object.values((state.carry && state.carry.items) || {}).some(i => i.from < date && i.state !== 'done');
      if (pend) out.morning = await eodAny.morning(date, min).catch(err);
    }
    for (const r of runs()) {
      const sid = sidOf(r), E = r.payload.eod;
      if (inOrd && activeOrders(r)) (out.follow = out.follow || {})[sid] = await execFor(sid).follow(date).catch(err);
      if (inEodJ && !(E && E.at)) (out.judge = out.judge || {})[sid] = await eodFor(sid).judge(date).catch(err);
      if (inEodT && E && !E.decision) (out.timeout = out.timeout || {})[sid] = await eodFor(sid).timeout(date).catch(err);
      if (inConv && !r.payload.carryDone) (out.convert = out.convert || {})[sid] = await eodFor(sid).convert(date).catch(err);
    }
    out.exc = await excTick(date, min).catch(err);
    if (inJr) out.journal = await JR.tick(date, min, T0.convert).catch(err);   // 일지는 자동매매를 껐어도 지난 기록을 정리한다
    if (!selNow.length) return { ok: true, date, min, ...out };
    if (!(await masterOn())) return { ok: true, date, min, idle: 'disabled', ...out };
    for (const I of selNow) {
      const r = state.runs[I.id], o = {};
      if (r && r.payload && r.payload.noticeSent) {
        if (I.params.approval === 'auto' && r.status === 'noticed' && min <= I.T.deadline) o.auto = await autoApprove(I.id).catch(err);   // 알림 직후 끊겼던 경우 보완
        else if (min > I.T.deadline && r.status === 'noticed') await expireIfNeeded(date, I.id).catch(e => { state.lastErr = e.message; });
        o.idle = 'done';
      } else if (r || !(state.checkedAt[I.id] && Date.now() - state.checkedAt[I.id] < 25000)) {   // 재호출 방지는 아직 기록이 없을 때만
        state.checkedAt[I.id] = Date.now();
        o.sel = await runSelectionFor(I, false).catch(err);
        if (o.sel && o.sel.ok) state.runs[I.id] = await readRun(date, I.id).catch(() => state.runs[I.id]) || state.runs[I.id];
        state.multi = A.Is.length > 1 || Object.keys(state.runs).length > 1;
        if (min >= I.T.notice && o.sel && o.sel.ok) {
          o.notice = await sendNoticeFor(I.id, false).catch(err);
          if (o.notice && o.notice.sent && I.params.approval === 'auto') o.auto = await autoApprove(I.id).catch(err);
        }
      } else o.idle = 'busy';
      (out.s = out.s || {})[I.id] = o;
    }
    const one = out.s && A.Is.length === 1 ? out.s[A.Is[0].id] : null;   // 전략 하나일 때 예전 응답 모양 유지
    return { ok: true, date, min, ...out, ...(one || {}) };
  }

  /* 승인 방식 '자동': 그 전략의 알림 후보 전체를 승인한 것으로 처리(가상매매) */
  async function autoApprove(sid) {
    const { date, min } = kstParts();
    const msg = await approveRun(date, sid, { kind: 'all' }, min);
    if (msg) await tgFor(sid)('🤖 자동 승인\n' + msg);
    return { ok: true };
  }

  /* /정리 A1 B2 · /정리 1(정리 대기 전략이 하나일 때) · /정리 전체 · /유지 */
  async function handleEod(text, onlySid) {
    if (!D.paper) return null;
    const { date, min } = kstParts();
    const a = parseCmdMulti(text, 'eod');
    if (!a) return null;
    const runs = (await readRuns(date).catch(() => [])).filter(r => (!onlySid || sidOf(r) === onlySid) && r.payload.eod && (r.payload.eod.weak || []).length);
    runs.forEach(r => { state.runs[sidOf(r)] = r; });
    if (!runs.length) return '지금 정리할지 물어본 종목이 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 예) /정리 1${runs.length > 1 ? ' · 전략이 여럿이면 /정리 A1 B2' : ''}`;
    const pend = runs.filter(r => !r.payload.eod.decision);
    const jobs = [];
    if (a.kind === 'keep' || a.kind === 'all') (pend.length ? pend : runs).forEach(r => jobs.push([sidOf(r), a.kind === 'keep' ? '/유지' : '/정리 전체']));
    else {
      const g = {};
      for (const it of a.items) {
        const r = it.letter ? runs.find(x => (x.payload.letter || 'A') === it.letter) : (pend.length === 1 ? pend[0] : runs.length === 1 ? runs[0] : null);
        if (!r) return it.letter ? `${it.letter} 전략은 정리할 종목이 없어요.` : '전략이 여럿이에요. 번호 앞에 글자를 붙여 주세요. 예) /정리 A1';
        (g[sidOf(r)] = g[sidOf(r)] || []).push(it.n);
      }
      Object.entries(g).forEach(([sid, nums]) => jobs.push([sid, '/정리 ' + [...new Set(nums)].join(' ')]));
    }
    const out = [];
    for (const [sid, cmd] of jobs) { const r = await eodFor(sid).handleCmd(date, cmd, min); out.push(jobs.length > 1 || runs.length > 1 ? `[${labelOf(sid)}]\n${r}` : r); }
    return out.join('\n\n');
  }

  function status() {
    const runs = Object.values(state.runs);
    const r = runs[0], o = (r && r.payload && r.payload.orders) || {};
    return { date: state.date, run: r && { status: r.status, picks: ((r.payload || {}).picks || []).length, orders: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.st])) },
      runs: runs.map(x => ({ sid: sidOf(x), letter: x.payload.letter, status: x.status, picks: (x.payload.picks || []).length })), lastErr: state.lastErr };
  }
  /* ── 사이트 카드용 조회·설정 ── */
  const UI = require('./auto-ui');
  async function setConfig(body) {
    const c = UI.checkConfig(body);
    if (c.err) return { ok: false, status: 400, error: c.err };
    const { I } = await pair();
    if (c.val.perStockKrw !== undefined && !store.isMissing()) {   // 종목당 금액은 장중 전략 조건값(버전 기록)
      const r = await store.save(I.id, { params: { perStockKrw: c.val.perStockKrw } }, 'site');
      if (!r.ok) return r;
    }
    return lock(async () => {
      const r = await D.sbGet('auto_config?select=value&key=eq.main&limit=1');
      const cur = (r[0] && r[0].value) || {};
      const next = { ...cur, ...c.val };
      await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'main', value: next, updated_at: new Date().toISOString() }]);
      return { ok: true, cfg: { on: !!next.on, perStockKrw: await perStock() }, changed: c.val };
    });
  }
  async function uiState() {
    const { date } = kstParts();
    const [cfgRows, todayRows, carry, rows, A] = await Promise.all([
      D.sbGet('auto_config?select=value&key=eq.main&limit=1').catch(() => []),
      readRuns(date).catch(() => []),
      readCarry().catch(() => ({ items: {} })),
      D.sbGet('auto_runs?select=trade_date,strategy_id,status,payload&order=trade_date.desc&limit=30').catch(() => []),
      actives(),
    ]);
    const cv = (cfgRows[0] && cfgRows[0].value) || {};
    const regime = await regimeOf(date).catch(() => null);
    const runs = rows.map(r => UI.summarizeRun(r, false));
    let realized = {}, closes = {};
    if (runs.length) {
      const oldest = runs[runs.length - 1].date;
      const sells = await D.sbGet(`paper_fills?select=code,ts,realized&side=eq.sell&ts=gte.${encodeURIComponent(oldest + 'T00:00:00+09:00')}&order=ts.asc&limit=5000`).catch(() => []);
      realized = UI.attributeRealized(runs, sells);
      const past = runs.filter(r => r.date < date && r.shadow.length);
      const codes = [...new Set(past.flatMap(r => r.shadow.map(s => s.code)))];
      if (past.length && codes.length) {
        const cl = await D.sbGet(`daily_price?select=code,trade_date,close&trade_date=in.(${[...new Set(past.map(r => r.date))].join(',')})&code=in.(${codes.join(',')})&limit=5000`).catch(() => []);
        cl.forEach(x => { (closes[x.trade_date] = closes[x.trade_date] || {})[x.code] = +x.close; });
      }
    }
    const hist = UI.buildHistory(runs, realized, closes, date);
    const todays = todayRows.map(r => UI.summarizeRun(r, true));
    // 오늘 자동매매 종목·종가 베팅으로 넘긴 종목의 현재 보유 상태(어느 전략 종목인지 함께)
    const owner = {};
    todays.forEach(t => t.orders.filter(o => o.filled > 0).forEach(o => { owner[o.code] = t.strategy ? t.strategy.name : t.sid; }));
    const carryItems = Object.values((carry && carry.items) || {}).filter(i => i.state !== 'done');
    let positions = [];
    try {
      const ps = D.paper && D.paper.state ? await D.paper.state() : null;
      const watch = new Set([...Object.keys(owner), ...carryItems.map(i => i.code)]);
      if (ps && ps.ok) positions = ps.positions.filter(p => watch.has(p.code)).map(p => ({ code: p.code, name: p.name, qty: p.qty, avg: p.avg, last: p.last, stop: p.stop, strategy: owner[p.code] || null }));
    } catch (_) {}
    const events = EV.marketNotes(await EV.loadEvents(D.sbGet, date, 0, 4), date, 3);
    let exposure = null;
    try { const ex = await exposureNow(); if (ex) { const caps = A.Is.map(i => +i.params.totalCapKrw || 0).filter(v => v > 0); exposure = { ...ex, rows: undefined, cap: caps.length ? Math.min(...caps) : 0 }; } } catch (_) {}
    const ci = carryItems.map(i => ({ code: i.code, name: i.name, q0: i.q0, avg: i.avg, from: i.from, sold: i.sold || 0, state: i.state, sid: i.sid || null }));
    return {
      ok: true, now: Date.now(), date, tradingDay: isTradingDay(date),
      cfg: { on: !!cv.on, perStockKrw: await perStock() }, limits: { min: UI.PER_MIN, max: UI.PER_MAX, step: UI.PER_STEP },
      today: todays[0] || null, todays, active: A.Is.map(i => i.id), regime, exposure, events, positions, carry: ci, history: hist.rows, totals: hist.totals, lastErr: state.lastErr || null,
    };
  }
  /* 사이트에서 승인·정리(텔레그램 명령과 같은 처리, 전략 지정). 결과는 텔레그램에도 남김 */
  async function siteApprove(kind, nums, sid) {
    const text = kind === 'pass' ? '/패스' : `/매수 ${nums.join(' ')}`;
    const r = await handleApproval(text, sid || null);
    if (r) await D.sendTelegram(`🖥 사이트에서 ${sid ? `[${labelOf(sid)}] ` : ''}${kind === 'pass' ? '패스' : '매수 ' + nums.join(',')} 선택\n${r}`).catch(() => {});
    return { ok: !!r, reply: r || '처리할 수 없는 요청입니다.' };
  }
  async function siteEod(kind, nums, sid) {
    const text = kind === 'keep' ? '/유지' : `/정리 ${nums.join(' ')}`;
    const r = await handleEod(text, sid || null);
    if (r) await D.sendTelegram(`🖥 사이트에서 ${sid ? `[${labelOf(sid)}] ` : ''}${kind === 'keep' ? '유지' : '정리 ' + nums.join(',')} 선택\n${r}`).catch(() => {});
    return { ok: !!r, reply: r || '처리할 수 없는 요청입니다.' };
  }

  /* 전략 조회·저장·추가·삭제(컨트롤 타워) */
  async function strategies() {
    const [list, A] = await Promise.all([store.list(true), actives()]);
    const timesBy = Object.fromEntries(A.Is.map(I => [I.id, I.T]));
    const T0 = (A.Is[0] && A.Is[0].T) || ST.timesOf(DEFP, A.C.params);
    return { ok: true, missing: store.isMissing(), schema: ST.publicSchema(), strategies: list, active: { intraday: A.Is.map(i => i.id), closing: A.C.id, letters: Object.fromEntries(A.Is.map(I => [I.id, I.letter])) }, times: T0, timesBy };
  }
  const saveStrategy = (id, patch, who) => store.save(String(id || ''), patch, who);
  const strategyVersions = async id => ({ ok: true, versions: await store.versions(String(id || '')) });
  const createStrategy = (body, who) => (store.create ? store.create(body || {}, who) : { ok: false, status: 503, error: '지원하지 않음' });
  /* 삭제(보관): 오늘 미체결 주문이 있거나 아직 팔지 않은 이월 종목이 있으면 막음 */
  async function deleteStrategy(id, who) {
    const { date } = kstParts();
    const r = await readRun(date, id).catch(() => null);
    if (r && activeOrders(r)) return { ok: false, status: 400, error: '오늘 미체결 주문이 있어 삭제할 수 없습니다' };
    const c = await readCarry().catch(() => ({ items: {} }));
    if (Object.values(c.items || {}).some(i => i.sid === id && i.state !== 'done')) return { ok: false, status: 400, error: '아직 팔지 않은 이월 종목이 있어 삭제할 수 없습니다' };
    return store.archive ? store.archive(id, who) : { ok: false, status: 503, error: '지원하지 않음' };
  }
  return { tick, runSelection, sendNotice, handleApproval, handleEod, status, uiState, setConfig, strategies, saveStrategy, strategyVersions, createStrategy, deleteStrategy, siteApprove, siteEod,
    journalList: q => JR.list(q), journalGet: (d, sid) => JR.get(d, sid), journalMemo: (d, sid, t) => JR.memo(d, sid, t), journalRun: d => JR.run(d, kstParts().date), journal: JR,
    _select: select, _mutateRun: mutateRun, _readRun: readRun, _readRuns: readRuns, _readCarry: readCarry, _exec: exec };
}

module.exports = { regimeMult, regimeLine, REGIME_KO, RULES, EXCL_NAME, baseFilter, evalFlow, scoreOne, rankAndPick, formatMessage, parseApproval, parseCmdMulti, createAuto };
