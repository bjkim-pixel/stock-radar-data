'use strict';
/* 자동매매 1~2단계(2026-11-15) — 후보 선정·점수·텔레그램 알림·그림자 기록(1단계) + 승인 → 가상 매수·손절·5분할 익절(2단계, auto-exec.js).
   기획안 4·5장 그대로:
   · 대상 = 실시간 종목 기본 조건(시총 1조↑ · 종가>60일선>120일선 · 스마트머니 매집 CONT/STALL)
     + 당일 잠정 수급에서 외국인·기관·프로그램 모두 순매수 + 체결강도 100%↑ + 당일 상승 + 시가 대비 +8% 이하
   · 점수(100): 수급 강도 40 · 체결강도 15 · 상승률 구간 15 · 거래대금 15 · 추세 15 → 상위 10개를 추리고 상위 5개를 10:15에 알림
   · 업종당 2종목까지(같은 업종 3번째부터 제외)
   · 승인하지 않은 후보도 auto_runs 에 남겨(그림자 기록) 점수와 내 판단을 나중에 비교한다 */

const ST = require('./auto-strategy'), XE = require('./auto-exec'), IG = require('./ignite'), PB = require('./pullback'), INV = require('./inverse');
const DEFP = Object.freeze(ST.defaults('intraday'));   // 기본 장중 전략 조건값(= 1~3단계 확정값). 함수 인자를 안 주면 이 값
const EXCL_NAME = /스팩|ETN|KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|SOL |ACE |RISE |PLUS |TIMEFOLIO|WON |BNK |마이티|히어로즈|인버스|레버리지|선물/;
const RULES = Object.freeze({
  capMinEok: 10000,          // 시총 1조(억원)
  amtMinEok: 100,            // 거래대금 하한 100억원(실시간 종목 조건)
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
    if (P.maAbove120) { if (!(m120 > 0 && close > m120)) continue; }
    else if (P.maTrend && !(m60 > 0 && m120 > 0 && close > m60 && m60 > m120)) continue;
    const st = (smx && smx[r.code]) || null;
    if (P.smx !== 'off' && !(st === 'CONT' || (P.smx === 'cont_stall' && st === 'STALL'))) continue;
    if (!(r.price > 0) || !(r.changePct > 0)) continue;
    if ((+P.amtMinEok || 0) > 0 && !(r.amt >= P.amtMinEok * 1e8)) continue;   // 거래대금 하한(억원) — 사이트 실시간 종목의 거래대금 조건과 같은 기준
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
  if (!P.noCttr) { if (cs == null) fails.push('체결강도 없음'); else if (cs < P.cttrMin) fails.push(`체결강도 ${cs.toFixed(0)}%`); }   // noCttr: 종가베팅 저녁 선정(애프터마켓)은 체결강도를 보지 않음
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
  const sKw = (W.kw || 0) * (c.kw8 == null ? 0.5 : clamp((1 - c.kw8) / 0.3, 0, 1));   // 개인 계좌수가 8월보다 줄수록 높음: 70% 이하 만점, 100% 이상 0점, 자료 없으면 절반
  const parts = { flow: sFlow, cttr: sCs, rise: sRise, amt: sAmt, trend: sTrend, kw: sKw };
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

/* 하루 최대 매수 종목 수에 세는 주문: 체결됐거나 진행 중인 것만(미체결 취소·재확인 탈락·주문 거부는 세지 않음) */
const countsAsBuy = o => !!o && ((o.filled || 0) > 0 || ['intent', 'open', 'modified', 'filled', 'partial_done'].includes(o.st));
const isOrdered = o => !!o && o.st !== 'retry';
const RETRY_WHY = o => o.st === 'cancelled' ? '미체결로 취소' : o.st === 'skipped' ? `재확인 탈락(${o.why || '조건 미달'})` : `주문 실패(${o.why || '거부'})`;

function formatMessage(date, picks, ctx = {}) {
  const head = ctx.cb ? `🌙 종가베팅 후보(NXT 저녁 매수) · ${date} ${ctx.timeText || ''}`.trim() : `📈 자동매매 후보${ctx.round > 1 ? ` ${ctx.round}회차` : ''} · ${date} ${ctx.timeText || ''}`.trim();
  if (ctx.restDay) return `${head}\n\n오늘은 쉬는 날로 판단했어요.\n사유: ${ctx.restDay}`;
  if (!picks.length) return `${head}\n\n조건을 모두 통과한 종목이 없어요. 오늘은 후보 없음.${ctx.note ? '\n' + ctx.note : ''}`;
  const lines = [head, ''];
  picks.forEach((c, i) => {
    const m = c.m, s = c.score;
    lines.push(`${c.num || (i + 1 + (ctx.startNum || 0))}. ${c.name}(${c.code}) ${s.total}점${c.retry ? ' 🔁 재시도' : ''}`);
    if (c.retry && c.retryWhy) lines.push(`   지난번: ${c.retryWhy}`);
    if (c.inv) lines.push(`   ${fmtN(c.price)}원 ${c.changePct >= 0 ? '+' : ''}${(+c.changePct || 0).toFixed(2)}% · ${c.inv.modeKo} · 손절 −${c.inv.stopPct}%${c.inv.tag === 'A' ? ' 종가 마감' : ''}`);
    else if (c.pb) lines.push(`   ${fmtN(c.price)}원 ${c.changePct >= 0 ? '+' : ''}${(+c.changePct || 0).toFixed(2)}% · ${c.pb.barDate.slice(5)} 기준봉 ${c.pb.refKind === 'vwap' ? '평균가' : '시가'} ${fmtN(Math.round(c.pb.ref || c.pb.vw))}원 대비 ${c.pb.gapPct >= 0 ? '+' : ''}${c.pb.gapPct.toFixed(1)}% 돌파 · 손절 ${fmtN(Math.floor(c.pb.stopPx))}원 아래 종가 마감`);
    else lines.push(ctx.cb ? `   종가 ${fmtN(c.price)}원 ${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}% · 고가 대비 ${c.dd != null ? c.dd.toFixed(1) + '%' : '–'}${s.penalty ? ` (감점 −${s.penalty})` : ''}` : `   ${fmtN(c.price)}원 ${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}% (시가대비 ${c.open > 0 ? ((c.price / c.open - 1) * 100).toFixed(1) : '–'}%) · 체결강도 ${m.cttr.toFixed(0)}%`);
    if (!c.pb && !c.inv) lines.push(`   순매수 외 ${won(m.fAmt)} · 기 ${won(m.oAmt)} · 프 ${won(m.pAmt)} (거래대금 대비 ${(s.ratio * 100).toFixed(1)}%)`);
    lines.push(`   ${c.sector} · ${(c.reasons || []).join(' · ')}`);
    if (c.warns && c.warns.length) lines.push(`   ⚠ ${c.warns.join(' · ')}`);
  });
  if (ctx.warn) lines.push('', `⚠ ${ctx.warn}`);
  if (ctx.regime) lines.push(ctx.warn ? ctx.regime : '\n' + ctx.regime);
  if (ctx.events) lines.push(ctx.regime || ctx.warn || ctx.exposure ? ctx.events : '\n' + ctx.events);
  if (ctx.exposure) lines.push(ctx.regime || ctx.warn ? ctx.exposure : '\n' + ctx.exposure);
  if (ctx.cb) lines.push('', 'ℹ NXT 애프터마켓 지정가로 사고, 손절 −5%만 걸어 다음 날 아침 분할 매도합니다(익절 없음).');
  if (ctx.auto) lines.push('', '🤖 자동 매수 설정 — 알림 직후 위 후보를 모두 가상 매수합니다.');
  else lines.push('', `답장: /매수 ${ctx.nums && ctx.nums.length ? ctx.nums.slice(0, 2).join(' ') : ctx.startNum ? `${ctx.startNum + 1} ${ctx.startNum + 2}` : '1 3 5'} (번호) · /매수 전체 · /패스`, `${ctx.deadline || '10:30'}까지 답이 없으면 전부 취소돼요. (자동으로 사지 않습니다)`);
  return lines.join('\n');
}

function reasonsFor(c, P = DEFP) {
  const allReq = P.flowForeign === 'req' && P.flowInst === 'req' && P.flowProgram === 'req';
  const pos = [['외', c.m.fAmt], ['기', c.m.oAmt], ['프', c.m.pAmt]].filter(([, v]) => v > 0).map(([k]) => k);
  const r = [allReq ? `수급 외·기·프 동시` : pos.length ? `순매수 ${pos.join('·')}` : '수급 조건 없음'];
  if (c.smx) r.push(`매집 ${c.smx === 'CONT' ? '지속' : '고점 후 정체'}(${(ST.ENUM.smxWin[P.smxWin] || ST.ENUM.smxWin['126'])})`);
  if (c.m.cttr >= 120) r.push(`체결강도 강함`);
  if (c.kw8 != null) r.push(c.kwHigh ? `⚠ 개인 계좌 ${Math.round(c.kw8 * 100)}% (8월 대비) — 승인해야 매수` : `개인 계좌 ${Math.round(c.kw8 * 100)}% (8월 대비)`);
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
  /* 글자를 붙이면 그 전략만: "/패스 B" · "/유지 B" · "/매수 B 전체" (실전매매 전략은 글자가 있어야 처리 — 2026-11-19 섞임 방지) */
  const L = x => (x ? { letter: x.toUpperCase() } : {});
  let k;
  if (verb === 'buy' && (k = /^\/?(?:패스|pass|skip)(?:\s+([A-Za-z]))?\s*$/i.exec(t))) return { kind: 'pass', ...L(k[1]) };
  if (verb === 'eod' && (k = /^\/?유지(?:\s+([A-Za-z]))?\s*$/.exec(t))) return { kind: 'keep', ...L(k[1]) };
  if ((k = new RegExp(`^\\/?${V}\\s+(?:([A-Za-z])\\s*)?(?:전체|all)\\s*$`, 'i').exec(t))) return { kind: 'all', ...L(k[1]) };
  const m = t.match(new RegExp(`^\\/?${V}\\s+([A-Za-z\\d\\s,]+)$`, 'i'));
  if (m) {
    const items = [];
    for (const tok of m[1].split(/[\s,]+/).filter(Boolean)) {
      const x = /^([A-Za-z])?(\d{1,2})$/.exec(tok);
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
  const RISK = require('./auto-risk'), EV = require('./auto-events'), EXC = require('./auto-excursion'), PERF = require('./auto-perf'), LOG = require('./auto-log');
  const JR_AT = require('./auto-journal').JOURNAL_AT, JR_FIN = require('./auto-journal').FINISH_AT;
  /* 매매 엔진 연결부(실거래 전환 1단계, broker.js): 전략마다 가상/실전 엔진을 고른다. 실행 모드 설정(D.modeOf)은 2단계 — 없으면 전부 가상(지금과 같음) */
  /* 2단계: 전략별 실행 모드(paper·dryrun·live) 캐시 — 엔진이 손절 직전(아침 보류) 같은 순간에도 바로 물어볼 수 있게 동기로 둔다.
     전략 목록을 읽을 때마다 갱신(시작 직후 한 번, actives·intraOf·저장 때). 모르는 전략은 가상 */
  const MODES = {};
  const noteMode = r => { if (r && r.id && r.params) MODES[r.id] = r.params.execMode || 'paper'; };   // 2026-11-19: 종가베팅도 자기 실행 모드(장중과 따로)
  const modeOfSid = sid => (D.modeOf ? D.modeOf(sid) : (MODES[sid] || 'paper'));
  const BR = require('./broker').createBroker({ paper: D.paper || null, dry: D.dry || null, live: D.live || null, modeOf: modeOfSid,
    kinds: () => (D.kindsInUse ? D.kindsInUse() : [...new Set(Object.values(MODES).map(m => (m === 'live' ? 'live' : m === 'dryrun' ? 'dry' : null)).filter(Boolean))]) });
  /* 실전매매 자동매매(2026-11-19): 쪽 = 가상매매(paper 장부) · 실전매매(dry·live). 켜기/끄기 스위치·화면·일지가 쪽별 */
  const sideOfSid = sid => BR.sideOf(sid);
  const kindsOfSide = side => (side === 'real' ? ['dry', 'live'] : ['paper']);
  /* 그날 기록(auto_runs)이 어느 장부로 주문했는지: 선정 때 남긴 engine. 예전 기록은 주문의 mode(live)로 추정, 없으면 가상 */
  const engineOfRun = r => { const P = (r && r.payload) || {}; if (P.engine) return P.engine; return Object.values(P.orders || {}).some(o => o && o.mode === 'live') ? 'live' : 'paper'; };
  const sideOfRun = r => (engineOfRun(r) === 'paper' ? 'paper' : 'real');
  const kindOfCarry = i => i.kind || BR.modeOf(i.sid || DEF_SID);
  const SZ = require('./auto-size');
  const HAS = BR.has;   // 예전 "D.paper 가 있으면" 검사 자리(엔진이 하나라도 있으면)
  const ALL = { state: () => BR.stateAll() };   // 전략을 가리지 않는 조회(화면·일지·노출액): 쓰이는 엔진 전부를 합친 보기

  const kstParts = () => D.kstNow();            // { date:'YYYY-MM-DD', min: 분 }
  const store = D.strategies || ST.createStore({ sbGet: D.sbGet, sbWrite: D.sbWrite, now: D.now || Date.now });   // 전략(조건값). 테이블이 없으면 기본 전략
  const CDEF = ST.defaults('closing');
  const fallback = () => {
    const I = { id: DEF_SID, name: '기본', version: 1, enabled: true, params: DEFP, letter: 'A', T: ST.timesOf(DEFP, CDEF) };
    return { Is: [I], C: { id: 'closing-default', version: 1, enabled: true, params: CDEF } };
  };
  /* 2026-11-19 종가베팅 독립: 종가 전략을 장중 전략처럼 다루는 실행 단위(자기 기록·장부·조건·글자 N). 장중에만 있는 값(선정 시각 등)은 기본값 */
  const IDEF = ST.defaults('intraday');
  const closingAsI = C => { const params = { ...IDEF, ...((C && C.params) || {}) }; return { ...C, kind: 'closing', params, letter: ST.CLOSE_LETTER, T: ST.timesOf(params, (C && C.params) || CDEF) }; };
  const isClosingSid = sid => /^closing/.test(String(sid || ''));
  const isClosingRun = r => !!(r && ((r.payload && r.payload.kind === 'closing') || isClosingSid(r.strategy_id || (r.payload && r.payload.strategy && r.payload.strategy.id))));
  let modesAll = !store.list;   // 검토 #15: 전략 전체(꺼진·보관 포함)의 실행 모드를 한 번은 읽어야 이월·정리를 맞는 엔진으로 처리
  let migrated = null;   // 종가 전략 독립 저장은 서버마다 한 번만(동시에 두 번 돌지 않게)
  const loadModes = () => (migrated = migrated || (store.migrateClosing ? store.migrateClosing().catch(e => { migrated = null; console.warn('[전략] 종가 전략 독립 저장 실패:', e && e.message); }) : Promise.resolve()))
    .then(() => store.list()).then(L => { (L || []).forEach(noteMode); modesAll = true; });
  if (store.list) loadModes().catch(() => {});   // 시작 직후 모드 캐시
  const actives = async () => {
    let A;
    if (store.actives) A = await store.actives().catch(fallback);
    else { const P = await store.pair().catch(() => null); A = P ? { Is: P.I.enabled ? [{ ...P.I, letter: 'A', T: P.T }] : [], C: P.C } : fallback(); }   // 테스트용 단순 저장소(pair 만 있음)
    (A.Is || []).forEach(noteMode); noteMode(A.C);
    return { ...A, CI: closingAsI(A.C) };
  };
  /* 전략 id → 조건값(보관·삭제된 전략의 지난 기록도 처리할 수 있게 목록 전체에서 찾고, 없으면 기본값) */
  async function intraOf(sid) {
    const A = await actives();
    const a = A.Is.find(i => i.id === sid);
    if (a) return { I: a, C: A.C };
    if (A.C && A.C.id === sid) return { I: A.CI, C: A.C };   // 종가 전략 = 자기 조건으로 움직이는 실행 단위
    const r = store.byId ? await store.byId(sid).catch(() => null) : null;
    noteMode(r);
    if (r && r.kind === 'closing') return { I: closingAsI(r), C: r };   // 꺼진·보관된 종가 전략의 지난 기록(이월 매도 등)
    if (!r && isClosingSid(sid)) { const C0 = { id: sid, name: sid, version: 1, enabled: false, params: CDEF }; return { I: closingAsI(C0), C: C0 }; }
    const I = r && r.kind === 'intraday' ? r : { id: sid, name: sid, version: 1, enabled: false, params: DEFP };
    return { I: { ...I, T: ST.timesOf(I.params, A.C.params) }, C: A.C };
  }
  const pair = async () => { const A = await actives(); const I = A.Is[0] || (await intraOf(DEF_SID)).I; return { I, C: A.C, T: I.T }; };
  const isTradingDay = date => D.isTradingDay(date);

  /* 켜기/끄기: 가상매매 = main.on · 실전매매(드라이런·실전) = main.liveOn(켤 때 PIN). 못 읽으면 꺼짐으로 */
  async function masterOn(side = 'paper') {
    if (D.forceEnabled != null) return !!D.forceEnabled;
    try { const r = await D.sbGet('auto_config?select=key,value&key=eq.main&limit=1'); const v = (r[0] && r[0].value) || {}; return side === 'real' ? !!v.liveOn : !!v.on; } catch (_) { return false; }
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
  /* 매집·이탈 진단(smx_state)을 전략이 고른 기간(1개월 '21' · 3개월 '63' · 6개월 '126' · 전체 'all')으로 읽는다. 값이 없거나 이상하면 6개월 */
  const smxWinOf = P => (P && ST.ENUM && ST.ENUM.smxWin && ST.ENUM.smxWin[P.smxWin] ? String(P.smxWin) : '126');
  async function loadSmx(win = '126') {
    const map = {};
    for (let off = 0; off < 20000; off += 1000) {
      const part = await D.sbGet(`smx_state?select=code,st&win=eq.${win}&st=in.(CONT,STALL)&order=code.asc&limit=1000&offset=${off}`);
      part.forEach(r => { map[r.code] = r.st; });
      if (part.length < 1000) break;
    }
    return map;
  }
  /* 키움증권 회원 보유 계좌수(개인 물량): 최근 ÷ 8월 첫 기록. 웹 '매집 8월 %'와 같은 계산 — 30분 캐시, 못 읽으면 빈 값(조건 없이 진행) */
  let kwCache = { at: 0, map: {} };
  async function loadKw() {
    if (Date.now() - kwCache.at < 30 * 60e3) return kwCache.map;
    const rows = [];
    try {
      for (let off = 0; off < 6000; off += 1000) {
        const part = await D.sbGet(`v_kiwoom_accounts?select=code,snaps&order=code.asc&limit=1000&offset=${off}`);
        rows.push(...(part || []));
        if (!part || part.length < 1000) break;
      }
    } catch (_) { return kwCache.map; }
    const ds = new Set(); rows.forEach(r => Object.keys(r.snaps || {}).forEach(d => ds.add(d)));
    const dates = [...ds].sort(), last = dates[dates.length - 1];
    const aug = dates.filter(d => +d.slice(5, 7) === 8), yr = aug.length ? aug[aug.length - 1].slice(0, 4) : null;   // 가장 최근 8월의 첫 기록
    const d8 = yr ? aug.find(d => d.slice(0, 4) === yr) : null, map = {};
    if (d8) rows.forEach(r => { const sn = r.snaps || {}, cur = sn[last]; if (cur > 0 && sn[d8] > 0) map[r.code] = cur / sn[d8]; });
    kwCache = { at: Date.now(), map };
    return map;
  }
  async function loadHeld(sid) {   // 매매 엔진(가상·실전)에서 이미 보유·주문 중인 종목은 후보에서 제외. 실전 계좌는 직접 산 종목도 여기에 들어가 자동으로 빠진다
    if (sid) {   // 2단계: 전략마다 자기 엔진 기준(가상 전략과 그 실전 복제가 같은 종목을 각자 살 수 있게). 실전·드라이런은 실제 계좌 보유도 포함, 확인 못 하면 선정 중단
      const b = BR.of(sid);
      try { return await b.held(); } catch (e) { if (b.mode !== 'paper') throw e; return new Set(); }
    }
    try { return await BR.heldAll(); }
    catch (e) { if (BR.kindsInUse().includes('live')) throw e; return new Set(); }   // 실전 보유를 확인하지 못하면 선정을 멈춤(빈 목록으로 보고 사는 일이 없게)
  }

  /* 시장 상태: 코스피 -1% 이하 → 경고(기획안 8장). 지수 조회 실패는 경고 없이 진행 */
  async function marketWarn() {
    try { const w = await D.marketState(); return w || null; } catch (_) { return null; }
  }

  /* NXT 거래 가능 종목만(stocks.nxt_ok). 조회에 실패하면 안전하게 모두 제외 */
  async function nxtOnly(list) {
    if (!list.length) return list;
    let rows = [];
    try { rows = await D.sbGet(`stocks?select=code,nxt_ok&code=in.(${list.map(c => c.code).join(',')})&limit=${list.length + 5}`); } catch (_) { return []; }
    const ok = new Set((rows || []).filter(r => r && r.nxt_ok).map(r => r.code));
    return list.filter(c => ok.has(c.code));
  }
  /* X(종가베팅 저녁 선정 전용): { nxtOnly, skip:Set(이미 후보·주문한 종목), closeHigh:{maxPct, from, max} } — 종가가 당일 고가에서 maxPct 이내만, from% 넘게 내렸으면 점수 감점 */
  async function select(P = DEFP, X = null, sid = null) {
    if (P.selector === 'inverse' && !X) return selectInverse(P, sid);   // 인버스·사이드카(A·B·C)
    if (P.selector === 'pullback' && !X) return selectPullback(P, sid);   // 눌림목(무게 1·2위일 평균가 회복)
    if (P.selector === 'ignite' && !X) return selectIgnite(P, sid);   // 장초 상승 포착(시동) 전략은 자기 방식으로 고름
    const useKw = !X && P.kwOn !== false && P.weights !== undefined;   // 장중 전략만(종가베팅 저녁 선정은 해당 없음)
    const [scr, smx, held, pool, kwMap] = await Promise.all([loadScreener(P), loadSmx(smxWinOf(P)), loadHeld(sid || (X && X.sid) || null), D.livePool(P.capMinEok), useKw ? loadKw().catch(() => ({})) : {}]);
    let base = baseFilter(pool, scr.map, smx, held, P).sort((a, b) => b.changePct - a.changePct);
    if (X && X.skip) base = base.filter(c => !X.skip.has(c.code));
    if (useKw) { const lim = (+P.kwMax || 100) / 100; base.forEach(c => { const r = kwMap[c.code]; if (r != null) { c.kw8 = r; c.kwHigh = r >= lim; } }); }   // 8월 대비 개인 계좌수 — 상한 이상이면 탈락이 아니라 '승인 필요' 후보
    const nBase0 = base.length;
    if (X && X.nxtOnly) base = await nxtOnly(base);
    const stat = { pool: (pool || []).length, base: base.length, flowPass: 0, errs: 0, ...(X && X.nxtOnly ? { nxtOut: nBase0 - base.length } : {}) };
    const passed = [], rejected = [], altPool = [];
    for (const c of base.slice(0, 40)) {
      const [flow, power, cttr] = await Promise.all([D.fetchFlow(c.code), D.fetchPower(c.code), D.fetchCttr(c.code)]);
      const ev = evalFlow(c, flow, power, cttr, P);
      if (ev.fails.some(f => /없음/.test(f))) stat.errs++;
      if (!ev.pass) {
        c.fails = ev.fails; c.m = ev.m; rejected.push({ code: c.code, name: c.name, changePct: c.changePct, fails: ev.fails });
        // 대체 후보: 외국인·기관 순매도 때문에만 떨어졌고, 둘의 순매수 합계가 기준(억원) 이상이면 후보로 보관
        const sumFO = ev.m.fAmt != null && ev.m.oAmt != null ? ev.m.fAmt + ev.m.oAmt : null;
        if (P.altFlowOn !== false && !(X && X.nxtOnly) && ev.fails.length && ev.fails.every(f => f === '외국인 순매도' || f === '기관 순매도') && sumFO != null && sumFO >= (+P.altFlowMinEok || 1) * 1e8) { c.altSum = sumFO; altPool.push(c); }
        continue;
      }
      c.m = ev.m; stat.flowPass++; passed.push(c);
    }
    const byAmt = passed.slice().sort((a, b) => a.amt - b.amt);
    passed.forEach(c => { c.score = scoreOne(c, c.m, byAmt.length > 1 ? byAmt.indexOf(c) / (byAmt.length - 1) : 1, P); c.reasons = reasonsFor(c, P); });
    if (X && X.closeHigh) {
      const { maxPct, from, max } = X.closeHigh; stat.highOut = 0;
      for (const c of passed.slice()) {
        const dd = c.high > 0 && c.price > 0 ? (c.price / c.high - 1) * 100 : null;
        c.dd = dd;
        if (dd != null && dd < -maxPct) {
          passed.splice(passed.indexOf(c), 1); stat.flowPass--; stat.highOut++;
          rejected.push({ code: c.code, name: c.name, changePct: c.changePct, fails: [`종가가 고가 대비 ${dd.toFixed(1)}% (한도 −${maxPct}%)`] });
        } else if (dd != null && dd < -from) {
          const pen = Math.round(max * Math.min(1, (-dd - from) / Math.max(0.1, maxPct - from)) * 10) / 10;
          c.score.penalty = pen; c.score.total = Math.max(0, Math.round((c.score.total - pen) * 10) / 10);
          c.reasons = c.reasons.concat([`고가 대비 ${dd.toFixed(1)}% (감점 −${pen})`]);
        } else if (dd != null) c.reasons = c.reasons.concat([`고가 대비 ${dd.toFixed(1)}%`]);
      }
    }
    if (X && X.hist && X.hist.n > 0 && X.hist.max > 0) {   // 종가베팅 관찰 회차 통과 이력: 통과 횟수/관찰 횟수 × 최대 가점
      passed.forEach(c => {
        const k = X.hist.cnt[c.code] || 0, b = Math.round(X.hist.max * k / X.hist.n * 10) / 10;
        c.hist = { k, n: X.hist.n };
        if (b > 0) { c.score.bonus = b; c.score.total = Math.round((c.score.total + b) * 10) / 10; }
        c.reasons = c.reasons.concat([`관찰 ${X.hist.n}회 중 ${k}회 통과${b > 0 ? ` (가점 +${b})` : ''}`]);
      });
    }
    const { pick, dropped } = rankAndPick(passed, P.poolTop, P.sectorMax);
    let alt = [];
    if (altPool.length) {
      const byA = altPool.slice().sort((x, y) => x.amt - y.amt);
      altPool.forEach(c => { c.score = scoreOne(c, c.m, byA.length > 1 ? byA.indexOf(c) / (byA.length - 1) : 1, P); c.reasons = [`⚠ 대체 조건: 외국인+기관 합계 ${won(c.altSum)}`].concat(reasonsFor(c, { ...P, flowForeign: 'bonus' }).slice(1)); c.alt = true; });
      alt = rankAndPick(altPool, P.poolTop, P.sectorMax).pick;
    }
    stat.altN = alt.length;
    return { picks: pick, dropped, stat, scrDate: scr.date, passedAll: passed, rejected, alt };
  }

  /* 장초 상승 포착(시동, 2026-11-25): 서버 추적기(D.ignitePool)가 1분마다 쌓은 시세 이력으로 "시가부터 뜬 종목"이 아니라 "09시 이후 거래가 붙으며 오르기 시작하는 종목"을 고른다.
     1차 = 이력 기반 조건(ignite.js evaluate, 보조 조건은 VWAP·고가 근처만) → 통과 상위 12개만 체결강도·프로그램을 조회해 2차 판정 → 점수 순으로 상위 N */
  async function selectIgnite(P, sid) {
    const { min } = kstParts();
    const [held, scr, pool] = await Promise.all([loadHeld(sid), loadScreener(P).catch(() => ({ date: null, map: {} })), D.ignitePool ? D.ignitePool(P) : Promise.resolve({ rows: [], get: () => [] })]);
    const stat = { pool: pool.rows.length, base: 0, flowPass: 0, errs: 0, ignite: true, scanAt: pool.scanAt || null, scanErr: pool.scanErr || null, hist: pool.size || 0 };
    const rejected = [], cand = [];
    for (const r of pool.rows) {
      if (!r || !r.code || EXCL_NAME.test(r.name || '') || (held && held.has(r.code)) || !(r.price > 0)) continue;
      if ((+P.amtMinEok || 0) > 0 && !(r.amt >= P.amtMinEok * 1e8)) continue;
      const ev = IG.evaluate(r, pool.get(r.code), { ...P, optMin: 0 }, min);
      if (ev.pass) cand.push({ r, ev }); else if (ev.fails.length && rejected.length < 400) rejected.push({ code: r.code, name: r.name, changePct: r.changePct, fails: ev.fails, amt: r.amt });
    }
    stat.base = cand.length;
    cand.sort((a, b) => (b.ev.m.amtRatio || 0) - (a.ev.m.amtRatio || 0));
    const passed = [];
    for (const { r, ev } of cand.slice(0, 12)) {
      const [power, cttr] = await Promise.all([D.fetchPower(r.code), D.fetchCttr(r.code)]);
      const cs = cttr && cttr.err == null ? num(cttr.cttr) : null, pq = power && power.err == null ? num(power.pgQty) : null;
      if (cs == null && pq == null) stat.errs++;
      const ev2 = IG.evaluate(r, pool.get(r.code), P, min, { cttr: cs, pgQty: pq });
      if (!ev2.pass) { rejected.push({ code: r.code, name: r.name, changePct: r.changePct, fails: ev2.fails }); continue; }
      const s0 = scr.map[r.code], c = { ...r, sector: (s0 && s0.sector) || `미분류-${r.code}`, rs20: s0 ? num(s0.rs20_pctl) : null, smx: null,
        m: { fq: null, oq: null, pq, cttr: cs, fAmt: null, oAmt: null, pAmt: pq != null ? pq * r.price : null, w52: null }, ig: ev2.m };
      c.score = IG.score(ev2.m, P); c.reasons = IG.reasons(ev2.m, P);
      if (ev2.partial) c.warns = ['장 초반 이력이 일부 없어 판단이 덜 정확해요(서버 재시작 직후 등)'];
      passed.push(c); stat.flowPass++;
    }
    const { pick, dropped } = rankAndPick(passed, P.poolTop, P.sectorMax);
    rejected.sort((a, b) => (b.amt || 0) - (a.amt || 0));
    return { picks: pick, dropped, stat, scrDate: scr.date, passedAll: passed, rejected: rejected.slice(0, 20).map(({ amt, ...x }) => x), alt: [] };
  }

  /* 눌림목(2026-11-26 규칙 교체 2): "최근 3개월 기준봉(양봉·종가 상단·큰 거래대금·큰 무게) 중 무게 큰 2개 → 기준봉 시가 아래로 빠진 뒤 → 스마트머니 1·3개월이 안 빠졌으면 → 기준가를 +1% 이상 돌파할 때 매수".
     일봉(daily_price)·smx_state 로 관찰 목록(무장 상태)을 만들어 30분 캐시 → 관찰 종목의 현재가로 오늘 돌파 여부를 판정 */
  const pb = { at: 0, key: '', data: null };
  async function pbPages(path, max = 40) {
    const out = [];
    for (let off = 0; off < max * 1000; off += 1000) {
      const part = await D.sbGet(`${path}&limit=1000&offset=${off}`);
      out.push(...(part || []));
      if (!part || part.length < 1000) break;
    }
    return out;
  }
  const pbOpts = P => ({ wMin: +P.pbWMin || 0.5, capMinEok: +P.capMinEok || 1000, maxAge: +P.pbMaxAge || 63, dipPct: P.pbDipPct == null ? 0 : +P.pbDipPct, breakPct: P.pbBreakPct == null ? 1 : +P.pbBreakPct, chasePct: +P.pbChasePct || 6,
    bodyPct: P.pbBodyPct == null ? 10 : +P.pbBodyPct, closePos: P.pbClosePos == null ? 70 : +P.pbClosePos, barAmtEok: +P.pbBarAmtEok || 500, barAmtX: +P.pbBarAmtX || 4, ref: P.pbRef === 'vwap' ? 'vwap' : 'open' });
  async function loadPbWatch(P, date) {
    const o = pbOpts(P), key = `${date}|${JSON.stringify(o)}`;
    if (pb.data && pb.key === key && Date.now() - pb.at < 30 * 60e3) return pb.data;
    const last = await D.sbGet('daily_price?select=trade_date&order=trade_date.desc&limit=1');
    const lastD = last && last[0] && last[0].trade_date;
    const prevD = D.prevTradingDay ? D.prevTradingDay(date) : null;
    const res = { lastD, prevD, stale: !!(prevD && lastD && lastD < prevD), watch: [], bars: 0 };
    if (res.stale) { pb.data = res; pb.key = key; pb.at = Date.now(); return res; }
    const cutAt = days => { const x = new Date(`${date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - days); return x.toISOString().slice(0, 10); };
    const endD = prevD || lastD, cutD = cutAt(Math.ceil(o.maxAge * 7 / 5) + 4), histD = cutAt(Math.ceil((o.maxAge + 25) * 7 / 5) + 6);
    // 1) 후보 종목: 최근 3개월 안에 무게·거래대금이 큰 날이 있는 종목  2) 그 종목들의 일봉 이력으로 기준봉 모양·20일 평균 거래대금 배수를 판정
    const heavy = await pbPages(`daily_price?select=code&weight_per_share=gte.${o.wMin}&trade_amount=gte.${o.barAmtEok * 1e8}&market_cap=gte.${o.capMinEok * 1e8}&trade_date=gte.${cutD}&trade_date=lte.${endD}&order=code.asc`, 10);
    const codes = [...new Set(heavy.map(r => r.code))];
    res.bars = codes.length;
    const px = new Map(), sm = new Map(), names = new Map();
    const dow = d => new Date(`${d}T00:00:00Z`).getUTCDay();
    for (let i = 0; i < codes.length; i += 40) {
      const cs = codes.slice(i, i + 40).join(',');
      for (const r of await pbPages(`daily_price?select=code,trade_date,open,high,low,close,volume,trade_amount,weight_per_share,market_cap&code=in.(${cs})&trade_date=gte.${histD}&trade_date=lte.${endD}&order=code.asc,trade_date.asc`, 12)) {
        const d = String(r.trade_date).slice(0, 10); if (dow(d) === 0 || dow(d) === 6) continue;   // 일요일 같은 휴장일 중복 행은 버린다
        let a = px.get(r.code); if (!a) px.set(r.code, a = []);
        if (a.length && a[a.length - 1].d === d) a.pop();
        a.push({ d, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume, a: +r.trade_amount, w: +r.weight_per_share || 0, mc: +r.market_cap || 0 });
      }
      for (const r of await D.sbGet(`smx_state?select=code,win,st,lead_nm,lead_trend&code=in.(${cs})&win=in.(21,63)&limit=500`).catch(() => []) || []) { let a = sm.get(r.code); if (!a) sm.set(r.code, a = []); a.push(r); }
    }
    for (let i = 0; i < codes.length; i += 100) for (const r of await D.sbGet(`stocks?select=code,name,security_type&code=in.(${codes.slice(i, i + 100).join(',')})&limit=200`).catch(() => []) || []) names.set(r.code, r);
    for (const code of codes) {
      const nm = names.get(code); if (!nm || nm.security_type !== 'STOCK') continue;
      const hist = px.get(code) || [];
      if (!hist.length || hist[hist.length - 1].mc < o.capMinEok * 1e8) continue;
      const gate = PB.smGate(sm.get(code));
      for (const L of PB.levelsOf(hist, o)) {
        const st = PB.levelState(hist.slice(L.i).map(x => ({ d: x.d, c: x.c })), L.ref, o);
        if (!st || !st.ok) continue;
        res.watch.push({ code, name: nm.name || code, barDate: L.d, rk: L.rk, w: L.w, chg: L.chg, body: L.body, pos: L.pos, amtEok: L.a / 1e8, mcEok: hist[hist.length - 1].mc / 1e8, ref: L.ref, refKind: o.ref, age: st.age, dipDate: st.dipDate, minGapPct: st.minGapPct, sm: gate });
      }
    }
    pb.data = res; pb.key = key; pb.at = Date.now();
    return res;
  }
  /* 한 종목에 기준봉이 둘 다 눌림 상태면, 오늘 돌파 구간에 든 것 중 기준가에 가장 가까운 것 하나(없으면 기준가에 가장 가까운 것) */
  function pbPickPerCode(rows, gapOf, inBand) {
    const by = new Map();
    for (const w of rows) { const g = gapOf(w); if (g == null) { if (!by.has(w.code)) by.set(w.code, w); continue; } const cur = by.get(w.code), cg = cur && gapOf(cur);
      const rank = x => (inBand(x) ? 0 : 1) * 1e6 + Math.abs(gapOf(x)); if (!cur || cg == null || rank(w) < rank(cur)) by.set(w.code, w); }
    return [...by.values()];
  }
  async function selectPullback(P, sid) {
    const { date } = kstParts();
    const [held, scr] = await Promise.all([loadHeld(sid), loadScreener(P).catch(() => ({ date: null, map: {} }))]);
    const stat = { pool: 0, base: 0, flowPass: 0, errs: 0, pullback: true, scanAt: null, scanErr: null };
    const W = await loadPbWatch(P, date);
    stat.pool = W.bars; stat.base = W.watch.length; stat.hist = W.watch.length;
    if (W.stale) { stat.scanErr = `일봉이 ${W.lastD}까지만 있어요(어제 ${W.prevD} 자료가 아직 없음) — 오늘 눌림목 선정은 건너뜁니다`; return { picks: [], dropped: [], stat, scrDate: scr.date, passedAll: [], rejected: [], alt: [] }; }
    const codes = [...new Set(W.watch.map(w => w.code))];
    const qs = codes.length ? await D.pbQuotes(codes).catch(e => { stat.scanErr = e.message; return []; }) : [];
    stat.scanAt = new Date().toISOString();
    const qm = new Map(qs.map(q => [q.code, q])), o = { breakPct: P.pbBreakPct == null ? 1 : +P.pbBreakPct, chasePct: +P.pbChasePct || 6 };
    const passed = [], rejected = [];
    const watch = pbPickPerCode(W.watch, w => { const q = qm.get(w.code); return q ? (q.price / w.ref - 1) * 100 : null; }, w => PB.todayBreak(w.ref, qm.get(w.code), o));
    for (const w of watch) {
      const q = qm.get(w.code);
      if (!q) { stat.errs++; continue; }
      if (EXCL_NAME.test(q.name || w.name || '') || (held && held.has(w.code))) continue;
      const gapPct = (q.price / w.ref - 1) * 100, fails = [], kind = w.refKind === 'vwap' ? '평균가' : '시가';
      if (!PB.todayBreak(w.ref, q, o)) { if (Math.abs(gapPct) < 12) rejected.push({ code: w.code, name: w.name, changePct: q.changePct, fails: [`${w.barDate.slice(5)} 기준봉 ${kind} ${Math.round(w.ref).toLocaleString('ko-KR')}원 대비 ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}% (${gapPct < o.breakPct ? '아직 못 되찾음' : '이미 많이 올라 쫓지 않음'}: +${o.breakPct}%~+${o.chasePct}% 돌파 구간만)`] }); continue; }
      if (P.pbSmGate !== false && !w.sm.ok) fails.push(...w.sm.fails);
      if ((+P.capMaxEok || 0) > 0 && w.mcEok >= P.capMaxEok) fails.push(`시총 ${Math.round(w.mcEok).toLocaleString('ko-KR')}억 (상한 ${P.capMaxEok}억)`);
      if ((+P.amtMinEok || 0) > 0 && !(q.amt >= P.amtMinEok * 1e8)) fails.push(`거래대금 ${Math.round(q.amt / 1e8)}억 (하한 ${P.amtMinEok}억)`);
      if (fails.length) { rejected.push({ code: w.code, name: w.name, changePct: q.changePct, fails }); continue; }
      const sig = { barDate: w.barDate, rk: w.rk, w: w.w, chg: w.chg, body: w.body, pos: w.pos, amtEok: w.amtEok, ref: w.ref, refKind: w.refKind, gapPct, dipDate: w.dipDate, sm: w.sm.info, mcEok: w.mcEok, age: w.age };
      const s0 = scr.map[w.code], c = { code: w.code, name: q.name || w.name, price: q.price, open: q.open, high: q.high, low: q.low, changePct: q.changePct, vol: q.vol, amt: q.amt,
        sector: (s0 && s0.sector) || `미분류-${w.code}`, rs20: s0 ? num(s0.rs20_pctl) : null, smx: null, m: { fq: null, oq: null, pq: null, cttr: null, fAmt: null, oAmt: null, pAmt: null, w52: null },
        pb: { ref: w.ref, vw: w.ref, refKind: w.refKind, stopPx: q.price * (1 - (+P.pbStopBelowPct || 5) / 100), barDate: w.barDate, rk: w.rk, age: w.age, gapPct } };
      c.score = PB.score(sig); c.reasons = PB.reasons(sig);
      passed.push(c); stat.flowPass++;
    }
    const { pick, dropped } = rankAndPick(passed, P.poolTop, P.sectorMax);
    rejected.sort((a, b) => Math.abs(a.changePct || 0) - Math.abs(b.changePct || 0));
    return { picks: pick, dropped, stat, scrDate: scr.date, passedAll: passed, rejected: rejected.slice(0, 20), alt: [] };
  }
  /* ── 인버스·사이드카(A·B·C, 2026-11-26) ── */
  const INV_MODE_KO = { regime: 'A 하락 국면 보유', flow: 'B 외국인 현물·선물 동반 순매도', sidecar: 'C 매도 사이드카 반등' };
  async function etfPrevCloses(code, n, date) {   // 어제까지 종가(오름차순) — 오늘 행이 있으면 뺀다
    const rows = await D.sbGet(`etf_daily?select=trade_date,close&code=eq.${code}&trade_date=lt.${date}&order=trade_date.desc&limit=${n + 5}`).catch(() => []);
    return (rows || []).map(r => +r.close).filter(x => x > 0).reverse();
  }
  async function selectInverse(P, sid) {
    const { date } = kstParts(), mode = P.invMode || 'regime', code = P.invCode || '114800', stopPct = +P.stopPct || INV.stopDefault(mode, code);
    const held = await loadHeld(sid).catch(() => null);
    const stat = { pool: 0, base: 1, flowPass: 0, errs: 0, inverse: true, mode, scanAt: null, scanErr: null };
    const done = (picks, rejected) => ({ picks, dropped: [], stat, scrDate: date, passedAll: picks, rejected: rejected || [], alt: [] });
    const rej = (q, why) => done([], [{ code, name: (q && q.name) || INV.productName(code), changePct: q ? q.changePct : null, fails: [why] }]);
    const rc = INV.DEF.regimeCode, qs = await D.pbQuotes([...new Set([code, rc])]).catch(e => { stat.scanErr = e.message; return []; });
    stat.scanAt = new Date().toISOString();
    const qm = new Map(qs.map(q => [q.code, q])), q = qm.get(code), k = qm.get(rc);
    if (!q || !k) { stat.errs++; return rej(q, '시세 조회 실패'); }
    if (held && held.has(code)) return rej(q, '이미 보유 중');
    const n = +P.invMaDays || INV.DEF.maDays;
    let sig = {}, tag = INV.tagOf(mode, 2), days = 0;
    if (mode === 'regime' || mode === 'sidecar') {
      const rg = INV.regime(await etfPrevCloses(rc, n, date), k.price, n);
      if (!rg.ok) { stat.errs++; return rej(q, `KODEX 200 일봉이 ${n}일 치에 못 미침`); }
      if (mode === 'regime') {
        if (!rg.on) return rej(q, `코스피200 ${n}일선 위(${rg.gapPct >= 0 ? '+' : ''}${rg.gapPct.toFixed(1)}%) — 하락 국면 아님`);
        sig = { price: k.price, ma: rg.ma, gapPct: rg.gapPct, n };
      } else {
        const ev = await D.sbGet(`market_events?select=title&kind=eq.sidecar&event_date=eq.${date}&limit=10`).catch(() => []);
        const sellToday = (ev || []).some(r => /매도/.test(r.title || '') && !/코스닥/.test(r.title || ''));
        const sc = INV.sidecarSignal({ sellToday, chgPct: k.changePct, dropPct: +P.invDropPct || INV.DEF.dropPct });
        if (!sc.on) return rej(q, `사이드카 신호 없음(KODEX 200 ${(+k.changePct || 0) >= 0 ? '+' : ''}${(+k.changePct || 0).toFixed(1)}% · 기준 −${+P.invDropPct || INV.DEF.dropPct}%)`);
        days = INV.holdDaysC(rg.on, +P.invHoldDays || INV.DEF.holdDays); tag = INV.tagOf(mode, days);
        sig = { via: sc.via, chgPct: +k.changePct || 0, dropPct: +P.invDropPct || INV.DEF.dropPct, days };
      }
    } else {   // flow(B): 어제 외국인 코스피 현물·선물 동반 순매도 — 자료가 어제 것이 아니면 건너뜀
      const prev = D.prevTradingDay ? D.prevTradingDay(date) : null;
      const [s1, f1] = await Promise.all([
        D.sbGet('market_investor_detail?select=trade_date,foreign_net&market=eq.KOSPI&order=trade_date.desc&limit=1').catch(() => []),
        D.sbGet('market_investor_daily?select=trade_date,foreign_net&market=eq.FUT&order=trade_date.desc&limit=1').catch(() => [])]);
      const sr = s1 && s1[0], fr = f1 && f1[0];
      if (!sr || !fr || (prev && (String(sr.trade_date) < prev || String(fr.trade_date) < prev))) { stat.scanErr = `외국인 수급 자료가 어제(${prev}) 것이 아니에요(현물 ${sr ? sr.trade_date : '없음'} · 선물 ${fr ? fr.trade_date : '없음'}) — 건너뜁니다`; return rej(q, '수급 자료 지연'); }
      const fs = INV.flowSignal(sr.foreign_net, fr.foreign_net);
      if (!fs.on) return rej(q, `어제 외국인 현물 ${Math.round(fs.spot)}억 · 선물 ${Math.round(fs.fut)}억 — 동반 순매도 아님`);
      sig = { spot: fs.spot, fut: fs.fut };
    }
    stat.flowPass = 1;
    const inv = { mode, modeKo: INV_MODE_KO[mode], tag, stopPct, days, ...sig };
    const c = { code, name: q.name || INV.productName(code), price: q.price, open: q.open, high: q.high, low: q.low, changePct: q.changePct, vol: q.vol, amt: q.amt, sector: 'ETF', rs20: null, smx: null,
      m: { fq: null, oq: null, pq: null, cttr: null, fAmt: null, oAmt: null, pAmt: null, w52: null }, score: { total: 100, parts: {}, ratio: 0 }, reasons: INV.reasons(mode, sig), inv };
    return done([c]);
  }
  /* 인버스·사이드카 정리(A·C): 15:15~15:20 — A 는 코스피200 이 60일선 위로 올라왔으면, C 는 보유 거래일이 찼으면 이 전략의 꼬리표(plan.tag)가 붙은 종목을 전량 시장가 매도. B 는 당일 청산(flatOn)이 맡는다 */
  async function invExitFor(I, date) {
    state.iexit = state.iexit || {};
    const k = `${date}|${I.id}`, f = state.iexit[k] = state.iexit[k] || { done: false, tries: 0 };
    if (f.done || f.tries >= 6 || (f.at && Date.now() - f.at < 25000)) return { ok: true, skipped: true };
    f.at = Date.now(); f.tries++;
    const mode = I.params.invMode, b = BR.of(I.id), S = await b.state();
    if (!S || !S.ok) return { ok: false, err: '매매 상태를 읽지 못했어요' };
    const mine = (S.positions || []).filter(p => p.qty > 0 && p.plan && p.plan.tag && (mode === 'regime' ? p.plan.tag === 'A' : INV.tagDays(p.plan.tag) > 0));
    if (!mine.length) { f.done = true; return { ok: true, none: true }; }
    let due = mine, why = '';
    if (mode === 'regime') {
      const n = +I.params.invMaDays || INV.DEF.maDays, rc = INV.DEF.regimeCode;
      const [kq] = await D.pbQuotes([rc]).catch(() => []);
      const rg = kq ? INV.regime(await etfPrevCloses(rc, n, date), kq.price, n) : null;
      if (!rg || !rg.ok) return { ok: false, err: 'KODEX 200 시세·일봉을 읽지 못했어요(다시 시도)' };
      if (rg.on) { f.done = true; return { ok: true, hold: true, gapPct: rg.gapPct }; }   // 아직 하락 국면 — 계속 보유
      why = `코스피200이 ${n}일선 위(${rg.gapPct >= 0 ? '+' : ''}${rg.gapPct.toFixed(1)}%)로 올라와 하락 국면 끝`;
    } else {
      due = mine.filter(p => p.openedAt && PB.tradingDaysBetween(new Date(p.openedAt + 9 * 3600e3).toISOString().slice(0, 10), date, D.isTradingDay) >= INV.tagDays(p.plan.tag));
      why = '보유 거래일 만료';
    }
    const res = [];
    for (const p of due) {
      const qty = p.avail > 0 ? p.avail : p.qty;
      const r = await b.place({ code: p.code, name: p.name, side: 'sell', type: 'market', qty, cid: `inv_${I.id}_${p.code}_${date.replace(/-/g, '')}_${f.tries}` }).catch(e => ({ ok: false, error: e.message }));
      res.push({ code: p.code, name: p.name, ok: !!(r && r.ok), qty: r && r.ok ? (r.fills || []).reduce((a, x) => a + x.qty, 0) : 0, err: r && !r.ok ? r.error : null });
    }
    const left = res.filter(x => !x.ok || x.qty < 1).length;
    if (!res.length || !left) f.done = true;
    if (res.length) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'flat', `${INV_MODE_KO[mode]} 정리(${why}): ${res.map(x => `${x.name || x.code} ${x.ok ? x.qty + '주 매도' : '실패(' + x.err + ')'}`).join(', ')}`); state.runs[I.id] = r; }).catch(() => {});
      await tgFor(I.id)(`🧹 [${I.name}] 정리 — ${why}\n` + res.map(x => `· ${x.name || x.code}: ${x.ok ? `${x.qty}주 시장가 매도` : '실패 — ' + x.err}`).join('\n') + (left ? '\n(남은 종목은 30초 뒤 다시 시도)' : '')).catch(() => {});
    }
    return { ok: true, res, done: f.done };
  }
  /* 눌림목 시간 청산(pbHoldDays): 매수 후 N거래일째(0 = 끔) 15:05 이후 이 전략이 들고 있는 종목의 남은 수량 전량 시장가 매도 — 못 판 종목은 30초 뒤 다시, 하루 최대 6번 */
  async function holdExitFor(I, date) {
    state.hexit = state.hexit || {};
    const k = `${date}|${I.id}`, f = state.hexit[k] = state.hexit[k] || { done: false, tries: 0 };
    if (f.done || f.tries >= 6 || (f.at && Date.now() - f.at < 25000)) return { ok: true, skipped: true };
    f.at = Date.now(); f.tries++;
    const b = BR.of(I.id), S = await b.state();
    if (!S || !S.ok) return { ok: false, err: '매매 상태를 읽지 못했어요' };
    const n = +I.params.pbHoldDays || 0, res = [];
    if (!(n > 0)) return { ok: true, skipped: true };
    for (const p of S.positions || []) {
      if (!(p.qty > 0) || !p.openedAt || !(p.plan && p.plan.closeStop) || p.plan.tag) continue;   // 엔진은 전략이 공유하므로 눌림목이 산 종목(종가 마감 손절 계획)만
      const od = new Date(p.openedAt + 9 * 3600e3).toISOString().slice(0, 10);
      if (PB.tradingDaysBetween(od, date, D.isTradingDay) < n) continue;
      const qty = p.avail > 0 ? p.avail : p.qty;
      const r = await b.place({ code: p.code, name: p.name, side: 'sell', type: 'market', qty, cid: `hold_${I.id}_${p.code}_${date.replace(/-/g, '')}_${f.tries}` }).catch(e => ({ ok: false, error: e.message }));
      res.push({ code: p.code, name: p.name, ok: !!(r && r.ok), qty: r && r.ok ? (r.fills || []).reduce((a, x) => a + x.qty, 0) : 0, err: r && !r.ok ? r.error : null, od });
    }
    const left = res.filter(x => !x.ok || x.qty < 1).length;
    if (!res.length || !left) f.done = true;
    if (res.length) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'flat', `${n}거래일 시간 청산: ${res.map(x => `${x.name || x.code} ${x.ok ? x.qty + '주 매도' : '실패(' + x.err + ')'}`).join(', ')}`); state.runs[I.id] = r; }).catch(() => {});
      await tgFor(I.id)(`⏱ [${I.name}] ${n}거래일 시간 청산\n` + res.map(x => `· ${x.name || x.code}(${x.od} 매수): ${x.ok ? `${x.qty}주 시장가 매도` : '실패 — ' + x.err}`).join('\n') + (left ? '\n(남은 종목은 30초 뒤 다시 시도)' : '')).catch(() => {});
    }
    return { ok: true, res, done: f.done };
  }

  /* 장초 상승 포착 전략의 당일 청산(flatOn): flatAt 이후 이 전략이 산 종목의 남은 보유분을 시장가로 전량 매도 — 못 판 종목은 30초 뒤 다시 시도, 하루 최대 6번 */
  async function flattenFor(I, date) {
    state.flat = state.flat || {};
    const k = `${date}|${I.id}`, f = state.flat[k] = state.flat[k] || { done: false, tries: 0, sold: {} };
    if (f.done || f.tries >= 6 || (f.at && Date.now() - f.at < 25000)) return { ok: true, skipped: true };
    f.at = Date.now(); f.tries++;
    const run = state.runs[I.id] || await readRun(date, I.id).catch(() => null);
    const codes = Object.entries((run && run.payload && run.payload.orders) || {}).filter(([, o]) => o && !['skipped', 'failed', 'rejected', 'cancelled'].includes(o.st)).map(([c]) => c);   // 이 전략이 주문한 종목 — 실제로 보유 중인지는 엔진 상태로 판단
    if (!codes.length) { f.done = true; return { ok: true, none: true }; }
    const b = BR.of(I.id), S = await b.state();
    if (!S || !S.ok) return { ok: false, err: '매매 상태를 읽지 못했어요' };
    const pos = new Map((S.positions || []).map(p => [p.code, p]));
    const res = [];
    for (const code of codes) {
      const p = pos.get(code);
      if (!p || !(p.qty > 0)) continue;
      const qty = p.avail > 0 ? p.avail : p.qty;
      const r = await b.place({ code, name: p.name, side: 'sell', type: 'market', qty, cid: `flat_${I.id}_${code}_${date.replace(/-/g, '')}_${f.tries}` }).catch(e => ({ ok: false, error: e.message }));
      res.push({ code, name: p.name, ok: !!(r && r.ok), qty: r && r.ok ? (r.fills || []).reduce((a, x) => a + x.qty, 0) : 0, err: r && !r.ok ? r.error : null });
    }
    const left = res.filter(x => !x.ok || x.qty < 1).length;
    if (!res.length || !left) f.done = true;
    if (res.length) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'flat', `${I.params.flatAt} 당일 청산: ${res.map(x => `${x.name || x.code} ${x.ok ? x.qty + '주 매도' : '실패(' + x.err + ')'}`).join(', ')}`); state.runs[I.id] = r; }).catch(() => {});
      await tgFor(I.id)(`🧹 [${I.name}] ${I.params.flatAt} 당일 청산\n` + res.map(x => `· ${x.name || x.code}: ${x.ok ? `${x.qty}주 시장가 매도` : '실패 — ' + x.err}`).join('\n') + (left ? '\n(남은 종목은 30초 뒤 다시 시도)' : '')).catch(() => {});
    }
    return { ok: true, res, done: f.done };
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
    return { stopPct: p.stopPct, rr: p.rr, minRr: +p.minRr || 0, tpStyle: p.tpStyle || 'even', buyType: p.buyType === 'market' ? 'market' : 'limit', noTape: p.selector === 'pullback' || p.selector === 'inverse', closeStop: p.selector === 'pullback' || (p.selector === 'inverse' && p.invMode === 'regime'), noTp: p.selector === 'inverse', runnerPct: p.runnerPct == null ? 20 : +p.runnerPct, tp1Pct: +p.tp1Pct || 6, tp2Pct: +p.tp2Pct || 9, tp1Share: +p.tp1Share || 50, ratchet: !!p.ratchet, trail: p.trail, split: p.split, minPct: p.minPct, recheckPct: p.recheckPct, openRiseMax: p.openRiseMax, cttrMin: p.cttrMin, buyPick: p.buyPick, smartBuy: p.smartBuy !== false, smartCttr: +p.smartCttr || 120, smartRise: p.smartRise == null ? 2 : +p.smartRise, q1GapPct: +p.q1GapPct || 0.8, chaseAsk: p.chaseAsk !== false, chasePct: +p.chasePct || 1, chaseWaitMs: (+p.chaseWaitMin || 3) * 60e3, rrSlack: p.rrSlack == null ? 10 : +p.rrSlack, intentLostMs: (+p.intentLostSec || 60) * 1e3, fillWaitMs: p.fillWaitMin * 60e3, cancelWaitMs: (p.cancelWaitMin || p.fillWaitMin) * 60e3, repriceTo: p.repriceTo || 'bid1', unfilledEnd: p.unfilledEnd || 'cancel', totalCapKrw: +p.totalCapKrw || 0,
      sizeMode: p.sizeMode || 'fixed', maxOrdersDay: +p.maxOrdersDay || 20, rejectStop: +p.rejectStop || 3, unsureStop: +p.unsureStop || 2 };
  }
  /* 종목당 금액(2단계 C-2): 가상·고정이면 null(지금처럼 perStock). 실전·드라이런은 고정이어도 실제 계좌의 미수 없는 매수 가능 금액·1회 상한 안에서만 */
  async function sizeOne(sid, code, q, opt, cb) {
    const b = BR.of(sid), { I, C } = await intraOf(sid), p = I.params, mode = p.sizeMode || 'fixed';
    if (b.mode === 'paper' && mode === 'fixed') return null;
    const px = (q && q.price) || 0;
    const cash = await b.cash(code, px);                      // 실전: 못 읽으면 예외 → 사지 않음 · 드라이런: 계좌가 없으면 null(가상 기준)
    const fixedKrw = await perStockOf(sid);                   // 시장 상태 조절이 반영된 고정 금액
    const mult = mode === 'balance' ? regimeMult(p, await regimeOf(kstParts().date)) : 1;
    let autoValue = 0, paperUsed = 0;
    if (mode === 'balance') {
      /* 자동매매가 이미 들고 있는 평가액: 이 전략의 장부 기준(실전 = 실제 계좌의 자동매매 몫 · 드라이런 = 드라이런 장부 · 가상 = 가상 장부) */
      const S = await b.state().catch(() => null);
      const pos = ((S && S.positions) || []).filter(x => (b.kind === 'live' ? x.plan && x.plan.own != null : true));
      const codes = b.kind === 'live' ? null : await autoCodes(kstParts().date, [b.kind]);
      for (const x of pos) { if (codes && !codes.has(x.code)) continue; autoValue += x.qty * (x.last > 0 ? x.last : x.avg); paperUsed += x.qty * x.avg; }
    }
    const lim = D.liveLimits ? D.liveLimits() : null;
    const z = SZ.sizeOf({ mode, fixedKrw, cash, autoValue, paperCapital: +p.paperCapitalKrw || 0, paperUsed, pct: +p.sizePct || 0,
      maxBuys: cb ? (+C.params.closeBuyMax || 3) : (+p.maxBuys || 5), mult, capKrw: b.mode !== 'paper' && lim ? +lim.order || 0 : 0, minKrw: +p.minOrderKrw || 100000 });
    return { ...z, mode };
  }
  /* 드라이런: "실전이었다면 냈을 주문"을 실전 기록표(live_events)에 남김(3단계 비교 리포트용) */
  async function dryLog(sid, e) {
    await D.sbWrite('live_events', 'POST', [{ ts: new Date().toISOString(), kind: 'dryrun_order', code: e.code || null, detail: { sid, ...e } }]);
  }
  /* 정지 3단계(C3): ① 'buy' 자동매매 신규 매수만 정지 ② 'all' 자동매매 전체 정지(손절·익절 감시는 엔진이 계속) ③ 긴급 정지(/정지 · trade.js) */
  let haltCache = { at: 0, v: null };
  async function haltLevel() {
    if (Date.now() - haltCache.at < 10000) return haltCache.v;
    try { const r = await D.sbGet('auto_config?select=value&key=eq.halt&limit=1'); haltCache = { at: Date.now(), v: (r[0] && r[0].value && r[0].value.level) || null }; }
    catch (_) { haltCache.at = Date.now(); }
    return haltCache.v;
  }
  async function haltReason() {
    const l = await haltLevel();
    return l === 'buy' ? '자동매매 신규 매수 정지 중(/자동재개 로 풀기)' : l === 'all' ? '자동매매 전체 정지 중(/자동재개 로 풀기)' : null;
  }
  /* 3단계: 일일 대사 불일치로 막힌 실전 전략은 신규 매수만 멈춤(손절·익절·정리는 계속) */
  async function haltReasonFor(sid) {
    const h = await haltReason(); if (h) return h;
    if (BR.execOf(sid) === 'live') {
      /* 사이트 "실전 주문" 스위치가 꺼져 있으면 실전 전략은 신규 매수를 건너뜀(손절·익절·정리는 계속). 드라이런은 가상 장부라 영향 없음 */
      if (D.realOrdersOn && !D.realOrdersOn()) return '사이트 "실전 주문" 스위치가 꺼져 있어 실전 신규 매수를 건너뛰어요(실전매매에서 켜기)';
      if (D.reconBlock) return (await D.reconBlock(sid).catch(() => null)) || null;
    }
    return null;
  }
  async function setHalt(level, via) {
    const v = level === 'buy' || level === 'all' ? level : null;
    await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'halt', value: { level: v, at: new Date().toISOString(), via: via || null }, updated_at: new Date().toISOString() }]);
    haltCache = { at: Date.now(), v };
    return { ok: true, level: v };
  }
  /* 종가베팅 저녁 매수 주문 조건: 손절은 밤새 유지할 값, 익절 없음, 체결강도·시가 대비는 안 봄, 알림가와의 차이는 3%까지 */
  async function cbOpt(sid) { const { C } = await intraOf(sid); return { closing: true, noTp: true, minRr: 0, ratchet: false, stopPct: C.params.overnightStopPct, recheckPct: 3 }; }
  async function eodRule(sid) {
    const { I, C } = await intraOf(sid), c = C.params, T = ST.timesOf(I.params, c);
    return { highNear: 1 - c.highNearPct / 100, idxFloor: c.idxFloor, gapCut: c.gapCut, slices: T.slices, needAboveAvg: c.needAboveAvg, carryFlow: c.carryFlow,
      overnightStopPct: c.overnightStopPct, replyEnd: T.reply, nxtJudgeAt: T.njudge, nxtReplyEnd: T.nreply, convertAt: T.convert, eodWeak: I.params.eodWeak || 'ask', closingOn: isClosingSid(sid) ? true : !!C.enabled,   /* 종가 전략이 이미 산 종목은 전략을 꺼도 이월·아침 매도까지 마무리(익절 없이 손절만 걸린 채 남지 않게) */ holdOn: c.holdOn !== false, holdMode: c.holdMode || 'price', holdGraceMin: +c.holdGraceMin > 0 ? +c.holdGraceMin : 0 };
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
  /* ── 드라이런 점검 기간(2026-11-19): 실행 모드를 드라이런으로 바꾼 날부터 전략이 돈 거래일을 세어, N일(전략 설정 dryDays)이 끝나면 '실전 전환 가능' 알림만 보냄(모드는 그대로 유지) ── */
  const addDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  async function readDry() { const r = await D.sbGet('auto_config?select=value&key=eq.dryrun&limit=1').catch(() => []); const v = (r && r[0] && r[0].value) || {}; v.items = v.items || {}; return v; }
  async function writeDry(c) { await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'dryrun', value: c, updated_at: new Date().toISOString() }]); state.dryCache = {}; }
  function dryStartDate() { let { date, min } = kstParts(); let d = date; for (let i = 0; i < 14 && (min >= 930 || !isTradingDay(d)); i++) { d = addDay(d); min = 0; } return d; }   // 장이 끝났거나 휴장이면 다음 거래일부터 셈
  async function dryProgressOf(sid, since, date, min, total) {
    const rows = await D.sbGet(`auto_runs?select=trade_date&strategy_id=eq.${encodeURIComponent(sid)}&trade_date=gte.${since}&limit=60`).catch(() => []);
    return ST.dryProgress((rows || []).map(r => r.trade_date), date, min, total);
  }
  /* 화면용: 이 전략이 드라이런이면 { since, day, total, done, notified } (1분 캐시) */
  async function dryStatus(sid, params) {
    if (!params || params.execMode !== 'dryrun') return null;
    state.dryCache = state.dryCache || {};
    const c = state.dryCache[sid]; if (c && Date.now() - c.at < 60000) return c.v;
    const dry = await readDry(), it = dry.items[sid] || null, since = it ? it.since : dryStartDate(), { date, min } = kstParts();
    const pg = await dryProgressOf(sid, since, date, min, params.dryDays);
    const v = { since, day: pg.day, total: pg.total, done: pg.done, running: pg.running, notified: !!(it && it.notified) };
    state.dryCache[sid] = { at: Date.now(), v };
    return v;
  }
  /* 실행 모드가 바뀔 때 호출: 드라이런으로 들어가면 시작일 기록, 드라이런에서 나가면 기록 삭제 */
  async function noteDry(sid, from, to) {
    if (from === to) return;
    return lock(async () => {
      const dry = await readDry();
      if (to === 'dryrun') dry.items[sid] = { since: dryStartDate(), at: Date.now() };
      else if (dry.items[sid]) delete dry.items[sid]; else return;
      await writeDry(dry);
    }).catch(e => { state.lastErr = '드라이런 기록 실패: ' + e.message; });
  }
  async function dryTick(date, min) {
    const dry = await readDry(); let ch = false, n = 0;
    for (const sid of Object.keys(MODES)) {
      if (MODES[sid] !== 'dryrun') { if (dry.items[sid]) { delete dry.items[sid]; ch = true; } continue; }
      const st = store.byId ? await store.byId(sid).catch(() => null) : null;
      if (!st || st.archived) continue;
      if (!dry.items[sid]) { dry.items[sid] = { since: dryStartDate(), at: Date.now() }; ch = true; }
      const it = dry.items[sid]; if (it.notified || !st.enabled) continue;
      const pg = await dryProgressOf(sid, it.since, date, min, (st.params || {}).dryDays);
      if (!pg.done) continue;
      it.notified = date; ch = true; n++;
      await D.sendTelegram(`🧪 [${st.name}] 드라이런 ${pg.total}거래일 점검 기간이 끝났어요.\n문제가 없었다면 사이트 › 자동매매 › 전략에서 실행 모드를 실전으로 바꿀 수 있어요(거래 PIN 필요). 드라이런은 지금처럼 계속 돌고 있어요.`).catch(() => {});
    }
    if (ch) await writeDry(dry);
    return { notified: n };
  }
  /* 전략이 여럿이면 텔레그램 메시지 앞에 [A · 이름]을 붙인다(답할 때 번호 앞에 그 글자) */
  const labelOf = sid => { const r = state.runs[sid]; const p = r && r.payload; return p && p.letter ? `${p.letter} · ${(p.strategy && p.strategy.name) || sid}` : sid; };
  const modeTag = sid => ({ live: '🔴실전매매 ', dryrun: '🧪실전 드라이런 ' }[BR.execOf(sid)] || '');
  const paperTag = '📝가상매매 ';   // 전략이 여럿일 때 글자(A·B)만으로는 어느 쪽인지 몰라서, 가상매매 알림에도 맨 앞에 표시
  /* 실전매매(드라이런·실전) 전략 알림은 전략이 하나여도 늘 글자를 붙임 — 글자 없는 명령(/매수 1·/매수 전체·/패스·/유지)은 가상매매만 처리하므로 */
  const lettered = sid => state.multi || sideOfSid(sid) === 'real';
  const realCmds = (sid, t) => { if (sideOfSid(sid) !== 'real') return t; const L = (state.runs[sid] && state.runs[sid].payload.letter) || 'A'; return t.replace('/매수 전체 · /패스', `/매수 ${L} 전체 · /패스 ${L}`).replace('/정리 전체 · /유지', `/정리 ${L} 전체 · /유지 ${L}`); };
  const tgFor = sid => t0 => { const L = state.runs[sid] && state.runs[sid].payload.letter, t = realCmds(sid, t0); return D.sendTelegram(lettered(sid) ? `${modeTag(sid) || (sideOfSid(sid) === 'real' ? '' : paperTag)}[${labelOf(sid)}] ${L ? `— 답할 때 번호 앞에 ${L} (예: ${L}1)` : ''}\n${t}` : modeTag(sid) + t); };   // 실전·드라이런 표시는 늘 맨 앞
  /* E2-1: 자동매매가 들고 있는(또는 주문 중인) 종목의 총 노출·손절 시 손실. 자동매매 종목 = 오늘 모든 전략의 주문 + 아직 안 판 이월 종목 */
  /* kinds: 이 장부들(paper·dry·live)의 자동매매 종목만(없으면 전부) — 같은 종목을 장부마다 따로 보유할 수 있어 노출액을 장부별로 셈 */
  async function autoCodes(date, kinds) {
    const set = new Set(), ok = k => !kinds || kinds.includes(k);
    for (const r of await readRuns(date).catch(() => [])) { if (!ok(engineOfRun(r))) continue; for (const [code, o] of Object.entries((r.payload && r.payload.orders) || {})) if (['intent', 'open', 'modified', 'filled', 'partial_done'].includes(o.st) || o.filled > 0) set.add(code); }
    const c = await readCarry().catch(() => ({ items: {} }));
    Object.values((c && c.items) || {}).filter(i => i.state !== 'done' && ok(kindOfCarry(i))).forEach(i => set.add(i.code));
    return set;
  }
  /* E2-3: 보유 중 최고·최저(MFE·MAE) 기록 — 30초 tick 마다 자동매매 종목의 현재가를 훑음. 저장은 바뀔 때 최대 60초에 한 번 */
  async function excStore() {
    if (state.exc) return state.exc;
    let v = null; try { const r = await D.sbGet('auto_config?select=value&key=eq.excursion&limit=1'); v = r && r[0] && r[0].value; } catch (_) {}
    return (state.exc = v && typeof v === 'object' ? { pos: v.pos || {}, done: v.done || [] } : EXC.fresh());
  }
  /* F1: 자동매매 종목의 매도 체결(손절·익절 n단계·정리)을 그 전략의 진행 기록에 남김. 체결 id 로 중복 방지 */
  async function logSellFills(date, ps) {
    const fills = (ps && ps.fills) || [];
    if (!fills.length) return;
    for (const r of Object.values(state.runs)) {
      const ords = (r.payload && r.payload.orders) || {}, seen = new Set((r.payload && r.payload.loggedFills) || []);
      const kind = BR.modeOf(sidOf(r));   // 이 전략의 엔진 체결만(가상·실전에 같은 종목이 있어도 섞이지 않게)
      const mine = fills.filter(f => f.side === 'sell' && (!f.kind || f.kind === kind) && ords[f.code] && (ords[f.code].filled > 0 || ords[f.code].st === 'filled') && !seen.has(f.id));
      if (!mine.length) continue;
      const sid = sidOf(r), names = {}; (r.payload.picks || []).forEach(p => { names[p.code] = p.name; });
      await mutateRun(date, sid, run => {
        const L = run.payload.loggedFills = Array.isArray(run.payload.loggedFills) ? run.payload.loggedFills : [];
        for (const f of mine.slice().sort((a, b) => a.ts - b.ts)) {
          if (L.includes(f.id)) continue;
          L.push(f.id);
          LOG.push(run.payload, f.reason === 'stop' ? 'stop' : /^tp/.test(f.reason || '') ? 'tp' : 'sell', `${names[f.code] || f.code}: ${LOG.sellReason(f.reason)} ${f.qty.toLocaleString('ko-KR')}주 @ ${Math.round(f.price).toLocaleString('ko-KR')}원${f.realized != null ? ` · 실현 ${f.realized >= 0 ? '+' : ''}${Math.round(f.realized).toLocaleString('ko-KR')}원` : ''}`, { code: f.code }, f.ts);
        }
        if (L.length > 500) L.splice(0, L.length - 500);
        state.runs[sid] = run;
      });
    }
  }
  async function excTick(date, min) {
    if (!HAS || min < 540 || min > 935) return null;
    const ps = await BR.stateAll();
    if (!ps || !ps.ok) return null;                      // 상태를 못 읽었을 때 "다 팔았다"로 오해하지 않도록 건너뜀
    const watch = new Set();
    if (!state.carry || Date.now() - (state.carryAt || 0) > 60000) { state.carry = await readCarry().catch(() => state.carry); state.carryAt = Date.now(); }
    for (const r of Object.values(state.runs)) { const k = engineOfRun(r); for (const [code, o] of Object.entries((r.payload && r.payload.orders) || {})) if (['intent', 'open', 'modified', 'filled', 'partial_done'].includes(o.st) || o.filled > 0) watch.add(EXC.keyOf(code, k)); }
    Object.values((state.carry && state.carry.items) || {}).filter(i => i.state !== 'done').forEach(i => watch.add(EXC.keyOf(i.code, kindOfCarry(i))));   // 기록 키 = 종목@장부(가상은 종목코드만)
    await logSellFills(date, ps).catch(() => {});
    const st = await excStore(), nDone = st.done.length;
    const r = EXC.update(st, ps.positions, watch, date);
    if (r.changed) state.excDirty = true;
    if (state.excDirty && (st.done.length !== nDone || Date.now() - (state.excSavedAt || 0) > 60e3)) {
      state.excSavedAt = Date.now(); state.excDirty = false;
      await D.sbWrite('auto_config?on_conflict=key', 'POST', [{ key: 'excursion', value: st, updated_at: new Date().toISOString() }]).catch(() => { state.excDirty = true; });
    }
    return { n: Object.keys(st.pos).length };
  }
  async function exposureFor(sid) {   // 이 전략이 쓰는 엔진 기준(가상 전략과 실전 전략의 총액 상한을 따로)
    const b = BR.of(sid), ps = await b.state().catch(() => null);
    if (!ps || !ps.ok) return null;
    return RISK.exposureOf(ps, await autoCodes(kstParts().date, [b.kind]));
  }
  /* 쪽 하나(가상매매·실전매매)의 노출. 실전매매는 드라이런·실전 장부를 합친 값(텔레그램 알림·화면) */
  async function exposureNow(side) {
    if (!HAS) return null;
    const ks = side ? kindsOfSide(side).filter(k => BR.engines[k]) : null;
    if (ks && !ks.length) return null;
    const parts = [];
    for (const k of ks || [null]) {
      const ps = k ? await BR.stateOf(k).catch(() => null) : await BR.stateAll();
      if (!ps || !ps.ok) { if (!k || k === 'paper') return null; continue; }
      parts.push(RISK.exposureOf(ps, await autoCodes(kstParts().date, k ? [k] : null)));
    }
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    return parts.reduce((a, x) => { const o = { ...a }; for (const [key, v] of Object.entries(x)) if (typeof v === 'number' && typeof a[key] === 'number') o[key] = a[key] + v; else if (Array.isArray(v) && Array.isArray(a[key])) o[key] = a[key].concat(v); return o; });
  }
  const execs = {}, eods = {};
  const execFor = sid => HAS ? (execs[sid] = execs[sid] || require('./auto-exec').createExec({
    broker: BR.of(sid), getQuote: D.getQuote, loadChart: D.loadChart, sendTelegram: tgFor(sid), now: D.now,
    mutateRun: (d, fn) => mutateRun(d, sid, fn), readRun: d => readRun(d, sid), perStock: () => perStockOf(sid), opt: () => execOpt(sid), optCb: () => cbOpt(sid), exposure: () => exposureFor(sid),
    sizeOne: (code, q, opt, cb) => sizeOne(sid, code, q, opt, cb), halt: () => haltReasonFor(sid), dryLog: e => dryLog(sid, e),
  })) : null;
  /* 아침 보류 때 다시 걸 매도 계획: ① 넘기기 전에 저장해 둔 원래 계획 ② 산 날 주문의 계획 ③ 평균 매수가 기준으로 새로 계산(종가베팅 저녁 매수 종목) */
  async function restorePlan(it, p) {
    const sid = it.sid || DEF_SID, opt = await execOpt(sid);
    const norm = (pl, src) => ({ stopPct: pl.stopPct > 0 ? pl.stopPct : opt.stopPct, steps: (pl.steps || []).map(x => ({ n: x.n, p: x.p, q: x.q, ...(x.runner ? { runner: true } : {}) })), ratchet: pl.ratchet || null, src });
    if (it.plan0 && (it.plan0.steps || []).length) return norm(it.plan0, '원래 계획');
    try {
      const r0 = await readRun(it.from, sid), o = r0 && r0.payload && r0.payload.orders && r0.payload.orders[it.code];
      if (o && o.plan && (o.plan.steps || []).length) return norm(o.plan, '산 날 계획');
    } catch (_) {}
    const [q, rows] = await Promise.all([D.getQuote(it.code).catch(() => null), D.loadChart(it.code).catch(() => [])]);
    const pl = XE.planFromAvg({ q: q || {}, rows, avg: p.avg, qty: p.qty, opt });
    return norm(pl, '새로 계산');
  }
  const intraCodesFor = sid => date => Object.values((state.carry && state.carry.items) || {}).filter(i => i.state === 'intra' && i.holdDate === date && (!i.sid || i.sid === sid)).map(i => i.code);
  /* 이월 종목(어제 종가베팅으로 넘긴 종목)은 09:00 전(NXT 프리마켓)에는 손절·매도하지 않는다 → paper 엔진이 물어봄 */
  let preHoldCache = { at: 0, items: {} };
  const profMemo = new Map();   // code -> {at, prof}
  if (HAS) BR.setPreHold(async (code, min, kind) => {   // 가상·드라이런·실전 엔진 모두에 같은 규칙. 단 이월 종목을 넘긴 전략의 엔진에서만(kind)
    const t = Date.now();
    if (t - preHoldCache.at > 20000) { try { preHoldCache = { at: t, items: (await readCarry()).items || {} }; } catch (_) { preHoldCache.at = t; } }
    const today = kstParts().date;
    /* 같은 종목이 장부마다 따로 넘어올 수 있음 → 이 엔진(kind)으로 넘긴 기록만. 다른 엔진의 같은 종목(예: 실제 계좌 직접 보유)은 보류하지 않음 */
    const i = Object.values(preHoldCache.items || {}).filter(x => x && x.code === code && (!kind || kindOfCarry(x) === kind)).sort((a, b) => (a.state === 'done') - (b.state === 'done'))[0];
    if (!i) return false;
    if (min == null || min < 540) return i.state !== 'done' && i.state !== 'intra' && i.from < today;
    /* 정규장: 아침 보류로 장중 전환한 종목은 설정한 시간(09:00부터 N분) 동안 손절하지 않음 — 시초 흔들기에 털리지 않게 */
    if (i.state !== 'intra' || i.holdDate !== today) return false;
    const g = (await eodRule(i.sid || DEF_SID).catch(() => ({}))).holdGraceMin || 0;
    return g > 0 && min < 540 + g;
  });
  const eodFor = sid => HAS ? (eods[sid] = eods[sid] || require('./auto-eod').createEod({
    broker: BR.of(sid), getQuote: D.getQuote, fetchFlow: D.fetchFlow, marketIdx: D.marketIdx || (async () => ({})), sendTelegram: tgFor(sid), now: D.now,
    mutateRun: (d, fn) => mutateRun(d, sid, fn), readRun: d => readRun(d, sid), mutateCarry, readCarry, rule: () => eodRule(sid), tag: sid, restorePlan, intraCodes: intraCodesFor(sid),
  })) : null;
  const exec = HAS ? execFor(DEF_SID) : null;   // 아래 존재 여부 확인용
  const eodAny = HAS ? require('./auto-eod').createEod({   // 아침 매도: 이월 종목 전체(전략 구분 없음) — 종목마다 넘겨준 전략의 엔진으로 판다
    broker: BR.of(DEF_SID), brokerFor: sid => BR.of(sid || DEF_SID), getQuote: D.getQuote, fetchFlow: D.fetchFlow, marketIdx: D.marketIdx || (async () => ({})), sendTelegram: D.sendTelegram, now: D.now,
    mutateRun: (d, fn) => mutateRun(d, DEF_SID, fn), readRun: d => readRun(d, DEF_SID), mutateCarry, readCarry, rule: async () => eodRule((await actives()).C.id), restorePlan,
  }) : null;

  /* D단계: 전략별 장부 + 자동 일지(15:40 작성 · 전환 뒤 이월 반영 · 다음 거래일 아침 종가베팅 결과로 확정) */
  const JR = require('./auto-journal').createJournal({ sbGet: D.sbGet, sbWrite: D.sbWrite, sendTelegram: D.sendTelegram, now: D.now, paper: ALL, readRuns, readCarry, actives, excursion: excStore, isTradingDay: D.isTradingDay, engineOfRun, kindOfCarry, autoOnlyLive });

  /* 2026-11-16: 오늘 탭 일지 — 20:30 에 오늘 탭 내용을 그대로 하루 한 행으로 저장(복기용) */
  const DL = require('./auto-daylog').createDayLog({ sbGet: D.sbGet, sbWrite: D.sbWrite, now: D.now, isTradingDay: D.isTradingDay, uiState: (d, side) => uiState(d, side), strategies: () => strategies() });

  /* 선정 + 그림자 기록(전략별 하루 한 번 — 오늘 기록이 있으면 건너뜀). force(/자동후보)는 아직 승인·주문 전일 때만 다시 고름 */
  async function runSelectionFor(I, force) {
    const { date } = kstParts();
    const ex = await readRun(date, I.id).catch(() => null);
    if (ex && !force) { state.runs[I.id] = ex; return { ok: true, skipped: true, status: ex.status }; }
    if (ex && force && ((ex.payload && ex.payload.decision) || (ex.payload && ex.payload.orders))) return { ok: false, why: '오늘은 이미 승인·주문을 처리해서 다시 고를 수 없어요' };
    const warn = await marketWarn();
    const regime = await regimeOf(date);
    const sel = await select(I.params, null, I.id);
    const useAlt = !sel.picks.length && I.params.altFlowOn !== false && (sel.alt || []).length > 0;   // 원래 조건 통과 종목이 없으면 외국인+기관 합계로 보충(승인 필요)
    const listP = useAlt ? sel.alt : sel.picks;
    const evs = await EV.loadEvents(D.sbGet, date);
    const shadow = sel.passedAll.map(c => ({
      code: c.code, name: c.name, score: c.score.total, parts: c.score.parts, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector,
      m: c.m, picked: listP.some(p => p.code === c.code),
    }));
    const payload = {
      selectedAt: new Date().toISOString(), engine: BR.modeOf(I.id), stat: sel.stat, scrDate: sel.scrDate, warn: warn || null,
      regime: regime ? { date: regime.date, score: regime.score, stage: regime.stage, mult: regimeMult(I.params, regime), mode: I.params.regimeMode || 'info' } : null,
      strategy: { id: I.id, version: I.version, name: I.name }, params: I.params, letter: I.letter || 'A',
      events: EV.marketNotes(evs, date, 1),
      picks: listP.slice(0, I.params.notifyTop).map(c => ({ ...(c.pb ? { pb: c.pb } : {}), ...(c.inv ? { inv: c.inv } : {}), ...(useAlt ? { alt: true, altSum: Math.round(c.altSum || 0) } : {}), ...(c.kw8 != null ? { kw8: Math.round(c.kw8 * 1000) / 1000, kwHigh: !!c.kwHigh } : {}), code: c.code, name: c.name, score: c.score.total, ratio: c.score.ratio, amt: c.amt, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector, smx: c.smx, reasons: c.reasons, m: c.m, parts: c.score.parts, ev: EV.stockBadges(evs, c.code, date) })),
      shadow, dropped: sel.dropped, rejected: sel.rejected.slice(0, 40), approved: [], decision: null, noticeSent: false,
    };
    const st0 = sel.stat || {};
    LOG.push(payload, 'select', `후보 선정${force ? '(사이트에서 지금 실행)' : ''}: 풀 ${st0.pool ?? '–'} → 기본조건 ${st0.base ?? '–'} → 수급 통과 ${st0.flowPass ?? '–'} → 후보 ${payload.picks.length}개${payload.picks.length ? ' (' + payload.picks.map(p => p.name).join(', ') + ')' : ''}`);
    if (ex && ex.payload && Array.isArray(ex.payload.log)) payload.log = ex.payload.log.concat(payload.log);   // 다시 고른 경우 앞 기록 유지
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
    const exLine = await exposureNow(sideOfSid(sid)).then(e => RISK.exposureLine(e, I.params.totalCapKrw)).catch(() => null);
    await mutateRun(date, sid, run => {
      if (run.payload.noticeSent && !force) return;
      const picks = (run.payload.picks || []).map(p => ({ ...p, score: { total: p.score, ratio: p.ratio || 0 }, warns: p.ev || [] }));
      const rg = run.payload.regime, ps = rg && rg.mult < 1 ? Math.max(10000, Math.floor(I.params.perStockKrw * rg.mult / 10000) * 10000) : null;
      text = formatMessage(date, picks, { timeText: hhmm, warn: run.payload.warn, regime: regimeLine(rg, I.params, ps), exposure: exLine, events: EV.marketLine(run.payload.events), deadline: ST.hhmm(I.T.deadline), auto: I.params.approval === 'auto' && picks.length > 0 && !picks.every(p => p.alt) });
      if (picks.length && picks.every(p => p.alt)) text = text.replace('\n', `\n⚠️ 대체 조건 후보 — 외국인·기관 모두 순매수인 종목이 없어 "외국인+기관 합계 ${I.params.altFlowMinEok || 1}억 이상"으로 골랐어요. 매수하려면 승인하세요. 승인하지 않아도 다음 검토에도 후보면 자동 매수해요.\n`);
      const kwHi = picks.filter(p => p.kwHigh);
      if (kwHi.length) text = text.replace('\n', `\n⚠️ 개인 계좌수가 8월 기준 ${I.params.kwMax || 100}% 이상인 종목(${kwHi.map(p => p.name + ' ' + Math.round(p.kw8 * 100) + '%').join(', ')})은 자동 승인에서 빼요. 사려면 직접 승인하세요.\n`);
      if (lettered(sid) && picks.length) text = text.replace(/\n(\d+)\. /g, `\n${run.payload.letter || 'A'}$1. `).replace('답장: /매수 1 3 5 (번호)', `답장: /매수 ${run.payload.letter || 'A'}1 ${run.payload.letter || 'A'}3 (글자+번호)`);
      run.payload.noticeSent = true; run.payload.noticeAt = new Date().toISOString();
      LOG.push(run.payload, 'notice', `텔레그램 알림 전송 · 후보 ${picks.length}개 · 승인 마감 ${ST.hhmm(I.T.deadline)}${I.params.approval === 'auto' ? ' (자동 승인 설정)' : ''}`);
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
  async function approveRun(date, sid, a, min, opts = {}) {
    const { I } = await intraOf(sid);
    /* 실전매매(드라이런·실전) 스위치를 끈 뒤에는 이미 알림이 간 후보도 사지 않음(끄면 신규 매수가 바로 멈추게) */
    if (a.kind !== 'pass' && sideOfSid(sid) === 'real' && !(await masterOn('real'))) return '실전매매 자동매매가 꺼져 있어 매수하지 않아요. (사이트 실전매매 › 자동매매에서 켜기)';
    if (opts.via === 'auto' && a.kind !== 'pass' && BR.execOf(sid) === 'live' && !I.params.liveAutoOk) {   // 2단계: 실전은 "실전 자동 승인 허용"을 켜기 전까지 직접 승인만(첫 5거래일)
      let first = false;
      await mutateRun(date, sid, run => { if (!run.payload.liveAutoBlocked) { run.payload.liveAutoBlocked = true; first = true; LOG.push(run.payload, 'approve', '실전 전략 — 자동 승인하지 않음(직접 승인 필요)'); } });
      return first ? '실전 전략은 직접 승인해야 매수해요. 알림의 번호로 /매수 하거나 사이트에서 승인하세요. (설정 "실전 자동 승인 허용"을 켜면 자동)' : '';
    }
    const late = !!opts.late;   // 사이트에서 직접 누른 승인: 승인 마감이 지났어도(장 마감 15:20 전까지) 진행 — 만료된 기록도 되살림
    const cur0 = await readRun(date, sid).catch(() => null), dl = Math.max(I.T.deadline, (cur0 && cur0.payload && cur0.payload.roundDeadline) || 0);
    const cbOpen = !!(cur0 && cur0.payload && cur0.payload.cb && (cur0.payload.picks || []).some(p => p.cb && !p.closed));   // 종가베팅 저녁 후보 승인 중이면 19:55 까지
    if (late && (cbOpen ? min >= 1195 : min >= 920)) return cbOpen ? '거래 시간(20:00)이 거의 끝나 새로 매수하지 않아요.' : '장 마감이 가까워(15:20 이후) 새로 매수하지 않아요.';
    if (min > dl && !D.allowLateApproval && !late) return `승인 마감(${ST.hhmm(dl)})이 지났어요. 오늘은 취소 처리돼요.`;
    const res = await mutateRun(date, sid, run => {
      const max = (run.payload.picks || []).length;
      const pk0 = n => run.payload.picks[n - 1], dec0 = run.payload.decision;
      // 자동 승인이 먼저 끝난 뒤, 자동 승인에서 빠진 '개인 계좌수 초과' 후보만 따로 승인하는 경우는 통과
      const kwLate = !!(dec0 && dec0.kind === 'buy' && a.kind === 'buy' && (a.nums || []).length && a.nums.every(n => pk0(n) && pk0(n).kwHigh && !pk0(n).closed && !(run.payload.approved || []).includes(pk0(n).code)));
      if (dec0 && dec0.kind && !kwLate && !(late && dec0.kind === 'expired')) return { dup: dec0 };
      const ords = run.payload.orders || {}, isCb = cbOpen, cap = isCb ? (+(run.payload.cb && run.payload.cb.max) || 3) : (+I.params.maxBuys || 5);
      const cbCodes = new Set((run.payload.picks || []).filter(p => p.cb).map(p => p.code));
      const pk = n => run.payload.picks[n - 1];
      if (a.kind === 'buy' && (a.nums || []).some(n => pk(n) && pk(n).closed)) return { closedNum: (a.nums || []).filter(n => pk(n) && pk(n).closed) };
      let nums = a.kind === 'all' ? Array.from({ length: max }, (_, i) => i + 1).filter(n => !isOrdered(ords[pk(n).code]) && !pk(n).closed && !(opts.via === 'auto' && !opts.paper && (pk(n).kwHigh || pk(n).alt))) : a.nums || [];   // 전체 = 아직 주문하지 않은 이번 회차 후보 전부
      if (a.kind === 'all' && !nums.length) return { nothing: true };
      if (a.kind !== 'pass' && (!nums.length || nums.some(n => n < 1 || n > max))) return { bad: max };
      if (a.kind !== 'pass') {   // 하루 최대 매수 종목 수
        const placed = Object.entries(ords).filter(([c, o]) => countsAsBuy(o) && (isCb ? cbCodes.has(c) : !cbCodes.has(c))).length;   // 종가베팅 저녁 매수는 따로 센다
        const room = Math.max(0, cap - placed), fresh = nums.filter(n => !isOrdered(ords[run.payload.picks[n - 1].code]));
        if (!room) return { capFull: cap };
        if (fresh.length > room) { LOG.push(run.payload, 'cap', `하루 최대 ${cap}종목 — 이번 승인 ${fresh.length}종목 중 ${room}종목만 매수(점수순)`); nums = nums.filter(n => !fresh.includes(n)).concat(fresh.slice(0, room)).sort((x, y) => x - y); }
      }
      run.payload.decision = a.kind === 'pass' ? { kind: 'pass', at: new Date().toISOString() } : { kind: 'buy', nums: kwLate ? [...new Set([...(dec0.nums || []), ...nums])] : nums, at: new Date().toISOString() };
      run.payload.approved = a.kind === 'pass' ? (run.payload.approved || []) : [...new Set([...(run.payload.approved || []), ...nums.map(n => run.payload.picks[n - 1].code)])];
      run.status = a.kind === 'pass' ? 'passed' : 'approved';
      const via = { site: '사이트', telegram: '텔레그램', auto: '자동 승인' }[opts.via] || '텔레그램';
      LOG.push(run.payload, a.kind === 'pass' ? 'pass' : 'approve', `${via}에서 ${a.kind === 'pass' ? '패스' : '매수 승인: ' + nums.map(n => run.payload.picks[n - 1].name).join(', ')}${min > I.T.deadline ? ' (승인 마감 뒤)' : ''}`);
      return { payload: JSON.parse(JSON.stringify(run.payload)), mine: a.kind === 'pass' ? [] : nums.map(n => run.payload.picks[n - 1].code) };
    });
    if (res.nothing) return '';
    if (res.capFull) return `${cbOpen ? '종가베팅 ' : '하루 '}최대 매수 종목 수(${res.capFull}종목)를 이미 채웠어요. 더 사지 않아요.`;
    if (res.closedNum) return `${res.closedNum.join(', ')}번은 이전 회차 후보라 마감됐어요. 이번 회차 번호로 골라 주세요.`;
    if (res.bad) return `번호를 확인해 주세요. 1~${res.bad} 중에서 골라요.`;
    if (res.dup) return `이미 처리했어요: ${res.dup.kind === 'pass' ? '패스' : res.dup.kind === 'expired' ? '만료' : '매수 ' + res.dup.nums.join(',')}`;
    if (a.kind === 'pass') return '오늘 후보를 모두 패스로 기록했어요.';
    const ex = execFor(sid);
    if (!ex) return `승인 기록: ${res.payload.approved.join(', ')}\n(가상매매 엔진이 꺼져 있어 주문은 내지 않았어요.)`;
    try { return await ex.approve(date, { ...res.payload, approved: res.mine }); } catch (e) { return `승인은 기록했지만 가상 매수 중 오류: ${e.message}`; }
  }
  /* 텔레그램 답장: 글자(A·B·C)로 전략을 고름. 대기 중인 전략이 하나면 글자 없이도 됨 */
  async function handleApproval(text, onlySid, opts = {}) {
    const { date, min } = kstParts();
    const a = parseCmdMulti(text, 'buy');
    if (!a) return null;
    const runs = (await readRuns(date).catch(() => [])).filter(r => (!onlySid || sidOf(r) === onlySid) && (r.payload.picks || []).length);
    runs.forEach(r => { state.runs[sidOf(r)] = r; });
    if (!runs.length) return '오늘은 승인할 후보가 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 예) /매수 1 3${runs.length > 1 ? ' · 전략이 여럿이면 /매수 A1 B2' : ''}`;
    const pend = runs.filter(r => !(r.payload.decision && r.payload.decision.kind) || (opts.late && r.payload.decision.kind === 'expired'));
    const byLetter = l => runs.find(r => (r.payload.letter || 'A') === l);
    /* 섞임 방지(2026-11-19): 전략을 정하지 않은 명령(텔레그램 "/매수 1"·"/매수 전체"·"/패스")은 한쪽만 — 기본 가상매매.
       실전매매(드라이런·실전) 후보는 글자를 붙여야 처리("/매수 B1"·"/매수 B 전체"·"/패스 B"). 사이트는 전략을 정해 부르거나 side 를 줌 */
    const scope = onlySid ? null : (opts.side === 'real' ? 'real' : 'paper'), inScope = r => !scope || sideOfRun(r) === scope;
    const otherHint = () => { const o = runs.find(r => !inScope(r)); return o ? ` ${scope === 'paper' ? '실전매매(🔴) 후보는' : '가상매매 후보는'} 전략 글자를 붙여 주세요. 예) /매수 ${o.payload.letter || 'A'}1` : ''; };
    const jobs = [];
    if (a.kind === 'pass' || a.kind === 'all') {
      let L;
      if (a.letter) { const r = byLetter(a.letter); if (!r) return `${a.letter} 전략의 오늘 후보가 없어요.`; L = [r]; }
      else { const ps = pend.filter(inScope); L = ps.length ? ps : runs.filter(inScope); }
      if (!L.length) return `${scope === 'real' ? '실전매매' : '가상매매'}에는 오늘 승인할 후보가 없어요.${otherHint()}`;
      L.forEach(r => jobs.push([sidOf(r), { kind: a.kind }]));
    } else {
      const g = {};
      for (const it of a.items) {
        const ps = pend.filter(inScope), rs = runs.filter(inScope);
        let r = it.letter ? byLetter(it.letter) : (ps.length === 1 ? ps[0] : rs.length === 1 ? rs[0] : null);
        if (!r && !it.letter && !rs.length) return `${scope === 'real' ? '실전매매' : '가상매매'}에는 오늘 승인할 후보가 없어요.${otherHint()}`;
        if (!r) return it.letter ? `${it.letter} 전략의 오늘 후보가 없어요.` : '전략이 여럿이에요. 번호 앞에 글자를 붙여 주세요. 예) /매수 A1 B2';
        (g[sidOf(r)] = g[sidOf(r)] || []).push(it.n);
      }
      Object.entries(g).forEach(([sid, nums]) => jobs.push([sid, { kind: 'buy', nums: [...new Set(nums)] }]));
    }
    const out = [];
    for (const [sid, job] of jobs) { const r = await approveRun(date, sid, job, min, opts); out.push(jobs.length > 1 || runs.length > 1 ? `[${labelOf(sid)}]\n${r}` : r); }
    return out.join('\n\n');
  }

  /* 승인 마감 넘긴 알림은 '만료'로 기록 */
  async function expireIfNeeded(date, sid) {
    let expired = false;
    const { I } = await intraOf(sid), min0 = kstParts().min;
    let dlText = ST.hhmm(I.T.deadline);
    await mutateRun(date, sid, run => { const dl = Math.max(I.T.deadline, run.payload.roundDeadline || 0); if (run.status === 'noticed' && !run.payload.decision && min0 > dl) { dlText = ST.hhmm(dl); run.status = 'expired'; run.payload.decision = { kind: 'expired', at: new Date().toISOString() }; expired = true; LOG.push(run.payload, 'expire', `승인 마감(${dlText})까지 답이 없어 매수하지 않음 — 사이트에서는 ${run.payload.cb && (run.payload.picks || []).some(p => p.cb && !p.closed) ? '19:55' : '15:20'}까지 승인 가능`); } state.runs[sid] = run; });
    if (expired) await tgFor(sid)(`⌛ ${dlText} 승인 마감 — 이번 자동매매 후보는 매수하지 않고 기록만 남겼어요.${(state.runs[sid] && state.runs[sid].payload.roundN) ? ' (다음 검토에서 새 후보가 나오면 다시 알려요)' : ''}`);
  }

  const activeOrders = run => Object.values((run && run.payload && run.payload.orders) || {}).some(v => v.st === 'intent' || v.st === 'open' || v.st === 'modified');

  /* 주기 호출: 서버 타이머(30초)와 외부 깨우기(/trigger-auto) 둘 다 이걸 부른다. "아직 안 했으면 지금 한다"로 보완.
     시간 창(전략 설정): 08:00~09:00 전날 전환 보완 · 09:00~15:20 아침 분할 매도 · 09:00~15:30 매수 주문 관리 · 전략별 선정~마감+30분
              판정~답 마감 · 답 마감~15:30 무응답 처리 · 전환 시각~ */
  async function tick() {
    if (!modesAll) { try { await loadModes(); } catch (e) { state.lastErr = '전략 목록(실행 모드)을 읽지 못함: ' + e.message; return { ok: false, err: state.lastErr }; } }
    const { date, min } = kstParts();
    const W = (a, b) => min >= a && min < b;
    const A = await actives();
    const T0 = A.CI.T;   // 판정·전환·분할·저녁 매수는 종가 전략 시각
    const roundEnd = I => (I.params.roundMin > 0 ? ST.tmin(I.params.roundEnd) : 0), selEndOf = I => Math.max(I.T.selEnd, roundEnd(I) + I.params.approveWindow);
    const selNow = A.Is.filter(I => W(I.T.sel, selEndOf(I)));
    const hasPaper = HAS;
    const inOrd = hasPaper && (W(540, 930) || W(T0.njudge, T0.convert)), inEodJ = hasPaper && W(T0.judge, T0.reply), inEodT = hasPaper && W(T0.reply, 930), inNxJ = hasPaper && W(T0.njudge, T0.nreply), inNxT = hasPaper && W(T0.nreply, T0.convert), inCb = hasPaper && A.C.enabled && !!A.C.params.closeBuyOn && W(T0.cbWatch && T0.cbWatch.length ? T0.cbWatch[0] : T0.cbAt, T0.cbEnd);
    const inJr = min >= JR_AT || W(JR_FIN, 930), inConv = hasPaper && min >= T0.convert, inPre = hasPaper && W(480, 540), inMorn = hasPaper && W(540, 920);
    if (!selNow.length && !inJr && !inOrd && !inEodJ && !inEodT && !inNxJ && !inNxT && !inConv && !inPre && !inMorn) return { ok: true, idle: 'outside-window' };
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
    if (inJr && Date.now() - (state.dryAt || 0) > 300000) { state.dryAt = Date.now(); out.dry = await dryTick(date, min).catch(err); }   // 드라이런 점검 기간 종료 알림(장 마감 뒤)
    if ((await haltLevel()) === 'all') {   // 자동매매 전체 정지: 기록 정리만(손절·익절은 엔진이 계속 감시)
      out.exc = await excTick(date, min).catch(err);
      if (min >= require('./auto-daylog').SAVE_AT) out.daylog = await DL.tick(date, min).catch(err);
      if (inJr) out.journal = await JR.tick(date, min, T0.convert).catch(err);
      return { ok: true, date, min, idle: 'halted', ...out };
    }
    // 전날 전환을 못 했으면(서버가 전환 시각에 잠들어 있었음) 아침에 보완 — 아침 매도보다 먼저
    if (state.prevConvChecked && state.prevConvChecked !== date) state.prevConvChecked = null;
    if ((inPre || inMorn) && D.prevTradingDay && !state.prevConvChecked) {
      const prev = D.prevTradingDay(date);
      const prs = prev ? await readRuns(prev).catch(() => null) : null;
      let ok = !!prs;
      for (const pr of prs || []) if (isClosingRun(pr) && !pr.payload.carryDone) { const c = await eodFor(sidOf(pr)).convert(prev).catch(err); (out.conv = out.conv || []).push(c); if (!c.ok) ok = false; }
      if (ok) state.prevConvChecked = date;
    }
    if (inMorn) {
      if (!state.carry || Date.now() - (state.carryAt || 0) > 60000) { state.carry = await readCarry().catch(() => state.carry); state.carryAt = Date.now(); }
      const pend = Object.values((state.carry && state.carry.items) || {}).some(i => i.from < date && i.state !== 'done');
      if (pend) out.morning = await eodAny.morning(date, min).catch(err);
    }
    /* 아침 보류로 장중 전환한 종가베팅 종목은 14:45·18:30 판정 대상 — 종가 전략의 오늘 기록이 아직 없으면(저녁 관찰 전) 만들어 둠 */
    if (HAS && (inEodJ || inNxJ) && !state.runs[A.C.id] && Object.values((state.carry && state.carry.items) || {}).some(i => i.state === 'intra' && i.holdDate === date && i.sid === A.C.id)) {
      await ensureCbRun(date, A.CI).catch(err);
      const cr = await readRun(date, A.C.id).catch(() => null); if (cr) state.runs[A.C.id] = cr;
    }
    for (const r of runs()) {
      const sid = sidOf(r), E = r.payload.eod, EN = r.payload.eodN, waiting = x => x && (x.weak || []).length && !x.decision;
      if (inOrd && activeOrders(r)) (out.follow = out.follow || {})[sid] = await execFor(sid).follow(date).catch(err);
      if (!isClosingRun(r)) continue;   // 2026-11-19: 장중 전략은 종가 판정·정리·이월이 없음(매도 계획·직접 매도로만) — 종가 전략 기록만
      if (inEodJ && !(E && E.at)) (out.judge = out.judge || {})[sid] = await eodFor(sid).judge(date, 'reg').catch(err);
      if (inEodT && waiting(E)) (out.timeout = out.timeout || {})[sid] = await eodFor(sid).timeout(date, 'reg').catch(err);
      if (inNxJ && !(EN && EN.at)) (out.judgeN = out.judgeN || {})[sid] = await eodFor(sid).judge(date, 'nxt').catch(err);
      if (inNxT && waiting(EN)) (out.timeoutN = out.timeoutN || {})[sid] = await eodFor(sid).timeout(date, 'nxt').catch(err);
      if (inConv && !r.payload.carryDone) (out.convert = out.convert || {})[sid] = await eodFor(sid).convert(date).catch(err);
    }
    if (inConv && Object.values((state.carry && state.carry.items) || {}).some(i => i.state === 'intra' && i.holdDate === date)) out.reconvert = await eodAny.reconvert(date).catch(err);   // 아침에 장중으로 전환한 종목 → 20:00 다시 이월
    const onMemo = {}, onFor = async side => (onMemo[side] === undefined ? (onMemo[side] = await masterOn(side)) : onMemo[side]);   // 쪽별 켜기/끄기(이번 주기에 한 번만 읽음)
    if (inCb && ((await onFor('paper')) || (await onFor('real')))) {   // 종가베팅 저녁 매수: 18:00부터 관찰 회차, 19:30 이후 최종 선정(전략마다 한 번(실패하면 최대 3번까지 1분 간격으로 다시)
      for (const I of [A.CI]) {   // 2026-11-19: 종가 전략 하나가 자기 기록·장부로(장중 전략과 무관)
        if (!(await onFor(sideOfSid(I.id)))) continue;   // 그 전략의 쪽(가상매매·실전매매) 스위치가 꺼져 있으면 건너뜀
        const r = state.runs[I.id], cbx = r && r.payload && r.payload.cb;
        if (cbx && cbx.done) {
          const dl = cbx.deadline || T0.cbEnd;
          if (cbx.approval === 'auto' && r.status === 'noticed' && !r.payload.decision && min <= dl) (out.cb = out.cb || {})[I.id] = { auto: await autoApprove(I.id).catch(err) };   // 알림 직후 끊겼던 경우 보완
          continue;
        }
        if (min < T0.cbAt) {   // 관찰 시간: 회차마다 후보만 기록(알림·매수 없음), 놓친 회차는 가장 최근 것 하나만
          const due = (T0.cbWatch || []).filter(t => t <= min).length, key = `${date}|${I.id}|${due}`;
          state.cbwSeen = state.cbwSeen || new Set();
          if (due > 0 && !state.cbBusy && !state.cbwSeen.has(key)) {
            state.cbwSeen.add(key); state.cbBusy = true;
            try { (out.cbw = out.cbw || {})[I.id] = await runCbWatchFor(I, A.C, min, due).catch(err); } finally { state.cbBusy = false; }
          }
          continue;
        }
        if (cbx && (cbx.tries >= 3 || Date.now() - Date.parse(cbx.at) < 60000 * cbx.tries) || state.cbBusy) continue;
        state.cbBusy = true;
        try { (out.cb = out.cb || {})[I.id] = await runClosingBuyFor(I, A.C, min).catch(err); } finally { state.cbBusy = false; }
      }
    }
    for (const r of runs()) if (r.payload.cb && r.status === 'noticed' && !r.payload.decision && min > (r.payload.roundDeadline || 0) && min < 1200) await expireIfNeeded(date, sidOf(r)).catch(e => { state.lastErr = e.message; });
    out.exc = await excTick(date, min).catch(err);
    if (min >= require('./auto-daylog').SAVE_AT) out.daylog = await DL.tick(date, min).catch(err);
    if (inJr) out.journal = await JR.tick(date, min, T0.convert).catch(err);   // 일지는 자동매매를 껐어도 지난 기록을 정리한다
    for (const I of A.Is) {   // 장초 상승 포착: 지정 시각(기본 15:14) 이후 남은 보유분 전량 청산 — 선정 창 밖에서도 돈다
      if (!I.params.flatOn || min < ST.tmin(I.params.flatAt) || min >= 15 * 60 + 30) continue;
      if (!(await onFor(sideOfSid(I.id)))) continue;
      (out.flat = out.flat || {})[I.id] = await flattenFor(I, date).catch(err);
    }
    for (const I of A.Is) {   // 눌림목: 매수 후 pbHoldDays 거래일째 15:05 이후 시간 청산 — 선정 창 밖에서도 돈다
      if (I.params.selector !== 'pullback' || !(+I.params.pbHoldDays > 0) || min < 15 * 60 + 5 || min >= 15 * 60 + 20) continue;   // pbHoldDays 0 = 시간 청산 없음
      if (!(await onFor(sideOfSid(I.id)))) continue;
      (out.hold = out.hold || {})[I.id] = await holdExitFor(I, date).catch(err);
    }
    for (const I of A.Is) {   // 인버스·사이드카 정리: A(하락 국면 끝) · C(보유 거래일) — 15:15~15:20, 선정 창 밖에서도 돈다
      if (I.params.selector !== 'inverse' || I.params.invMode === 'flow' || min < 15 * 60 + 15 || min >= 15 * 60 + 20) continue;
      if (!(await onFor(sideOfSid(I.id)))) continue;
      (out.invExit = out.invExit || {})[I.id] = await invExitFor(I, date).catch(err);
    }
    if (!selNow.length) return { ok: true, date, min, ...out };
    const selOn = [];
    for (const I of selNow) if (await onFor(sideOfSid(I.id))) selOn.push(I);
    if (!selOn.length) return { ok: true, date, min, idle: 'disabled', ...out };
    for (const I of selOn) {
      const r = state.runs[I.id], o = {};
      if (r && r.payload && r.payload.noticeSent) {
        const dl = Math.max(I.T.deadline, r.payload.roundDeadline || 0);
        if (I.params.approval === 'auto' && r.status === 'noticed' && min <= dl) o.auto = await autoApprove(I.id).catch(err);   // 알림 직후 끊겼던 경우 보완
        else if (min > dl && r.status === 'noticed') await expireIfNeeded(date, I.id).catch(e => { state.lastErr = e.message; });
        // 장중 반복 검토: 선정 시각부터 N분마다 새 후보만 다시 찾음(마지막 검토 시각까지, 놓친 회차는 한 번만 따라잡음)
        if (I.params.roundMin > 0 && min <= roundEnd(I) && min >= I.T.sel + I.params.roundMin && !state.roundBusy) {
          const n = Math.floor((min - I.T.sel) / I.params.roundMin) + 1;   // 1회차 = 첫 선정
          if (n > (r.payload.roundN || 1)) { state.roundBusy = true; try { o.round = await runRoundFor(I, n, min).catch(err); } finally { state.roundBusy = false; } }
        }
        o.idle = 'done';
      } else if (min <= I.T.selEnd && (r || !(state.checkedAt[I.id] && Date.now() - state.checkedAt[I.id] < 25000))) {   // 재호출 방지는 아직 기록이 없을 때만
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

  /* 장중 반복 검토(2회차~): 이미 알린·주문한·보유 종목을 뺀 새 후보만 기존 기록에 이어 붙이고 알림(번호는 이어서). 하루 최대 매수 종목 수를 채웠으면 건너뜀 */
  /* 재시도 대기(승인·주문 전)인데 이번 검토에서 조건을 다시 통과하지 못했거나 더 살 자리가 없으면 대기에서 뺀다 — 지난 시도 상태로 되돌리고 후보는 닫음 */
  async function dropStaleRetry(date, sid, keep, why, hh) {
    let dropped = [];
    await mutateRun(date, sid, r => {
      const P = r.payload, ords = P.orders || {};
      for (const [code, o] of Object.entries(ords)) {
        if (!o || o.st !== 'retry' || keep.has(code)) continue;
        const tr = (o.tries || []).slice(), last = tr.pop() || {};
        ords[code] = { st: last.st || 'cancelled', why: last.why || null, buy: last.buy || null, qty: last.qty || null, at: last.at || null, placedAt: last.placedAt || null, ...(tr.length ? { tries: tr } : {}) };
        const pk = (P.picks || []).find(p => p.code === code); if (pk) pk.closed = true;
        dropped.push((pk && pk.name) || code);
      }
      if (dropped.length) LOG.push(P, 'round', `${hh} 검토: ${dropped.join(', ')} — ${why}, 재시도 대기에서 뺌`);
      state.runs[sid] = r;
    });
    return dropped;
  }
  async function runRoundFor(I, n, min) {
    const { date } = kstParts();
    const run = await readRun(date, I.id).catch(() => null);
    if (!run) return { ok: false, why: '오늘 기록 없음' };
    const P0 = run.payload, cap = +I.params.maxBuys || 5, hh = ST.hhmm(min), tries = +I.params.maxTries || 3, retryOn = I.params.retryUnfilled !== false;
    const placedOf = P => Object.values(P.orders || {}).filter(countsAsBuy).length;
    await mutateRun(date, I.id, r => { r.payload.roundN = n; r.payload.roundAt = new Date().toISOString(); state.runs[I.id] = r; });   // 먼저 기록 → 오래 걸려도 같은 회차를 두 번 돌리지 않음
    if (placedOf(P0) >= cap) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'round', `${n}회차 ${hh} 검토 건너뜀 — 하루 최대 ${cap}종목을 이미 채움`); state.runs[I.id] = r; });
      await dropStaleRetry(date, I.id, new Set(), `하루 최대 ${cap}종목을 채워 더 사지 않아`, hh);
      return { ok: true, capped: true };
    }
    const sel = await select(I.params, null, I.id);
    // 이미 알린·주문한 종목은 뺀다. 단, 한 주도 못 산 종목(미체결 취소·재확인 탈락·주문 거부)은 시도 횟수가 남았으면 다시 후보가 된다
    const ords0 = P0.orders || {}, canRetry = code => retryOn && XE.retryable(ords0[code], tries);
    const known = new Set([...(P0.picks || []).map(p => p.code), ...Object.keys(ords0)].filter(c => !canRetry(c)));
    const room = cap - placedOf(P0);
    // 대체 후보 자동 매수: 지난 검토에서 올린 대체 후보가 승인 없이 이번에도 후보(원래 조건 또는 대체 조건)이면 사 줌 — 사용자가 패스·다른 종목 승인한 회차는 존중
    if (I.params.altAutoBuy !== false && room > 0) {
      const still = new Set([...sel.picks, ...(sel.alt || [])].map(c => c.code));
      const P1 = ((await readRun(date, I.id).catch(() => null)) || run).payload, o1 = P1.orders || {}, dk = P1.decision && P1.decision.kind;
      const cand = (P1.picks || []).map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => p.alt && !p.kwHigh && !p.altAuto && still.has(p.code) && !isOrdered(o1[p.code]) && !(P1.approved || []).includes(p.code));
      if (cand.length && dk !== 'pass' && dk !== 'buy') {
        const nums = cand.slice(0, room).map(x => x.n);
        await mutateRun(date, I.id, r => {
          const P = r.payload; if (P.decision && P.decision.kind === 'expired') P.decision = null;
          nums.forEach(n => { P.picks[n - 1].closed = false; P.picks[n - 1].altAuto = true; });
          LOG.push(P, 'round', `${n}회차 ${hh} 검토: 대체 후보 ${nums.map(k => P.picks[k - 1].name).join(', ')} — 승인 없이 이번에도 후보라 자동 매수`); state.runs[I.id] = r;
        });
        const msg = await approveRun(date, I.id, { kind: 'buy', nums }, min, { via: 'auto', late: true });
        if (msg) await tgFor(I.id)('🤖 대체 후보 자동 매수 (승인은 없었지만 이번 검토에도 후보)\n' + msg);
      }
    }
    let fresh = sel.picks.filter(c => !known.has(c.code)).slice(0, Math.min(I.params.notifyTop, room));
    let useAlt = false;   // 원래 조건 통과 종목이 없으면 외국인+기관 합계로 보충(승인 필요)
    if (!fresh.length && I.params.altFlowOn !== false && room > 0) {
      const af = (sel.alt || []).filter(c => !known.has(c.code)).slice(0, Math.min(I.params.notifyTop, room));
      if (af.length) { fresh = af; useAlt = true; }
    }
    const evs = await EV.loadEvents(D.sbGet, date).catch(() => []);
    const dropped = await dropStaleRetry(date, I.id, new Set(fresh.map(c => c.code)), '이번 검토 조건을 통과하지 못해', hh);
    if (!fresh.length) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'round', `${n}회차 ${hh} 검토: 새 후보 없음 (풀 ${sel.stat.pool} → 기본조건 ${sel.stat.base} → 수급 통과 ${sel.stat.flowPass})`); state.runs[I.id] = r; });
      return { ok: true, fresh: 0, dropped: dropped.length };
    }
    const mk = c => ({ ...(c.pb ? { pb: c.pb } : {}), ...(c.inv ? { inv: c.inv } : {}), ...(c.kw8 != null ? { kw8: Math.round(c.kw8 * 1000) / 1000, kwHigh: !!c.kwHigh } : {}), code: c.code, name: c.name, score: c.score.total, ratio: c.score.ratio, amt: c.amt, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector, smx: c.smx, reasons: c.reasons, m: c.m, parts: c.score.parts, ev: EV.stockBadges(evs, c.code, date), round: n });
    let startNum = 0, text = null, nums = [], nRetry = 0, holdNums = [];
    await mutateRun(date, I.id, r => {
      const P = r.payload; startNum = (P.picks || []).length; P.orders = P.orders || {};
      if (P.decision) { P.decisions = (P.decisions || []).concat([P.decision]); P.decision = null; (P.picks || []).forEach(p => { p.closed = true; }); }   // 이미 결정(승인·패스·만료)된 회차의 후보는 닫음
      const shown = [];
      for (const c of fresh) {
        const at = (P.picks || []).findIndex(p => p.code === c.code);
        if (at >= 0) {   // 다시 시도: 같은 번호의 후보를 새 값으로 갱신하고 지난 주문은 이력으로 접음
          const old = P.orders[c.code], p = P.picks[at];
          const why = old ? RETRY_WHY(old) : '';
          if (old) P.orders[c.code] = XE.foldTry(old, Date.now());
          Object.assign(p, mk(c), { round: p.round || 1, retry: (p.retry || 0) + 1, retryWhy: why, closed: false });
          nums.push(at + 1); nRetry++; shown.push({ ...c, num: at + 1, retry: p.retry, retryWhy: why });
        } else {
          P.picks = (P.picks || []).concat([mk(c)]);
          nums.push(P.picks.length); shown.push({ ...c, num: P.picks.length });
        }
      }
      const shadowKnown = new Set((P.shadow || []).map(x => x.code));
      P.shadow = (P.shadow || []).concat(sel.passedAll.filter(c => !shadowKnown.has(c.code)).map(c => ({ code: c.code, name: c.name, score: c.score.total, parts: c.score.parts, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector, m: c.m, picked: fresh.some(f => f.code === c.code), round: n })));
      r.status = 'noticed'; P.roundDeadline = min + I.params.approveWindow;
      LOG.push(P, 'round', `${n}회차 ${hh} 검토: 새 후보 ${fresh.length - nRetry}개${nRetry ? ` · 다시 시도 ${nRetry}개` : ''} (${fresh.map(c => c.name + (shown.find(x => x.code === c.code).retry ? '🔁' : '')).join(', ')}) · 풀 ${sel.stat.pool} → 기본조건 ${sel.stat.base} → 수급 통과 ${sel.stat.flowPass}`);
      const letter = P.letter || 'A', ps = shown.map(c => ({ ...c, score: { total: c.score.total, ratio: c.score.ratio || 0 }, warns: [] }));
      text = formatMessage(date, ps, { timeText: hh, round: n, nums, warn: P.warn, deadline: ST.hhmm(P.roundDeadline), auto: I.params.approval === 'auto' && !useAlt });
      if (lettered(I.id)) text = text.replace(/\n(\d+)\. /g, `\n${letter}$1. `).replace(/답장: \/매수 (\d+) (\d+)(?: \d+)? \(번호\)/, `답장: /매수 ${letter}$1 ${letter}$2 (글자+번호)`);
      if (useAlt) fresh.forEach(c => { const pk = P.picks.find(p => p.code === c.code); if (pk) { pk.alt = true; pk.altSum = Math.round(c.altSum || 0); } });
      holdNums = shown.filter(c => c.kwHigh).map(c => c.num);
      if (holdNums.length && text) text = text.replace('\n', `\n⚠️ 개인 계좌수가 8월 기준 ${I.params.kwMax || 100}% 이상인 종목(${shown.filter(c => c.kwHigh).map(c => c.name + ' ' + Math.round(c.kw8 * 100) + '%').join(', ')})은 자동 승인에서 빼요. 사려면 직접 승인하세요.\n`);
      state.runs[I.id] = r;
    });
    if (text && useAlt) text = text.replace('\n', `\n⚠️ 대체 조건 후보 — 외국인·기관 모두 순매수인 종목이 없어 "외국인+기관 합계 ${I.params.altFlowMinEok || 1}억 이상"으로 골랐어요. 매수하려면 승인하세요. 승인하지 않아도 다음 검토에도 후보면 자동 매수해요.\n`);
    if (text) await tgFor(I.id)(text);
    let auto = null;
    if (I.params.approval === 'auto' && !useAlt) {
      const autoNums = nums.filter(k => !holdNums.includes(k));   // 개인 계좌수 상한 이상인 후보는 자동 승인하지 않음
      if (autoNums.length) {
        const msg = await approveRun(date, I.id, { kind: 'buy', nums: autoNums }, min, { via: 'auto' });
        if (msg) await tgFor(I.id)('🤖 자동 승인\n' + msg);
      }
      auto = { ok: true, held: holdNums.length };
    }
    state.runs[I.id] = await readRun(date, I.id).catch(() => null) || state.runs[I.id];
    return { ok: true, fresh: fresh.length, retry: nRetry, auto };
  }

  /* 종가베팅 저녁 매수(19:05~): NXT 거래 가능 종목 중 장중과 같은 조건(정배열·매집·수급 동시 순매수)을 통과하고 종가가 당일 고가 가까이 마감한 종목을
     새로 골라(오늘 이미 후보·주문한 종목 제외) 알림 → 승인(기본 자동) → NXT 지정가 매수. 매수분은 20:00 전환에서 이월 종목으로 넘어가 다음 날 아침 분할 매도 */
  async function ensureCbRun(date, I) {
    let run = await readRun(date, I.id).catch(() => null);
    if (!run) {   // 오전 선정이 없던 날(서버가 쉬었던 날 등)도 저녁 매수는 할 수 있게 빈 기록을 만든다
      const payload = { kind: 'closing', selectedAt: new Date().toISOString(), engine: BR.modeOf(I.id), strategy: { id: I.id, version: I.version, name: I.name }, params: I.params, letter: I.letter || ST.CLOSE_LETTER, picks: [], shadow: [], approved: [], decision: null, noticeSent: true, stat: null, log: [] };
      LOG.push(payload, 'select', `종가베팅 오늘 기록 시작(${{ paper: '가상', dry: '드라이런', live: '실전' }[BR.modeOf(I.id)] || BR.modeOf(I.id)} 장부)`);
      await lock(() => writeRun({ trade_date: date, strategy_id: I.id, status: 'noticed', payload }));
    }
  }
  const cbSelect = (I, cp, known, hist) => select({ ...I.params, cttrMin: 0, openRiseMax: 99, noCttr: true }, { sid: I.id, nxtOnly: true, skip: known, closeHigh: { maxPct: cp.closeBuyHighPct, from: cp.closeBuyPenaltyFrom, max: cp.closeBuyPenaltyMax }, ...(hist ? { hist } : {}) });
  /* 종가베팅 관찰 회차(18:00~, 30분 간격): 최종 선정과 같은 조건으로 후보만 구해 기록. 알림·매수 없음. 통과 이력은 19:30 최종 점수의 가점이 됨 */
  async function runCbWatchFor(I, C, min, k) {
    const { date } = kstParts(), cp = C.params, hh = ST.hhmm(min);
    await ensureCbRun(date, I);
    const P0 = (await readRun(date, I.id)).payload;
    if ((P0.cbw || []).some(e => e.k === k)) return { ok: true, dup: true };
    await mutateRun(date, I.id, r => { r.payload.cbw = (r.payload.cbw || []).concat([{ k, at: new Date().toISOString(), hh, busy: true }]); state.runs[I.id] = r; });   // 자리부터 기록 → 같은 회차를 두 번 돌리지 않음
    const known = new Set([...(P0.picks || []).map(p => p.code), ...Object.keys(P0.orders || {})]);
    let ent;
    try {
      const sel = await cbSelect(I, cp, known, null), st = sel.stat || {};
      ent = { k, at: new Date().toISOString(), hh, n: sel.passedAll.length, passed: sel.passedAll.map(c => ({ code: c.code, name: c.name, score: c.score.total, dd: c.dd == null ? null : Math.round(c.dd * 100) / 100, price: c.price, changePct: c.changePct })).sort((a, b) => b.score - a.score).slice(0, 20), stat: { pool: st.pool, base: st.base, nxtOut: st.nxtOut || 0, flowPass: st.flowPass, highOut: st.highOut || 0 } };
    } catch (e) { ent = { k, at: new Date().toISOString(), hh, err: e.message }; }
    await mutateRun(date, I.id, r => {
      r.payload.cbw = (r.payload.cbw || []).map(e => e.k === k ? ent : e);
      LOG.push(r.payload, 'cbw', ent.err ? `${hh} 관찰 ${k}회차 실패 — ${ent.err}` : `${hh} 관찰 ${k}회차: 조건 통과 ${ent.n}개${ent.passed.length ? ` (${ent.passed.slice(0, 4).map(x => x.name).join(', ')}${ent.n > 4 ? ' …' : ''})` : ''} · 풀 ${ent.stat.pool} → 기본조건 ${ent.stat.base}(NXT 아님 ${ent.stat.nxtOut} 제외) → 수급 통과 ${ent.stat.flowPass}${ent.stat.highOut ? `(고가 대비 낙폭 큼 ${ent.stat.highOut} 제외)` : ''}`);
      state.runs[I.id] = r;
    });
    return { ok: !ent.err, k, n: ent.n };
  }
  async function runClosingBuyFor(I, C, min) {
    const { date } = kstParts(), cp = C.params, hh = ST.hhmm(min), T = I.T, end = ST.tmin(cp.closeBuyEnd);
    await ensureCbRun(date, I);
    let tries = 0;
    await mutateRun(date, I.id, r => { const c = r.payload.cb || {}; tries = (c.tries || 0) + 1; r.payload.cb = { ...c, at: c.at || new Date().toISOString(), tries, done: false, max: cp.closeBuyMax, deadline: end, approval: cp.closeBuyApproval }; state.runs[I.id] = r; });   // 먼저 기록 → 같은 선정을 두 번 돌리지 않음
    const P0 = (await readRun(date, I.id)).payload;
    const known = new Set([...(P0.picks || []).map(p => p.code), ...Object.keys(P0.orders || {})]);
    let sel;
    try {
      const cbw = (P0.cbw || []).filter(e => !e.err && !e.busy), cnt = {};
      cbw.forEach(e => (e.passed || []).forEach(p => { cnt[p.code] = (cnt[p.code] || 0) + 1; }));
      sel = await cbSelect(I, cp, known, { n: cbw.length, cnt, max: +cp.closeBuyBonus || 0 });
    } catch (e) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'cb', `${hh} 종가베팅 후보 선정 실패(${tries}번째) — ${e.message}`); r.payload.cb.err = e.message; state.runs[I.id] = r; });
      return { ok: false, err: e.message };
    }
    const fresh = sel.picks.slice(0, cp.closeBuyMax);
    const st = sel.stat || {}, evs = await EV.loadEvents(D.sbGet, date).catch(() => []);
    const funnel = `풀 ${st.pool ?? '–'} → 기본조건 ${st.base ?? '–'}${st.nxtOut ? `(NXT 아님 ${st.nxtOut} 제외)` : ''} → 수급 통과 ${st.flowPass ?? '–'}${st.highOut ? `(고가 대비 낙폭 큼 ${st.highOut} 제외)` : ''}`;
    if (!fresh.length) {
      await mutateRun(date, I.id, r => { LOG.push(r.payload, 'cb', `${hh} 종가베팅 후보 없음 — ${funnel}`); r.payload.cb = { ...r.payload.cb, done: true, picks: 0, stat: st }; r.payload.rejected = (r.payload.rejected || []).concat((sel.rejected || []).slice(0, 40).map(x => ({ ...x, cb: true }))).slice(-80); state.runs[I.id] = r; });
      await tgFor(I.id)(`🌙 ${hh} 종가베팅 후보 없음\n${funnel}`);
      return { ok: true, fresh: 0 };
    }
    const n = (P0.roundN || 1) + 1;
    const mk = c => ({ code: c.code, name: c.name, score: c.score.total, ratio: c.score.ratio, amt: c.amt, price: c.price, open: c.open, high: c.high || null, dd: c.dd == null ? null : Math.round(c.dd * 100) / 100, penalty: c.score.penalty || 0, bonus: c.score.bonus || 0, hist: c.hist || null, changePct: c.changePct, sector: c.sector, smx: c.smx, reasons: c.reasons, m: c.m, parts: c.score.parts, ev: EV.stockBadges(evs, c.code, date), round: n, cb: true });
    let text = null, nums = [];
    await mutateRun(date, I.id, r => {
      const P = r.payload; P.orders = P.orders || {};
      if (P.decision) { P.decisions = (P.decisions || []).concat([P.decision]); P.decision = null; }
      (P.picks || []).forEach(p => { p.closed = true; });   // 오전·장중 후보는 모두 닫고 저녁 후보만 승인 대상
      const startNum = (P.picks || []).length;
      P.picks = (P.picks || []).concat(fresh.map(mk));
      nums = fresh.map((_, i) => startNum + i + 1);
      const known2 = new Set((P.shadow || []).map(x => x.code));
      P.shadow = (P.shadow || []).concat(sel.passedAll.filter(c => !known2.has(c.code)).map(c => ({ code: c.code, name: c.name, score: c.score.total, parts: c.score.parts, price: c.price, open: c.open, changePct: c.changePct, sector: c.sector, m: c.m, picked: fresh.some(f => f.code === c.code), round: n, cb: true })));
      P.rejected = (P.rejected || []).concat((sel.rejected || []).slice(0, 40).map(x => ({ ...x, cb: true }))).slice(-80);
      P.roundN = n; P.roundDeadline = end; r.status = 'noticed'; P.noticeSent = true; P.noticeAt = new Date().toISOString();
      P.cb = { ...P.cb, done: true, picks: fresh.length, stat: st, nums };
      LOG.push(P, 'cb', `${hh} 종가베팅 후보 ${fresh.length}개 (${fresh.map(c => c.name).join(', ')}) · ${funnel} · 승인 마감 ${cp.closeBuyEnd}${cp.closeBuyApproval === 'auto' ? ' (자동 승인 설정)' : ''}`);
      const letter = P.letter || 'A', ps = fresh.map((c, i) => ({ ...c, num: startNum + i + 1, score: { total: c.score.total, ratio: c.score.ratio || 0, penalty: c.score.penalty || 0 }, warns: [] }));
      text = formatMessage(date, ps, { timeText: hh, cb: true, nums, warn: null, deadline: cp.closeBuyEnd, auto: cp.closeBuyApproval === 'auto' });
      if (lettered(I.id)) text = text.replace(/\n(\d+)\. /g, `\n${letter}$1. `).replace(/답장: \/매수 (\d+) (\d+)(?: \d+)? \(번호\)/, `답장: /매수 ${letter}$1 ${letter}$2 (글자+번호)`);
      state.runs[I.id] = r;
    });
    if (text) await tgFor(I.id)(text);
    let auto = null;
    if (cp.closeBuyApproval === 'auto') {
      const msg = await approveRun(date, I.id, { kind: 'buy', nums }, min, { via: 'auto' });
      if (msg) await tgFor(I.id)('🤖 자동 승인\n' + msg);
      auto = { ok: true };
    }
    state.runs[I.id] = await readRun(date, I.id).catch(() => null) || state.runs[I.id];
    return { ok: true, fresh: fresh.length, auto };
  }

  /* 승인 방식 '자동': 그 전략의 알림 후보 전체를 승인한 것으로 처리(가상매매) */
  async function autoApprove(sid) {
    const { date, min } = kstParts();
    const cur = await readRun(date, sid).catch(() => null), open = ((cur && cur.payload && cur.payload.picks) || []).filter(p => !p.closed);
    const paper = sideOfSid(sid) === 'paper';   // 가상매매는 대체 후보·개인 계좌수 초과 후보도 즉시 자동 승인(성과 검증용)
    if (!paper && open.length && open.every(p => p.alt || p.kwHigh)) return { ok: true, skipped: '대체 후보·개인 계좌수 초과 후보는 승인 필요' };   // 대체 조건·개인 계좌수 상한 이상 후보는 자동 승인하지 않음
    const msg = await approveRun(date, sid, { kind: 'all' }, min, { via: 'auto', paper });
    if (msg) await tgFor(sid)('🤖 자동 승인\n' + msg);
    return { ok: true };
  }

  /* /정리 A1 B2 · /정리 1(정리 대기 전략이 하나일 때) · /정리 전체 · /유지 */
  async function handleEod(text, onlySid, opts = {}) {
    if (!HAS) return null;
    const { date, min } = kstParts();
    const a = parseCmdMulti(text, 'eod');
    if (!a) return null;
    const wk = (r, ph) => { const E = r.payload[ph === 'nxt' ? 'eodN' : 'eod']; return E && (E.weak || []).length ? E : null; };   // 정규장(15시) · NXT(19시) 두 판정 중 약한 종목이 있는 쪽
    const runs = (await readRuns(date).catch(() => [])).filter(r => (!onlySid || sidOf(r) === onlySid) && (opts.phase ? wk(r, opts.phase) : (wk(r, 'reg') || wk(r, 'nxt'))));
    runs.forEach(r => { state.runs[sidOf(r)] = r; });
    if (!runs.length) return '지금 정리할지 물어본 종목이 없어요.';
    if (a.kind === 'bad') return `번호를 확인해 주세요. 예) /정리 1${runs.length > 1 ? ' · 전략이 여럿이면 /정리 A1 B2' : ''}`;
    const AC = await actives(), nxtFrom = AC.CI.T.njudge;
    const pend = runs.filter(r => (opts.phase ? !wk(r, opts.phase).decision : !!eodFor(sidOf(r)).pendingPhase(r.payload, min, nxtFrom)));
    /* 섞임 방지: 글자 없는 /정리·/유지 는 한쪽(기본 가상매매)만. 실전매매는 "/정리 B1"·"/정리 B 전체"·"/유지 B" */
    const scope = onlySid ? null : (opts.side === 'real' ? 'real' : 'paper'), inScope = r => !scope || sideOfRun(r) === scope;
    const byL = l => runs.find(x => (x.payload.letter || 'A') === l);
    const otherHint = () => { const o = runs.find(r => !inScope(r)); return o ? ` ${scope === 'paper' ? '실전매매(🔴) 종목은' : '가상매매 종목은'} 전략 글자를 붙여 주세요. 예) /정리 ${o.payload.letter || 'A'}1 · /유지 ${o.payload.letter || 'A'}` : ''; };
    const jobs = [];
    if (a.kind === 'keep' || a.kind === 'all') {
      let L;
      if (a.letter) { const r = byL(a.letter); if (!r) return `${a.letter} 전략은 정리할 종목이 없어요.`; L = [r]; }
      else { const ps = pend.filter(inScope); L = ps.length ? ps : runs.filter(inScope); }
      if (!L.length) return `${scope === 'real' ? '실전매매' : '가상매매'}에는 지금 정리할지 물어본 종목이 없어요.${otherHint()}`;
      L.forEach(r => jobs.push([sidOf(r), a.kind === 'keep' ? '/유지' : '/정리 전체']));
    } else {
      const g = {};
      for (const it of a.items) {
        const ps = pend.filter(inScope), rs = runs.filter(inScope);
        const r = it.letter ? byL(it.letter) : (ps.length === 1 ? ps[0] : rs.length === 1 ? rs[0] : null);
        if (!r && !it.letter && !rs.length) return `${scope === 'real' ? '실전매매' : '가상매매'}에는 지금 정리할지 물어본 종목이 없어요.${otherHint()}`;
        if (!r) return it.letter ? `${it.letter} 전략은 정리할 종목이 없어요.` : '전략이 여럿이에요. 번호 앞에 글자를 붙여 주세요. 예) /정리 A1';
        (g[sidOf(r)] = g[sidOf(r)] || []).push(it.n);
      }
      Object.entries(g).forEach(([sid, nums]) => jobs.push([sid, '/정리 ' + [...new Set(nums)].join(' ')]));
    }
    const out = [];
    for (const [sid, cmd] of jobs) { const r = await eodFor(sid).handleCmd(date, cmd, min, opts); out.push(jobs.length > 1 || runs.length > 1 ? `[${labelOf(sid)}]\n${r}` : r); }
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
  async function setConfig(body, opts = {}) {
    const c = UI.checkConfig(body);
    if (c.err) return { ok: false, status: 400, error: c.err };
    if (c.val.liveOn === true && !opts.pinOk) return { ok: false, status: 403, needPin: true, error: '실전매매 자동매매를 켜려면 거래 PIN을 다시 입력하세요' };   // 드라이런·실전 전략이 돌기 시작함
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
      return { ok: true, cfg: { on: !!next.on, liveOn: !!next.liveOn, perStockKrw: await perStock() }, changed: c.val };
    });
  }

  /* ── 쪽(가상매매·실전매매)별 체결 읽기 ── */
  const FILLS = { paper: 'paper_fills', dry: 'dry_fills', live: 'live_fills' };
  /* 실제 계좌 체결 중 자동매매 것만: 자동매매 주문(origin auto:…) 또는 엔진이 낸 손절·익절·정리(reason ≠ manual). 사람이 직접 낸 주문의 체결은 뺌.
     주문을 못 읽으면 그대로 둠(일지에 직접 매매가 섞일 수 있음 — 종목·날짜로 한 번 더 걸러짐) */
  async function autoOnlyLive(fills) {
    const ids = [...new Set(fills.map(f => f.order_id || f.orderId).filter(Boolean))];
    if (!ids.length) return fills;
    const ok = new Set();
    try {
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80).map(encodeURIComponent).join(',');
        for (const o of (await D.sbGet(`live_orders?select=id,origin,reason&id=in.(${part})&limit=100`)) || []) if ((o.origin && /^auto/.test(o.origin)) || (o.reason && o.reason !== 'manual')) ok.add(o.id);
      }
    } catch (_) { return fills; }
    return fills.filter(f => ok.has(f.order_id || f.orderId));
  }
  /* 기간 체결(kinds 장부들). q = PostgREST 조건(ts 범위 등). 각 행에 kind */
  async function fillsOf(kinds, q) {
    const out = [];
    for (const k of kinds) {
      if (k !== 'paper' && !BR.engines[k]) continue;
      let rows = await D.sbGet(`${FILLS[k]}?select=*&${q}`).catch(() => []);
      if (k === 'live') rows = await autoOnlyLive(rows || []);
      for (const f of rows || []) out.push({ ...f, kind: k });
    }
    return out;
  }
  const sideArg = v => (v === 'real' ? 'real' : 'paper');

  /* 지난 날짜의 오늘 탭 재구성(자정이 지나 그날 일지를 못 만들었을 때) — 그날 실행 기록(auto_runs)과 체결로 만든다.
     실시간 값(보유·이월·호가)은 지난 날짜엔 없으므로 비운다. side = 'paper'(가상매매) | 'real'(실전매매) */
  async function uiStatePast(date, side) {
    side = sideArg(side);
    const [cfgRows, allRows, A] = await Promise.all([D.sbGet('auto_config?select=value&key=eq.main&limit=1').catch(() => []), readRuns(date), actives()]);
    const todayRows = allRows.filter(r => sideOfRun(r) === side);
    const cv = (cfgRows[0] && cfgRows[0].value) || {};
    const todays = todayRows.map(r => UI.summarizeRun(r, true));
    const owner = new Set();
    todays.forEach(t => t.orders.filter(o => o.filled > 0).forEach(o => owner.add(`${t.engine}|${o.code}`)));
    let trades = [], dayTot = null;
    if (owner.size) {
      const fl = await fillsOf(kindsOfSide(side), `ts=gte.${encodeURIComponent(date + 'T00:00:00+09:00')}&ts=lt.${encodeURIComponent(date + 'T23:59:59.999+09:00')}&order=ts.asc&limit=2000`);
      const nm = {};
      todays.forEach(t => t.orders.forEach(o => { if (o.name) nm[o.code] = o.name; }));
      trades = fl.filter(f => owner.has(`${f.kind}|${f.code}`)).map(f => ({ ts: Date.parse(f.ts), code: f.code, name: nm[f.code] || f.code, side: f.side, price: +f.price, qty: +f.qty, amount: +f.amount, fee: +f.fee || 0, realized: f.realized == null ? null : +f.realized, reason: f.reason || null, kind: f.kind })).sort((x, y) => x.ts - y.ts);
      const rz = trades.reduce((a, f) => a + (f.realized || 0), 0);
      dayTot = { realized: Math.round(rz), evalPl: 0, evalAmt: 0, total: Math.round(rz), buyKrw: Math.round(trades.filter(f => f.side === 'buy').reduce((a, f) => a + (f.amount || 0), 0)), sellKrw: Math.round(trades.filter(f => f.side === 'sell').reduce((a, f) => a + (f.amount || 0), 0)), fee: Math.round(trades.reduce((a, f) => a + (f.fee || 0), 0)), holds: 0, accountRealized: null };
    }
    const regime = await regimeOf(date).catch(() => null);
    const Is = A.Is.filter(i => sideOfSid(i.id) === side);
    const closing = A.C ? { id: A.C.id, name: A.C.name, enabled: !!A.C.enabled, side: sideOfSid(A.C.id), mode: BR.execOf(A.C.id), here: sideOfSid(A.C.id) === side, buyOn: !!(A.C.params && A.C.params.closeBuyOn) } : null;
    return { ok: true, now: Date.now(), date, side, closing, tradingDay: isTradingDay(date), rebuilt: true, cfg: { on: !!cv.on, liveOn: !!cv.liveOn, perStockKrw: await perStock() }, limits: { min: UI.PER_MIN, max: UI.PER_MAX, step: UI.PER_STEP },
      today: todays[0] || null, todays, quotes: {}, active: Is.map(i => i.id), modes: Object.fromEntries(Is.map(i => [i.id, BR.execOf(i.id)])), regime, exposure: null, events: [], positions: [], trades, dayTot, carry: [], history: [], totals: {}, lastErr: null };
  }
  async function uiState(forDate, side) {
    side = sideArg(side);
    const date = forDate || kstParts().date;
    if (forDate && forDate !== kstParts().date) return uiStatePast(forDate, side);
    const [cfgRows, allToday, carry, rowsAll, A] = await Promise.all([
      D.sbGet('auto_config?select=value&key=eq.main&limit=1').catch(() => []),
      readRuns(date).catch(() => []),
      readCarry().catch(() => ({ items: {} })),
      D.sbGet('auto_runs?select=trade_date,strategy_id,status,payload&order=trade_date.desc&limit=80').catch(() => []),
      actives(),
    ]);
    const todayRows = allToday.filter(r => sideOfRun(r) === side);
    const rows = rowsAll.filter(r => sideOfRun(r) === side).slice(0, 30);
    const cv = (cfgRows[0] && cfgRows[0].value) || {};
    const regime = await regimeOf(date).catch(() => null);
    const runs = rows.map(r => UI.summarizeRun(r, false));
    let realized = {}, closes = {};
    if (runs.length) {
      const oldest = runs[runs.length - 1].date;
      const sells = await fillsOf(kindsOfSide(side), `side=eq.sell&ts=gte.${encodeURIComponent(oldest + 'T00:00:00+09:00')}&order=ts.asc&limit=5000`);
      realized = UI.attributeRealized(runs, sells.map(f => ({ code: f.code, ts: f.ts, realized: f.realized, kind: f.kind })));
      const past = runs.filter(r => r.date < date && r.shadow.length);
      const codes = [...new Set(past.flatMap(r => r.shadow.map(s => s.code)))];
      if (past.length && codes.length) {
        const cl = await D.sbGet(`daily_price?select=code,trade_date,close&trade_date=in.(${[...new Set(past.map(r => r.date))].join(',')})&code=in.(${codes.join(',')})&limit=5000`).catch(() => []);
        cl.forEach(x => { (closes[x.trade_date] = closes[x.trade_date] || {})[x.code] = +x.close; });
      }
    }
    const hist = UI.buildHistory(runs, realized, closes, date);
    const todays = todayRows.map(r => UI.summarizeRun(r, true));
    /* 매도 목표 매물대 그림용: 이 기능 전에 낸 오늘 주문은 저장된 매물대가 없어 일봉으로 다시 계산해 붙임(저장은 안 함, 코드별 10분 캐시) */
    try {
      for (const t of todays) for (const o of t.orders || []) {
        if (!o.tinfo || o.tinfo.prof || !/^\d{6}$/.test(o.code)) continue;
        let m = profMemo.get(o.code);
        if (!m || Date.now() - m.at > 600e3) { const rows2 = await D.loadChart(o.code).catch(() => []); m = { at: Date.now(), prof: (rows2 && rows2.length ? XE.buildProfile(rows2) : []).map(b => [Math.round(b.lo), Math.round(b.hi), Math.round(b.v * 10) / 10]) }; profMemo.set(o.code, m); }
        if (m.prof.length) o.tinfo = { ...o.tinfo, prof: m.prof };
      }
    } catch (_) {}
    // 오늘 자동매매 종목·종가 베팅으로 넘긴 종목의 현재 보유 상태(어느 전략 종목인지 함께). 키 = 장부|종목(가상·실전이 같은 종목을 각자 보유)
    const owner = {}, ownerKind = {}, ownerSid = {};
    todays.forEach(t => t.orders.filter(o => o.filled > 0).forEach(o => { owner[`${t.engine}|${o.code}`] = t.strategy ? t.strategy.name : t.sid; ownerKind[`${t.engine}|${o.code}`] = t.kind; ownerSid[`${t.engine}|${o.code}`] = t.sid; }));
    const pbI = (A.Is || []).find(i => i.params && i.params.selector === 'pullback');   // 눌림목은 며칠 들고 가므로 어제 이전에 산 종목도 보유 목록에 넣는다(종가 마감 손절 계획이 붙은 종목)
    const mine = i => (kindOfCarry(i) === 'paper' ? 'paper' : 'real') === side;   // 이월 종목은 넘긴 장부로 쪽을 가름
    const carryItems = Object.values((carry && carry.items) || {}).filter(i => i.state !== 'done' && mine(i));
    const dayOf = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
    const carryDoneToday = Object.values((carry && carry.items) || {}).filter(i => i.state === 'done' && i.doneAt && dayOf(i.doneAt) === date && mine(i));   // 오늘 이미 전량 정리된 이월 종목도 매매 내역·단계 진행에 포함
    let positions = [], trades = [], dayTot = null;
    try {
      const kinds = kindsOfSide(side).filter(k => BR.engines[k]);
      const nm = {};
      todays.forEach(t => t.orders.forEach(o => { if (o.name) nm[o.code] = nm[o.code] || o.name; }));
      carryItems.concat(carryDoneToday).forEach(i => { if (i.name) nm[i.code] = nm[i.code] || i.name; });
      let anyOk = false, accountRealized = null;
      for (const k of kinds) {
        const ps = await BR.stateOf(k).catch(() => null);
        if (!ps || !ps.ok) continue;
        anyOk = true;
        if (pbI) ps.positions.filter(p => p.qty > 0 && p.plan && p.plan.closeStop && !p.plan.tag && !owner[`${k}|${p.code}`]).forEach(p => { owner[`${k}|${p.code}`] = pbI.name; ownerKind[`${k}|${p.code}`] = 'intraday'; ownerSid[`${k}|${p.code}`] = pbI.id; });
        ps.positions.filter(p => p.qty > 0 && p.plan && p.plan.tag && !owner[`${k}|${p.code}`]).forEach(p => { const iv = (A.Is || []).find(i => i.params && i.params.selector === 'inverse' && ({ A: 'regime', B: 'flow', C1: 'sidecar', C2: 'sidecar' })[p.plan.tag] === i.params.invMode); if (iv) { owner[`${k}|${p.code}`] = iv.name; ownerKind[`${k}|${p.code}`] = 'intraday'; ownerSid[`${k}|${p.code}`] = iv.id; } });   // 인버스·사이드카: 며칠 보유(A·C)도 보유 목록에
        const watch = new Set([...Object.keys(owner).filter(x => x.startsWith(k + '|')).map(x => x.slice(k.length + 1)), ...carryItems.filter(i => kindOfCarry(i) === k).map(i => i.code)]);
        const watchTr = new Set([...watch, ...carryDoneToday.filter(i => kindOfCarry(i) === k).map(i => i.code)]);   // 체결 내역용(이미 다 판 종목 포함)
        const nx = {};
        try {
          const cs = [...watch];
          if (cs.length) (await D.sbGet(`stocks?select=code,nxt_ok&code=in.(${cs.join(',')})&limit=200`).catch(() => [])).forEach(r => { nx[r.code] = !!r.nxt_ok; });
        } catch (_) {}
        ps.positions.forEach(p => { nm[p.code] = nm[p.code] || p.name; });
        (ps.orders || []).forEach(o => { if (o.name) nm[o.code] = nm[o.code] || o.name; });
        positions.push(...ps.positions.filter(p => watch.has(p.code)).map(p => ({ code: p.code, name: p.name, qty: p.qty, avg: p.avg, last: p.last, stop: p.stop, plan: p.plan || null, dayHigh: p.dayHigh || null, dayLow: p.dayLow || null, avail: p.avail, strategy: owner[`${k}|${p.code}`] || null, sid: ownerSid[`${k}|${p.code}`] || ((carryItems.concat(carryDoneToday).find(i => i.code === p.code)) || {}).sid || null, skind: ownerKind[`${k}|${p.code}`] || null, kind: k, nxt: nx[p.code] == null ? null : nx[p.code] })));
        trades.push(...(ps.fills || []).filter(f => watchTr.has(f.code) && (k !== 'live' || f.reason !== 'manual' || (ps.orders || []).some(o => o.id === f.orderId && o.origin))).map(f => ({ ts: f.ts, code: f.code, name: nm[f.code] || f.code, side: f.side, price: f.price, qty: f.qty, amount: f.amount, fee: f.fee || 0, realized: f.realized == null ? null : f.realized, reason: f.reason || null, kind: k, sid: ownerSid[`${k}|${f.code}`] || ((carryItems.concat(carryDoneToday).find(i => i.code === f.code)) || {}).sid || null })));
        if (k === 'paper') accountRealized = ps.realizedToday == null ? null : ps.realizedToday;
      }
      if (anyOk) {
        trades.sort((x, y) => x.ts - y.ts);
        const evalPl = positions.reduce((a, p) => a + (p.last > 0 ? (p.last - p.avg) * p.qty : 0), 0);
        const evalAmt = positions.reduce((a, p) => a + (p.last > 0 ? p.last * p.qty : p.avg * p.qty), 0);
        const rz = trades.reduce((a, f) => a + (f.realized || 0), 0);
        dayTot = { realized: Math.round(rz), evalPl: Math.round(evalPl), evalAmt: Math.round(evalAmt), total: Math.round(rz + evalPl),
          buyKrw: Math.round(trades.filter(f => f.side === 'buy').reduce((a, f) => a + (f.amount || 0), 0)), sellKrw: Math.round(trades.filter(f => f.side === 'sell').reduce((a, f) => a + (f.amount || 0), 0)),
          fee: Math.round(trades.reduce((a, f) => a + (f.fee || 0), 0)), holds: positions.length, accountRealized };
      }
    } catch (_) {}
    // 화면용 실시간 시세: 아직 체결 전인 주문·손절/익절 감시 중인 종목·주문 전 후보(최대 8개). 장중에 화면을 열었을 때만 호출됨
    const quotes = {};
    const { min: nowMin } = kstParts();
    if (D.getQuoteUi && nowMin >= 540 && nowMin < 935) {
      const want = [];
      todays.forEach(t => {
        t.orders.forEach(o => { if (['intent', 'open', 'modified', 'skipped'].includes(o.st) || o.filled > 0) want.push(o.code); });
        const have = new Set(t.orders.map(o => o.code));
        t.picks.filter(p => !p.closed && !have.has(p.code)).forEach(p => want.push(p.code));
      });
      const codes = [...new Set(want)].slice(0, 8);
      await Promise.all(codes.map(c => Promise.race([D.getQuoteUi(c), new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 3500))]).then(q => {
        if (q && q.price > 0) quotes[c] = { price: q.price, open: q.open || null, high: q.high || null, low: q.low || null, upper: q.upper || null, lower: q.lower || null, prevClose: q.prevClose || null, strength: q.strength == null ? null : q.strength, vi: !!q.vi,
          bids: (q.bids || []).filter(x => x && x.p > 0).slice(0, 10).map(x => ({ p: x.p, q: x.q })), asks: (q.asks || []).filter(x => x && x.p > 0).slice(0, 10).map(x => ({ p: x.p, q: x.q })), at: Date.now() };
      }).catch(() => {})));
    }
    const events = EV.marketNotes(await EV.loadEvents(D.sbGet, date, 0, 4), date, 3);
    const Is = A.Is.filter(i => sideOfSid(i.id) === side);
    const cOn = A.C && sideOfSid(A.C.id) === side;   // 종가 전략이 이 쪽(가상·실전매매) 장부를 쓰는지
    const closing = A.C ? { id: A.C.id, name: A.C.name, enabled: !!A.C.enabled, side: sideOfSid(A.C.id), mode: BR.execOf(A.C.id), here: !!cOn, buyOn: !!(A.C.params && A.C.params.closeBuyOn) } : null;
    let exposure = null;
    try { const ex = await exposureNow(side); if (ex) { const caps = Is.map(i => +i.params.totalCapKrw || 0).filter(v => v > 0); exposure = { ...ex, rows: undefined, cap: caps.length ? Math.min(...caps) : 0 }; } } catch (_) {}
    const ci = carryItems.map(i => ({ code: i.code, name: i.name, q0: i.q0, avg: i.avg, from: i.from, sold: i.sold || 0, state: i.state, sid: i.sid || null, kind: kindOfCarry(i) }));
    /* 아침 보류(장중 전환) 효과 비교: 09:00 에 그냥 팔았다면(보류 시점 현재가) vs 전환 후 실제(그날 매도 실현 + 남은 수량 평가) */
    let holdCmp = [];
    try { holdCmp = UI.holdCompare([...carryItems, ...carryDoneToday], trades, positions, date); } catch (_) {}
    const cd = carryDoneToday.map(i => ({ code: i.code, name: i.name, q0: i.q0, avg: i.avg, from: i.from, sold: i.sold || 0, state: 'done', why: i.why || null, sid: i.sid || null, kind: kindOfCarry(i) }));
    return {
      ok: true, now: Date.now(), date, side, tradingDay: isTradingDay(date),
      cfg: { on: !!cv.on, liveOn: !!cv.liveOn, perStockKrw: await perStock() }, limits: { min: UI.PER_MIN, max: UI.PER_MAX, step: UI.PER_STEP },
      engines: { dry: BR.engines.dry ? (BR.engines.dry.health ? { missing: !!BR.engines.dry.health().missing } : {}) : null, live: !!BR.engines.live, liveReady: D.liveReady ? D.liveReady() : null, realOrders: D.realOrdersOn ? !!D.realOrdersOn() : null },
      today: todays[0] || null, todays, quotes, active: Is.map(i => i.id), closing, modes: Object.fromEntries([...Is.map(i => [i.id, BR.execOf(i.id)]), ...(cOn && A.C.enabled ? [[A.C.id, BR.execOf(A.C.id)]] : [])]), dry: await (async () => { const o = {}; for (const I of [...A.Is, ...(cOn && A.C.enabled ? [A.C] : [])]) if (BR.execOf(I.id) === 'dryrun') o[I.id] = await dryStatus(I.id, { ...I.params, execMode: 'dryrun' }).catch(() => null); return o; })(), halt: await haltLevel().catch(() => null), regime, exposure, events, positions, trades, dayTot, carry: ci, carryDone: cd, history: hist.rows, totals: hist.totals, holdCmp, lastErr: state.lastErr || null,
    };
  }
  /* 사이트에서 승인·정리(텔레그램 명령과 같은 처리, 전략 지정). 결과는 텔레그램에도 남김 */
  async function siteApprove(kind, nums, sid, side) {
    const text = kind === 'pass' ? '/패스' : `/매수 ${nums.join(' ')}`;
    const r = await handleApproval(text, sid || null, { late: true, via: 'site', side: side === 'real' ? 'real' : 'paper' });
    if (r) await D.sendTelegram(`🖥 사이트에서 ${sid ? `[${labelOf(sid)}] ` : ''}${kind === 'pass' ? '패스' : '매수 ' + nums.join(',')} 선택\n${r}`).catch(() => {});
    if (r && kind !== 'pass' && sid && HAS) { try { await execFor(sid).follow(kstParts().date); } catch (_) {} }   // 승인 즉시 주문 관리를 한 번 돌려 다음 단계(체결 확인·익절 주문)로 넘김
    return { ok: !!r, reply: r || '처리할 수 없는 요청입니다.' };
  }
  /* 사이트 주문 화면: 체결 대기 중인 자동 매수 주문을 직접 정정·취소(같은 주문을 고침 — 별도 주문 아님).
     장부(kind: paper·dry·live)를 꼭 함께 받는다 — 같은 종목을 가상·실전 전략이 각자 살 수 있어(2026-11-19) 종목코드만으로 찾으면
     가상 화면에서 실전 자동 주문을 고치는 일이 생길 수 있음. 장부가 없거나 모르는 값이면 찾지 않음 */
  const KINDS = new Set(['paper', 'dry', 'live']);
  async function activeBuy(code, kind, orderId) {
    if (!KINDS.has(kind)) return null;
    const date = kstParts().date;
    for (const r of await readRuns(date).catch(() => [])) {
      if (engineOfRun(r) !== kind) continue;
      const v = r.payload && r.payload.orders && r.payload.orders[code];
      if (v && ['open', 'modified'].includes(v.st) && v.orderId && (!orderId || v.orderId === orderId)) return { sid: sidOf(r), date, orderId: v.orderId, kind };
    }
    return null;
  }
  async function siteOrderEdit(body) {
    const code = String(body.code || ''), kind = String(body.engine || ''), oid = body.orderId == null ? '' : String(body.orderId);
    if (!KINDS.has(kind)) return { ok: false, status: 400, error: '어느 장부의 주문인지(engine) 빠졌습니다. 화면을 새로고침하세요' };
    if (!oid) return { ok: false, status: 400, error: '주문번호(orderId)가 빠졌습니다. 화면을 새로고침하세요' };
    const a = /^\d{6}$/.test(code) ? await activeBuy(code, kind, oid) : null;
    if (!a) return { ok: false, status: 409, error: '체결 대기 중인 자동 매수 주문이 아닙니다' };
    if (BR.modeOf(a.sid) !== kind) return { ok: false, status: 409, error: '이 전략은 지금 다른 장부로 주문합니다 — 화면을 새로고침하세요' };   // 기록과 전략의 장부가 어긋나면 고치지 않음
    const ex = execFor(a.sid); if (!ex) return { ok: false, status: 503, error: 'auto unavailable' };
    const r = await ex.userEdit(a.date, code, { action: body.action === 'cancel' ? 'cancel' : 'modify', price: body.price, qty: body.qty });
    if (r && r.ok) { const nm = (r.order && r.order.name) || code; await D.sendTelegram(`🖥 사이트에서 [${labelOf(a.sid)}] ${nm} 자동 매수 주문을 ${r.action === 'cancel' ? '취소' : `정정(${Number(body.price).toLocaleString('ko-KR')}원${body.qty ? ' ' + body.qty + '주' : ''})`}했어요.`).catch(() => {}); }
    return r && typeof r === 'object' ? { ...r, real: BR.of(a.sid).real, engine: kind } : r;
  }
  /* 사이트 주문 화면: 같은 장부에 같은 종목 자동 매수 주문이 걸려 있는지(직접 별도 매수 막기용) — 다른 장부 주문은 상관없음 */
  /* 섞임 방지: 화면(desk: real·paper)이 다루는 쪽과 전략의 쪽이 같은지. 종가베팅 전략은 두 쪽이 함께 써서 통과. desk 가 없으면(예전 화면) 통과 */
  async function deskOk(sid, desk) {
    if (!desk) return true;
    const s0 = store.byId ? await store.byId(String(sid || '')).catch(() => null) : null;
    if (s0 && s0.kind === 'closing') return ST.sideOfParams(s0.params) === desk;   // 2026-11-19: 종가베팅도 자기 실행 모드의 쪽에서만
    if (s0 && s0.kind !== 'intraday') return true;
    return sideOfSid(String(sid || '')) === desk;
  }
  async function pendingAutoBuy(code, kind) { const a = await activeBuy(code, kind).catch(() => null); return a ? a.orderId : null; }
  /* 주문번호로 자동 매수 주문인지(일반 정정·취소 화면에서 눌러도 자동매매 추적이 끊기지 않게 같은 처리로 보냄) — 그 장부의 기록만 봄 */
  async function autoOrderCode(orderId, kind) {
    if (!KINDS.has(kind) || !orderId) return null;
    for (const r of await readRuns(kstParts().date).catch(() => [])) {
      if (engineOfRun(r) !== kind) continue;
      for (const [code, v] of Object.entries((r.payload && r.payload.orders) || {})) if (v && v.orderId === orderId && ['open', 'modified'].includes(v.st)) return code;
    }
    return null;
  }
  /* 사이트에서 정리/유지(텔레그램 /정리·/유지 와 같은 처리). phase = 'reg'(15시 정규장 종목) | 'nxt'(19시 NXT 종목), 없으면 답을 기다리는 쪽.
     정리는 승인한 종목만 — 이월 전환은 예정 시각(20:00)에 따로 진행 */
  async function siteEod(kind, nums, sid, phase, side) {
    const text = kind === 'keep' ? '/유지' : `/정리 ${nums.join(' ')}`;
    const ph = phase === 'nxt' || phase === 'reg' ? phase : undefined;
    const r = await handleEod(text, sid || null, { late: true, side: side === 'real' ? 'real' : 'paper', ...(ph ? { phase: ph } : {}) });
    if (r) await D.sendTelegram(`🖥 사이트에서 ${sid ? `[${labelOf(sid)}] ` : ''}${ph === 'nxt' ? 'NXT ' : ''}${kind === 'keep' ? '유지' : '정리 ' + nums.join(',')} 선택\n${r}`).catch(() => {});
    return { ok: !!r, reply: r || '처리할 수 없는 요청입니다.' };
  }
  /* 단계 버튼(사이트): select 후보 선정 → (알림까지 이어서) · notice 알림 · judge 종가 판정 · convert 이월 전환. 예정 시각과 무관하게 지금 실행 */
  async function siteStage(stage, sid) {
    const { date, min } = kstParts();
    if (!isTradingDay(date)) return { ok: false, reply: '휴장일이에요.' };
    if (!sid) return { ok: false, reply: '전략을 정해 주세요.' };
    const run = await readRun(date, sid).catch(() => null), P = (run && run.payload) || {};
    const log = async t => { await D.sendTelegram(`🖥 사이트에서 [${labelOf(sid)}] ${t}`).catch(() => {}); };
    if (stage === 'select') {
      if (min >= 920) return { ok: false, reply: '장 마감이 가까워(15:20 이후) 새로 고르지 않아요.' };
      if (run && (P.decision && P.decision.kind && P.decision.kind !== 'expired' || Object.keys(P.orders || {}).length)) return { ok: false, reply: '이미 승인·주문이 진행돼 다시 고를 수 없어요.' };
      const r = await runSelection(true, sid);
      if (!r || !r.ok) return { ok: false, reply: (r && r.why) || '후보를 고르지 못했어요.' };
      state.runs[sid] = await readRun(date, sid).catch(() => null) || state.runs[sid];
      const n = await sendNoticeFor(sid, true).catch(e => ({ ok: false, err: e.message }));   // 다음 단계(알림)까지 바로
      await log('후보 선정 → 알림 전송');
      return { ok: true, reply: `후보 ${r.picks != null ? r.picks + '개' : ''}를 고르고 텔레그램 알림까지 보냈어요. 아래에서 승인하세요.${n && n.ok === false ? ' (알림 전송 실패)' : ''}` };
    }
    if (stage === 'notice') {
      if (!run) return { ok: false, reply: '먼저 후보를 골라야 해요.' };
      const n = await sendNoticeFor(sid, true);
      await log('알림 다시 전송');
      return { ok: true, reply: n.sent ? '텔레그램 알림을 보냈어요.' : '보낼 알림이 없어요.' };
    }
    if (stage === 'judge' || stage === 'judgeN') {
      if (!HAS) return { ok: false, reply: '매매 엔진이 꺼져 있어요.' };
      const nx = stage === 'judgeN', E0 = nx ? P.eodN : P.eod;
      if (E0 && E0.at) return { ok: false, reply: '이미 판정했어요.' };
      if (nx && min < 940) return { ok: false, reply: 'NXT 애프터마켓 시세가 열리는 15:40 이후에 판정할 수 있어요.' };
      const r = await eodFor(sid).judge(date, nx ? 'nxt' : 'reg');
      await log(nx ? 'NXT 종가 판정 실행' : '종가 판정 실행');
      return { ok: !!(r && r.ok), reply: r && r.ok ? `판정했어요: ${r.n}종목 중 약함 ${r.weak}.${r.other ? ` (${nx ? '정규장' : 'NXT'} 종목 ${r.other}개는 ${nx ? '앞서' : '19시에'} 판정)` : ''} 약한 종목이 있으면 아래에서 정리/유지를 정하세요.` : '판정하지 못했어요.' };
    }
    if (stage === 'convert') {
      if (!HAS) return { ok: false, reply: '매매 엔진이 꺼져 있어요.' };
      if (P.carryDone) return { ok: false, reply: '이미 이월 전환했어요.' };
      if ([P.eod, P.eodN].some(E => E && (E.weak || []).length && !E.decision)) return { ok: false, reply: '약한 종목 정리·유지를 먼저 정해 주세요.' };
      const c = await eodFor(sid).convert(date);
      await log('이월 전환 실행');
      return { ok: !!(c && c.ok), reply: c && c.ok ? `이월 전환했어요(${c.n || 0}종목).` : '전환하지 못했어요.' };
    }
    return { ok: false, reply: '알 수 없는 단계예요.' };
  }

  /* 전략 조회·저장·추가·삭제(컨트롤 타워) */
  /* 실전매매 전략 ↔ 가상 원본: 원본에서 가져오는 조건(매수·매도·선정 규칙)과 가져오지 않는 값(실행 모드·금액·실전 안전장치 — 쪽마다 따로 정함) */
  const OWN_KEYS = new Set(['execMode', 'liveAutoOk', 'dryDays', 'sizeMode', 'sizePct', 'paperCapitalKrw', 'minOrderKrw', 'maxOrdersDay', 'rejectStop', 'unsureStop', 'perStockKrw', 'totalCapKrw']);
  const ruleParams = p => Object.fromEntries(Object.entries(p || {}).filter(([k]) => !OWN_KEYS.has(k)));
  function sourceDiffOf(cur, src) {
    if (!cur || !src || cur.kind !== src.kind) return null;
    return ST.diff(cur.kind, ruleParams(cur.params), ruleParams(src.params)).filter(d => !OWN_KEYS.has(d.key));
  }
  async function strategies() {
    const [list, A] = await Promise.all([store.list(true), actives()]);
    const timesBy = Object.fromEntries([...A.Is.map(I => [I.id, I.T]), [A.C.id, A.CI.T]]);
    const T0 = A.CI.T;
    const byId = Object.fromEntries(list.map(r => [r.id, r]));
    const dryBy = {}; for (const r of list) if (!r.archived && r.params && r.params.execMode === 'dryrun') dryBy[r.id] = await dryStatus(r.id, r.params).catch(() => null);
    const out = list.map(({ needCopy, ...r }) => {
      const side = ST.sideOfParams(r.params);   // 2026-11-19: 종가베팅도 자기 실행 모드로 쪽이 정해짐
      if (dryBy[r.id]) r = { ...r, dry: dryBy[r.id] };
      if (!r.source) return { ...r, side };
      const src = byId[r.source], d = sourceDiffOf(r, src);
      return { ...r, side, sourceName: src ? src.name : null, sourceGone: !src || !!src.archived, sourceDiff: d ? d.length : null, sourceVersion: src ? src.version : null };
    });
    return { ok: true, missing: store.isMissing(), schema: ST.publicSchema(), strategies: out, ownKeys: [...OWN_KEYS], sourceOk: store.sourceOk ? store.sourceOk() : true,
      active: { intraday: A.Is.map(i => i.id), closing: A.C.id, closingOn: !!A.C.enabled, closingSide: ST.sideOfParams(A.C.params), letters: Object.fromEntries([...A.Is.map(I => [I.id, I.letter]), [A.C.id, A.CI.letter]]) }, times: T0, timesBy };
  }
  /* 원본 변경 확인(화면 "원본 변경 반영" 미리 보기) */
  async function sourceDiff(id) {
    const cur = store.byId ? await store.byId(String(id || '')).catch(() => null) : null;
    if (!cur) return { ok: false, status: 404, error: '전략을 찾을 수 없습니다' };
    if (!cur.source) return { ok: false, status: 400, error: '원본이 연결된 전략이 아닙니다' };
    const src = await store.byId(cur.source).catch(() => null);
    if (!src) return { ok: false, status: 404, error: '원본 전략을 찾을 수 없습니다(삭제됨)' };
    return { ok: true, id: cur.id, source: { id: src.id, name: src.name, version: src.version, archived: !!src.archived }, changes: sourceDiffOf(cur, src), keep: [...OWN_KEYS] };
  }
  /* 원본 변경 반영: 원본의 매수·매도·선정 조건을 가져옴(실행 모드·금액·실전 안전장치는 그대로). 실전 모드면 PIN */
  async function applySource(id, who, opts = {}) {
    const d = await sourceDiff(id);
    if (!d.ok) return d;
    if (!d.changes.length) return { ok: true, unchanged: true, changes: [] };
    const cur = await store.byId(String(id)), src = await store.byId(cur.source);
    if ((cur.params.execMode || 'paper') === 'live' && !opts.pinOk) return { ok: false, status: 403, needPin: true, error: '실전 전략의 조건을 바꾸려면 거래 PIN을 다시 입력하세요' };
    const patch = { params: ruleParams(src.params) };
    const r = await saveStrategy(cur.id, patch, who, { ...opts, confirm: !!opts.confirm });
    return r && r.ok ? { ...r, applied: d.changes, from: { id: src.id, version: src.version } } : r;
  }
  /* E3: 조건값을 바꾸는 저장은 안전장치 점검 — 경고가 있으면 confirm 없이는 저장하지 않고 409 로 돌려줌(화면이 "그래도 저장"을 물음) */
  async function guardWarnings(id, patch) {
    if (!patch || patch.params === undefined || !store.byId || !JR || !JR.raw) return [];
    const cur = await store.byId(id).catch(() => null);
    if (!cur || cur.kind !== 'intraday' && cur.kind !== 'closing') return [];
    if (!ST.diff(cur.kind, cur.params, { ...cur.params, ...patch.params }).length) return [];   // 바뀐 조건이 없으면 점검 안 함
    const [rows, versions] = await Promise.all([JR.raw(id), store.versions(id).catch(() => [])]);
    return PERF.guards({ rows, versions, cur: cur.version, today: kstParts().date });
  }
  /* 실행 모드 전환 규칙(2단계): 진행 중 주문·오늘 산 종목 보유·안 판 이월이 있으면 못 바꿈(주문이 엔진 사이에서 고아가 되지 않게).
     실전으로 바꿀 때는 거래 PIN 재확인(trade.js 가 확인해 opts.pinOk)과 실전 엔진 준비(계좌·실전 스위치)가 필요 */
  async function modeBusy(id) {
    const { date } = kstParts();
    const r = await readRun(date, id).catch(() => null);
    if (r && activeOrders(r)) return '오늘 체결 대기 중인 주문이 있어요';
    const bought = Object.entries((r && r.payload && r.payload.orders) || {}).filter(([, o]) => (o.filled || 0) > 0).map(([c]) => c);
    if (bought.length) {
      const S = await BR.of(id).state().catch(() => null);
      if (!S || !S.ok) return '보유 상태를 확인하지 못했어요';
      if ((S.positions || []).some(x => bought.includes(x.code) && x.qty > 0)) return '오늘 산 종목을 아직 보유 중이에요';
    }
    const c = await readCarry().catch(() => null);
    if (!c) return '이월 상태를 확인하지 못했어요';
    if (Object.values(c.items || {}).some(i => (i.sid || DEF_SID) === id && i.state !== 'done')) return '아직 팔지 않은 이월 종목이 있어요';
    return null;
  }
  async function saveStrategy(id, patch, who, opts = {}) {
    id = String(id || '');
    const nm = patch && patch.params && patch.params.execMode;
    /* 검토 #14: "실전 자동 승인 허용"을 켜는 것도 실전 주문을 사람 확인 없이 내게 하므로 PIN 필요(실전이거나 실전으로 바꾸는 중일 때) */
    if (patch && patch.params && patch.params.liveAutoOk === true && !opts.pinOk) {
      const cur0 = store.byId ? await store.byId(id).catch(() => null) : null, p0 = (cur0 && cur0.params) || {};
      if (!p0.liveAutoOk && (nm || p0.execMode) === 'live') return { ok: false, status: 403, needPin: true, error: '실전 자동 승인을 켜려면 거래 PIN을 다시 입력하세요' };
    }
    let fromMode = null;
    if (nm !== undefined) {
      const cur = store.byId ? await store.byId(id).catch(() => null) : null;
      const from = (cur && cur.params && cur.params.execMode) || 'paper';
      if (cur) fromMode = from;
      if (cur && nm !== from) {
        if (nm === 'live') {
          if (!opts.pinOk) return { ok: false, status: 403, needPin: true, error: '실전 모드로 바꾸려면 거래 PIN을 다시 입력하세요' };
          const lr = D.liveReady ? D.liveReady() : { ok: false, why: '실전 엔진이 연결되지 않았습니다' };
          if (!lr.ok) return { ok: false, status: 409, error: '실전 모드로 바꿀 수 없어요 — ' + lr.why };
        }
        const busy = await modeBusy(id);
        if (busy) return { ok: false, status: 409, error: `실행 모드를 바꿀 수 없어요 — ${busy}. 정리된 뒤(장 마감 후 등) 바꾸세요` };
      }
    }
    const res = await saveStrategy0(id, patch, who, opts);
    if (res && res.ok && res.strategy) { noteMode(res.strategy); if (fromMode !== null && nm !== undefined) await noteDry(id, fromMode, nm); }
    return res;
  }
  async function saveStrategy0(id, patch, who, opts = {}) {
    if (!opts.confirm) {
      const warnings = await guardWarnings(id, patch).catch(() => []);
      if (warnings.length) return { ok: false, status: 409, needConfirm: true, error: '조건을 바꾸기 전에 확인이 필요합니다', warnings };
    }
    return store.save(id, patch, who);
  }
  const strategyVersions = async id => ({ ok: true, versions: await store.versions(String(id || '')) });
  /* 새 전략·복제. 복제본은 절대 실전으로 시작하지 않음(실전 원본이면 드라이런). asLive = "실전용 복제": 드라이런·직접 승인으로 만들어 5거래일 점검 후 PIN 으로 실전 전환 */
  async function createStrategy(body, who) {
    if (!store.create) return { ok: false, status: 503, error: '지원하지 않음' };
    const b = body || {}, src = b.from && store.byId ? await store.byId(String(b.from)).catch(() => null) : null;
    const asLive = b.asLive === true && (!src || src.kind === 'intraday');
    /* "실전에 적용": 가상 원본을 복제해 실전매매(드라이런·꺼짐·직접 승인)으로 만들고 원본을 기억(원본 변경 반영·성과 비교) */
    const link = asLive && !!src && (src.params.execMode || 'paper') === 'paper';
    const r = await store.create({ ...b, linkSource: link, ...(asLive && src && !b.name ? { name: `${src.name} (실전)`.slice(0, 30) } : {}) }, who);
    if (!r || !r.ok || !r.strategy) return r;
    const srcMode = (r.strategy.params && r.strategy.params.execMode) || 'paper';
    const want = asLive ? 'dryrun' : (srcMode === 'live' ? 'dryrun' : srcMode);
    if (want !== srcMode || asLive) {
      const s2 = await store.save(r.strategy.id, { params: { execMode: want, liveAutoOk: false } }, who, { allowSide: true });   // 방금 만든 복제본만 쪽을 정함
      if (s2 && s2.ok) { noteMode(s2.strategy); await noteDry(r.strategy.id, srcMode, want); return { ...r, strategy: s2.strategy, mode: want }; }
      if (srcMode === 'live') {   // 검토 #14: 실전 원본의 복제를 드라이런으로 못 바꿨으면 복제본을 보관 처리(PIN 없이 실전 전략이 생기지 않게)
        if (store.archive) await store.archive(r.strategy.id, who).catch(() => {});
        return { ok: false, status: 503, error: '복제본을 드라이런으로 바꾸지 못해 복제를 취소했습니다. 잠시 뒤 다시 시도하세요' };
      }
    }
    noteMode(r.strategy);
    return r;
  }
  /* 삭제(보관): 오늘 미체결 주문이 있거나 아직 팔지 않은 이월 종목이 있으면 막음 */
  async function deleteStrategy(id, who) {
    const { date } = kstParts();
    const r = await readRun(date, id).catch(() => null);
    if (r && activeOrders(r)) return { ok: false, status: 400, error: '오늘 미체결 주문이 있어 삭제할 수 없습니다' };
    const c = await readCarry().catch(() => ({ items: {} }));
    if (Object.values(c.items || {}).some(i => i.sid === id && i.state !== 'done')) return { ok: false, status: 400, error: '아직 팔지 않은 이월 종목이 있어 삭제할 수 없습니다' };
    return store.archive ? store.archive(id, who) : { ok: false, status: 503, error: '지원하지 않음' };
  }
  /* 서버 추적기용: 켜진 장초 상승 포착 전략의 조건값(없으면 null) */
  /* 눌림목 관찰 목록(화면용): 켜진 눌림목 전략 설정(없으면 기본값)으로 관찰 종목 + 현재 시세 → 평균가 대비 위치. 시세는 20초 캐시 */
  const pwq = { at: 0, key: '', rows: [] };
  async function pullbackWatch() {
    const A = await store.actives().catch(() => null), on = A && A.Is.find(x => x.params && x.params.selector === 'pullback');
    const b = ST.BUILTIN.find(x => x.id === 'pullback-default'), P = on ? on.params : ST.validate('intraday', { ...ST.defaults('intraday'), ...b.preset }).val;
    const { date } = kstParts(), W = await loadPbWatch(P, date);
    if (W.stale) return { ok: true, on: !!on, stale: true, lastD: W.lastD, prevD: W.prevD, rows: [] };
    const codes = [...new Set(W.watch.map(w => w.code))], key = codes.join(',');
    if (codes.length && (pwq.key !== key || Date.now() - pwq.at > 20000)) { pwq.rows = await D.pbQuotes(codes).catch(() => []); pwq.key = key; pwq.at = Date.now(); }
    const qm = new Map(pwq.rows.map(q => [q.code, q])), o = { breakPct: P.pbBreakPct == null ? 1 : +P.pbBreakPct, chasePct: +P.pbChasePct || 6 }, rows = [];
    const gapOf = w => { const q = qm.get(w.code); return q ? (q.price / w.ref - 1) * 100 : null; };
    for (const w of pbPickPerCode(W.watch, gapOf, w => PB.todayBreak(w.ref, qm.get(w.code), o))) {
      const q = qm.get(w.code), gap = gapOf(w);
      const hit = q ? PB.todayBreak(w.ref, q, o) : false;
      rows.push({ code: w.code, name: w.name, barDate: w.barDate, rk: w.rk, w: w.w, chg: w.chg, body: Math.round(w.body * 10) / 10, amtEok: Math.round(w.amtEok), mcEok: Math.round(w.mcEok), ref: Math.round(w.ref), refKind: w.refKind, vw: Math.round(w.ref), age: w.age, dipDate: w.dipDate, minGap: w.minGapPct == null ? null : Math.round(w.minGapPct * 10) / 10,
        smOk: w.sm.ok, smFails: w.sm.fails, sm: w.sm.info, price: q ? q.price : null, dayChg: q ? q.changePct : null, gap: gap == null ? null : Math.round(gap * 10) / 10, hit: hit && (w.sm.ok || P.pbSmGate === false) });
    }
    rows.sort((a, b) => (b.hit - a.hit) || (b.smOk - a.smOk) || (Math.abs(a.gap == null ? 999 : a.gap) - Math.abs(b.gap == null ? 999 : b.gap)));
    return { ok: true, on: !!on, stale: false, lastD: W.lastD, breakPct: o.breakPct, chasePct: o.chasePct, maxAge: +P.pbMaxAge || 63, refKind: P.pbRef === 'vwap' ? 'vwap' : 'open', smGate: P.pbSmGate !== false, rows, at: new Date().toISOString() };
  }
  async function igniteParams() { const A = await store.actives().catch(() => null); const I = A && A.Is.find(x => x.params && x.params.selector === 'ignite'); return I ? I.params : null; }
  return { pullbackWatch, igniteParams, tick, runSelection, sendNotice, handleApproval, handleEod, status, uiState, setConfig, strategies, saveStrategy, strategyVersions, createStrategy, deleteStrategy, setHalt, haltLevel, modeOf: sid => BR.execOf(sid), siteApprove, siteEod, siteOrderEdit, pendingAutoBuy, autoOrderCode, deskOk,
    daylogList: (n, side) => DL.list(n, side), daylogGet: (d, side) => DL.get(d, side), daylogMemo: (d, t) => DL.memo(d, t), daylogSave: d => DL.save(/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : kstParts().date, { force: true }), siteStage, journalList: q => JR.list(q), journalGet: (d, sid) => JR.get(d, sid), journalCompare: q => JR.compare(q), journalMemo: (d, sid, t) => JR.memo(d, sid, t), journalRun: d => JR.run(d, kstParts().date), journal: JR,
    sourceDiff, applySource, kindsInUse: () => BR.kindsInUse(),
    _select: select, _mutateRun: mutateRun, _readRun: readRun, _readRuns: readRuns, _readCarry: readCarry, _exec: exec };
}

module.exports = { regimeMult, regimeLine, REGIME_KO, RULES, EXCL_NAME, baseFilter, evalFlow, scoreOne, rankAndPick, formatMessage, parseApproval, parseCmdMulti, createAuto };
