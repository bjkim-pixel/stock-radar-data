// ============================================================================
// KIS 실시간 시세 릴레이 서버 + 텔레그램 알림
// ============================================================================
// 역할:
//   1) 한국투자증권(KIS) 실전투자 웹소켓에 접속해서 실시간 체결가를 받아오고,
//      프론트엔드(index.html)가 이 서버 /ws 에 붙어서 원하는 종목의 실시간
//      시세를 받아볼 수 있도록 중계
//   2) Supabase의 "보유 중"(positions, status=OPEN) 종목을 주기적으로 조회해서
//      프론트엔드가 열려있지 않아도 항상 그 종목들을 KIS에 구독해두고,
//      아래 조건을 감지하면 텔레그램으로 알림을 보냄:
//        - 당일 신고가/신저가 갱신
//        - 트레일링 손절(-7%) 근접(-5%↓)/도달(-7%↓)
//        - 텔레그램 명령으로 지정한 목표가 도달
//   3) 텔레그램 봇에 "/목표가 종목코드(또는 보유 종목명) 가격" 같은 명령을 보내면 목표가를
//      등록/삭제/조회할 수 있음 (long polling, 별도 웹훅 서버 불필요)
//
// 환경변수(.env 또는 Render 대시보드에 등록):
//   KIS_APP_KEY        - 실전투자 App Key (필수)
//   KIS_APP_SECRET     - 실전투자 App Secret (필수)
//   TELEGRAM_BOT_TOKEN - 텔레그램 봇 토큰 (BotFather 발급)
//   TELEGRAM_CHAT_ID   - 알림을 받을 chat_id (없으면 봇에 아무 메시지나 보낸 뒤
//                        서버 로그에서 chat_id를 확인해서 등록)
//   SUPABASE_URL / SUPABASE_ANON_KEY - 기본값이 stock-radar 것으로 이미 채워져
//                        있음 (읽기 전용 public anon key라 노출돼도 안전)
//   PORT               - (Render가 자동 주입, 기본 3000)
//   ALLOWED_ORIGIN     - 프론트엔드 도메인 (콤마로 여러개 가능)
// ============================================================================

const http = require('http');
const WebSocket = require('ws');
const webpush = require('web-push');

const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://bjkim-pixel.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://frurnmrwuopvttoqdvgj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZydXJubXJ3dW9wdnR0b3FkdmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5MDEwMDIsImV4cCI6MjEwMjQ3NzAwMn0.rf49NKE9vLLNNODp6ZBsmEYkr1ar3sZ6ViH65MF5jHc';
// service_role 키 — 목표가(alert_targets)·푸시 구독(push_subscriptions) 쓰기 전용.
// RLS를 우회하므로 절대 프론트엔드에는 넣지 말고 Render 환경변수로만 보관.
// 없으면 목표가는 메모리에만 저장되고(재배포 시 초기화) 경고만 남김.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// 웹푸시(PWA 앱 알림)용 VAPID 키 쌍. 공개키는 프론트엔드(web/index.html)에도
// 그대로 박혀 있음(노출돼도 안전). 비밀키는 반드시 Render 환경변수로만 보관.
// 둘 다 없으면 웹푸시는 꺼진 채로 시작하고 텔레그램만 계속 동작함.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ||
  'BOnRw7DbgYaGmAYE5xh9D6S51qZMU0rS5LEWszmb9FZQ8txQLri0RYOB4MCJbFmH2owPbmqiL1uX_OqZakHFmSE';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://bjkim-pixel.github.io/stock-radar-data/';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[push] VAPID_PRIVATE_KEY 미설정 — 웹푸시(앱 알림)는 꺼진 채로 시작합니다(텔레그램은 정상 동작).');
}

// 실전투자 도메인 (모의투자로 바꾸려면 openapivts.../ops.../31000 로 교체)
const KIS_REST_BASE = 'https://openapi.koreainvestment.com:9443';
const KIS_WS_URL = 'ws://ops.koreainvestment.com:21000';

if (!KIS_APP_KEY || !KIS_APP_SECRET) {
  console.error('[FATAL] KIS_APP_KEY / KIS_APP_SECRET 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[telegram] TELEGRAM_BOT_TOKEN 미설정 — 텔레그램 알림 기능이 꺼진 채로 시작합니다.');
}

const fmt = n => (n == null || !Number.isFinite(+n)) ? '–' : Math.round(+n).toLocaleString('ko-KR');
const KST_TZ = 'Asia/Seoul';
const kstDateStr = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: KST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// ----------------------------------------------------------------------------
// 상태
// ----------------------------------------------------------------------------
let approvalKey = null;
let approvalKeyIssuedAt = 0;
let kisWs = null;
let kisWsReady = false;
let reconnectAttempt = 0;

const subscribers = new Map();   // code -> Set(clientWs) : 프론트엔드가 요청한 구독
const lastPrice = new Map();     // code -> 마지막 시세 (신규 구독 시 즉시 전달용)
const currentKisSubs = new Set(); // 지금 KIS에 실제로 등록해둔 코드(H0STCNT0, 체결가)
const currentProgramTradeSubs = new Set(); // 지금 KIS에 실제로 등록해둔 코드(H0STPGM0, 프로그램매매)

const heldCodes = new Set();        // "보유 중" 종목 코드 (Supabase에서 주기적으로 갱신)
const positionsByCode = new Map();  // code -> {avg_price, peak_price}
const codeNames = new Map();        // code -> 종목명
const targetPrices = new Map();     // code -> {price} (텔레그램 명령으로 설정)
const alertState = new Map();       // code -> {date, high, low, alertedHigh, alertedLow, trailNear, trailHit, targetHit}

// 신고가/신저가 알림 스팸 방지: 마지막으로 "알림을 보낸" 고점/저점 대비 이 비율(%) 이상
// 갱신됐을 때만 다시 알림. 트레일링 손절 계산은 이 값과 무관하게 실제 당일 고점(st.high)을 그대로 씀.
const ALERT_MIN_MOVE_PCT = 1;

// 텔레그램 /알림끄기, /알림켜기 로 켜고 끄는 전역 스위치.
// 꺼져 있는 동안은 신고가/신저가·트레일링 손절·목표가 알림만 멈추고,
// "오늘의 종목" 요약(자동/수동)은 이 스위치와 무관하게 계속 발송됨.
let alertsPaused = false;

// ----------------------------------------------------------------------------
// 1) approval_key 발급/재발급
// ----------------------------------------------------------------------------
async function issueApprovalKey() {
  const res = await fetch(`${KIS_REST_BASE}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: KIS_APP_KEY,
      secretkey: KIS_APP_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`approval_key 발급 실패: ${res.status} ${text}`);
  }
  const json = await res.json();
  if (!json.approval_key) {
    throw new Error(`approval_key 응답에 값이 없음: ${JSON.stringify(json)}`);
  }
  approvalKey = json.approval_key;
  approvalKeyIssuedAt = Date.now();
  console.log('[approval_key] 발급 완료');
  return approvalKey;
}

const APPROVAL_KEY_REFRESH_MS = 12 * 60 * 60 * 1000;
setInterval(() => {
  console.log('[approval_key] 정기 재발급 + 웹소켓 재연결');
  issueApprovalKey()
    .then(() => reconnectKisWs())
    .catch(err => console.error('[approval_key] 재발급 실패:', err.message));
}, APPROVAL_KEY_REFRESH_MS);

// ----------------------------------------------------------------------------
// 2) KIS 웹소켓 연결 + 구독 관리 (구독 대상 = 보유 종목 ∪ 프론트엔드 요청 종목)
// ----------------------------------------------------------------------------
function wantedCodes() {
  const w = new Set(heldCodes);
  for (const code of subscribers.keys()) w.add(code);
  for (const code of sangttaCandidates) w.add(code);
  for (const code of sangttaOpenPositions.keys()) w.add(code);
  return w;
}

function reconcileKisSubscriptions() {
  const want = wantedCodes();
  for (const code of want) {
    if (!currentKisSubs.has(code)) {
      currentKisSubs.add(code);
      sendKisSubscribe(code, true);
      console.log('[구독 추가]', code);
    }
  }
  for (const code of [...currentKisSubs]) {
    if (!want.has(code)) {
      currentKisSubs.delete(code);
      sendKisSubscribe(code, false);
      lastPrice.delete(code);
      console.log('[구독 해제]', code);
    }
  }
}

function connectKisWs() {
  kisWs = new WebSocket(KIS_WS_URL);
  kisWsReady = false;

  kisWs.on('open', () => {
    console.log('[KIS WS] 연결됨');
    kisWsReady = true;
    reconnectAttempt = 0;
    currentKisSubs.clear();          // 새 연결이라 KIS 쪽엔 아무것도 등록 안 된 상태
    currentProgramTradeSubs.clear();
    reconcileKisSubscriptions();
    reconcileProgramTradeSubscriptions();
  });

  kisWs.on('message', (raw) => {
    handleKisMessage(raw.toString('utf-8'));
  });

  kisWs.on('close', (code, reason) => {
    kisWsReady = false;
    console.warn(`[KIS WS] 연결 종료 (code=${code}, reason=${reason}) — 재연결 예약`);
    scheduleReconnect();
  });

  kisWs.on('error', (err) => {
    console.error('[KIS WS] 에러:', err.message);
  });
}

function scheduleReconnect() {
  reconnectAttempt += 1;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
  setTimeout(() => connectKisWs(), delay);
}

function reconnectKisWs() {
  try { kisWs && kisWs.close(); } catch (_) {}
  setTimeout(() => connectKisWs(), 500);
}

// tr_type: '1' = 등록(구독), '2' = 해지. trId를 인자로 받도록 일반화해서
// H0STCNT0(체결가) 뿐 아니라 H0STPGM0(프로그램매매) 구독/해지에도 재사용.
function sendKisSubscribe(code, subscribe, trId = 'H0STCNT0') {
  if (!kisWsReady || !approvalKey) return;
  const msg = {
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: subscribe ? '1' : '2',
      'content-type': 'utf-8',
    },
    body: { input: { tr_id: trId, tr_key: code } },
  };
  kisWs.send(JSON.stringify(msg));
}

const F_CODE = 0, F_TIME = 1, F_PRICE = 2, F_SIGN = 3, F_DIFF = 4, F_RATE = 5;
// H0STCNT0(주식체결) 전체 필드 — 상따 엔진이 체결강도/순간체결금액/거래대금을
// 계산하려면 앞 6개 필드만으로는 부족해서 추가로 씀 (KIS 공식 필드 순서).
const F_HIGH = 8, F_CNTG_VOL = 12, F_ACML_AMT = 14, F_CTTR = 18;

// ----------------------------------------------------------------------------
// 3-C) 프로그램매매(H0STPGM0) 실시간 구독 — 상따 매수 조건 신호
// ----------------------------------------------------------------------------
// 2026-09-09: 기존엔 "실제로 포지션을 보유 중인" 종목에만 구독을 걸었으나(구독
// 슬롯 절약 목적), 후보 단계에서도 순매수 흐름을 보고 싶다는 요청으로 후보
// 전체 + 보유 종목까지 구독 대상을 넓힘. 같은 날 추적 슬롯 수를
// SANGTTA_MAX_TRACKED로 줄여둔 만큼 구독 슬롯 부족 문제는 크게 줄었지만,
// 혹시 부족해지면 서버 로그의 "[프로그램매매 구독 추가/해제]" 빈도를 보고
// SANGTTA_MAX_TRACKED를 더 줄이는 방향으로 조정할 것.
const KIS_PROGRAM_TRADE_TR_ID = 'H0STPGM0';
const SANGTTA_PROGRAM_TRADE_WINDOW_MS = 2 * 60 * 1000; // "최근 2분" 순매수 합산 윈도우(기존 5분→단축)

// H0STPGM0 응답 Body 필드 순서(KIS Developers 포털 확정본).
// ⚠ NTBY_CNQN/NTBY_TR_PBMN엔 ACML_(누적) 접두어가 없음 — H0STCNT0의
//   CNTG_VOL(틱당,접두어없음) vs ACML_VOL(누적,ACML_ 접두어) 네이밍 패턴과
//   같다고 보고 일단 "이번 체결 건 단독 값"으로 구현했음. 월요일 장 시작
//   직후 실제 tick 로그("[프로그램매매 검증]")로 재검증 필요 — 만약 누적치로
//   밝혀지면 updateProgramTradeStats()의 합산 로직만 델타 계산으로 바꾸면 됨.
const P_CODE = 0, P_TIME = 1, P_SELN_CNQN = 2, P_SELN_AMT = 3,
      P_SHNU_CNQN = 4, P_SHNU_AMT = 5, P_NTBY_CNQN = 6, P_NTBY_AMT = 7,
      P_SELN_RSQN = 8, P_SHNU_RSQN = 9, P_WHOL_NTBY_QTY = 10;

const sangttaProgramStats = new Map();     // code -> { ticks: [{t, ntbyCnqn, ntbyAmt}] }
const programTradeVerifyLogged = new Map(); // code -> 검증 로그 출력 횟수(종목당 최대 3회)

function programTradeWantedCodes() {
  const w = new Set(sangttaCandidates);
  for (const code of sangttaOpenPositions.keys()) w.add(code);
  return w;
}

function reconcileProgramTradeSubscriptions() {
  const want = programTradeWantedCodes();
  for (const code of want) {
    if (!currentProgramTradeSubs.has(code)) {
      currentProgramTradeSubs.add(code);
      sendKisSubscribe(code, true, KIS_PROGRAM_TRADE_TR_ID);
      console.log('[프로그램매매 구독 추가]', code);
    }
  }
  for (const code of [...currentProgramTradeSubs]) {
    if (!want.has(code)) {
      currentProgramTradeSubs.delete(code);
      sendKisSubscribe(code, false, KIS_PROGRAM_TRADE_TR_ID);
      sangttaProgramStats.delete(code);
      programTradeVerifyLogged.delete(code);
      console.log('[프로그램매매 구독 해제]', code);
    }
  }
}

function getProgramStats(code) {
  let st = sangttaProgramStats.get(code);
  if (!st) { st = { ticks: [] }; sangttaProgramStats.set(code, st); }
  return st;
}

// 프로그램매매 틱 1건을 반영하고 최근 5분 윈도우로 정리.
function updateProgramTradeStats(code, ntbyCnqn, ntbyAmt, now) {
  const st = getProgramStats(code);
  st.ticks.push({ t: now, ntbyCnqn, ntbyAmt });
  const cutoff = now - SANGTTA_PROGRAM_TRADE_WINDOW_MS;
  while (st.ticks.length && st.ticks[0].t < cutoff) st.ticks.shift();
}

// 프론트/스냅샷용 — 최근 SANGTTA_PROGRAM_TRADE_WINDOW_MS(2분)간 순매수거래대금
// 합계, 마지막 틱 값 등을 반환. 아직 틱이 한 번도 없었으면(프로그램매매
// 자체가 없는 종목) null.
function getProgramTradeSnapshot(code) {
  const st = sangttaProgramStats.get(code);
  if (!st || !st.ticks.length) return null;
  const netBuyAmt = st.ticks.reduce((a, x) => a + x.ntbyAmt, 0);
  const netBuyQty = st.ticks.reduce((a, x) => a + x.ntbyCnqn, 0);
  const last = st.ticks[st.ticks.length - 1];
  return {
    netBuyAmt,
    netBuyQty,
    lastNtbyAmt: last.ntbyAmt,
    lastTickAt: last.t,
    tickCount: st.ticks.length,
  };
}

// handleKisMessage에서 trId==='H0STPGM0'일 때 호출.
function handleProgramTradeMessage(countStr, dataStr) {
  const count = parseInt(countStr, 10) || 1;
  const fields = dataStr.split('^');
  const perRecord = Math.floor(fields.length / count);
  if (perRecord <= 0) return;

  for (let i = 0; i < count; i++) {
    const rec = fields.slice(i * perRecord, (i + 1) * perRecord);
    const code = rec[P_CODE];
    if (!code) continue;
    const ntbyCnqn = Number(rec[P_NTBY_CNQN]);
    const ntbyAmt = Number(rec[P_NTBY_AMT]);
    if (!Number.isFinite(ntbyAmt)) continue;
    const now = Date.now();

    // 검증용 로그 — 종목당 처음 3틱만. 값이 계속 커지기만 하면 "누적치",
    // 오르내리면 "틱당 값" — 월요일에 이 로그로 확인.
    const seenCount = programTradeVerifyLogged.get(code) || 0;
    if (seenCount < 3) {
      console.log(`[프로그램매매 검증] ${code} tick#${seenCount + 1} NTBY_CNQN=${rec[P_NTBY_CNQN]} NTBY_TR_PBMN=${rec[P_NTBY_AMT]}`);
      programTradeVerifyLogged.set(code, seenCount + 1);
    }

    updateProgramTradeStats(code, ntbyCnqn, ntbyAmt, now);
    // 별도 즉시 브로드캐스트는 하지 않음 — 프로그램매매 틱은 가격 틱보다 훨씬
    // 드물어서, 다음 H0STCNT0 가격 틱이 올 때 sangttaLiveSnapshot()이 최신
    // 통계를 실어 그대로 보내준다.
  }
}

// ----------------------------------------------------------------------------
// 3-A2) 전략성과2(상따) 후보 발굴 엔진 — PRE_MARKET/NXT/REGULAR/SCAN
// ----------------------------------------------------------------------------
// GitHub Actions(intraday_sangtta_candidates.yml + 66_intraday_candidates.py)를
// 완전히 대체합니다. 로직은 66_intraday_candidates.py와 1:1로 동일하니 각 단계의
// 설계 근거(왜 등락률순위 API를 쓰는지, NXT market_div="NX" 미검증 이슈 등)는
// 그 파일 상단 주석을 참고하세요. 차이점은 딱 하나 — SCAN 주기를 GitHub Actions
// cron의 5분에서 1분으로 단축했습니다(상따는 초단타라 종목 편입/이탈을 더 빠르게
// 반영해야 한다는 요청). 이 서버는 이미 상시 실행 중인 프로세스라 GitHub Actions
// 무료 사용량(월 2,000분)과 완전히 무관하게 동작합니다.
const KIS_REST_RATE_MIN_INTERVAL_MS = 70; // 초당 약 14회 — 04_backfill.py RateLimiter(15)와 동급
let _kisRestLastCall = 0;
async function kisRestThrottle() {
  const wait = KIS_REST_RATE_MIN_INTERVAL_MS - (Date.now() - _kisRestLastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _kisRestLastCall = Date.now();
}

let kisAccessToken = null;
let kisAccessTokenExpiresAt = 0; // ms epoch

// KIS REST API(tr_id 기반 시세/랭킹 조회)용 access_token. approval_key(웹소켓
// 전용, /oauth2/Approval)와는 별개 발급 경로(/oauth2/tokenP)라 따로 관리합니다.
// 앱키당 발급 빈도 제한이 있어 만료 10분 전까지는 재사용합니다(기본 유효기간 24시간).
async function getKisRestToken() {
  if (kisAccessToken && Date.now() < kisAccessTokenExpiresAt - 10 * 60 * 1000) return kisAccessToken;
  const res = await fetch(`${KIS_REST_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET }),
  });
  if (!res.ok) throw new Error(`KIS REST 토큰 발급 실패: ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  if (!json.access_token) throw new Error(`KIS REST 토큰 응답에 값 없음: ${JSON.stringify(json)}`);
  kisAccessToken = json.access_token;
  kisAccessTokenExpiresAt = Date.now() + (Number(json.expires_in) || 86400) * 1000;
  console.log('[상따후보] KIS REST 토큰 발급 완료');
  return kisAccessToken;
}

function kisRestHeaders(token, trId) {
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: KIS_APP_KEY,
    appsecret: KIS_APP_SECRET,
    tr_id: trId,
    custtype: 'P',
  };
}

function safeNum(v, d = 0) {
  if (v == null) return d;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-') return d;
  const n = Number(s);
  return Number.isFinite(n) ? n : d;
}

// FHKST01010100 (주식현재가 시세). marketDiv="NX"는 NXT 시도용 — 66_intraday_candidates.py와
// 동일하게 실거래 미검증 상태이니 최초 NXT 개장 시간대 로그(snapshot.market_div_tried)를 확인하세요.
async function fetchKisPrice(code, marketDiv = 'J') {
  await kisRestThrottle();
  try {
    const token = await getKisRestToken();
    const url = `${KIS_REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=${marketDiv}&FID_INPUT_ISCD=${code}`;
    const res = await fetch(url, { headers: kisRestHeaders(token, 'FHKST01010100') });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.rt_cd !== '0') return null;
    return json.output || null;
  } catch (err) {
    console.error(`[상따후보] ${code} 시세 조회 실패(${marketDiv}):`, err.message);
    return null;
  }
}

// FHPST01700000 (국내주식 등락률 순위, 상승율순) — SCAN 단계 전용. 거래대금순위가
// 아니라 등락률순위를 쓰는 이유는 66_intraday_candidates.py 상단 주석 참고
// (시가총액 큰 종목이 거래대금 상위를 독점하는 문제를 피하기 위함).
// 2026-09-10: 5.0% 기준으로는 09:15~정오까지 KIS 등락률순위 응답이 계속
// 0건이라(로그 확인 결과 오류가 아니라 "조건 만족 종목 없음"으로 판단됨),
// 상따가 데이 트레이딩인 점을 감안해 3.0%로 낮춤. stageScan()의 진단
// 로그(바로 아래 ranked.length===0 분기)로 이후에도 0건이 반복되는지
// 계속 관찰 가능.
const SCAN_MIN_CHANGE_PCT = 3.0, SCAN_MIN_PRICE = 1000, SCAN_MIN_VOL = 10000;
const PREFERRED_OR_SPAC_RE = /(\d?우[A-Z]?$|스팩|기업인수목적)/;

async function fetchChangeRateRank(limit = 30) {
  await kisRestThrottle();
  try {
    const token = await getKisRestToken();
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20170', FID_INPUT_ISCD: '0000',
      FID_RANK_SORT_CLS_CODE: '0', FID_INPUT_CNT_1: '0', FID_PRC_CLS_CODE: '0',
      FID_INPUT_PRICE_1: String(SCAN_MIN_PRICE), FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: String(SCAN_MIN_VOL), FID_TRGT_CLS_CODE: '0',
      FID_TRGT_EXLS_CLS_CODE: '0000000000', FID_DIV_CLS_CODE: '0',
      FID_RSFL_RATE1: String(SCAN_MIN_CHANGE_PCT), FID_RSFL_RATE2: '',
    });
    // KIS 공식 샘플(koreainvestment/open-trading-api examples_user/domestic_stock_functions.py
    // fluctuation() 함수, [v1_국내주식-088])을 확인해보니 실제 엔드포인트가
    // /quotations/fluctuation-rank가 아니라 /ranking/fluctuation 이었음 — 이 오타 때문에
    // 계속 404가 나서 SCAN 단계가 하루종일 스킵되고 있었음(2026-09-08 발견·수정).
    // FID_RANK_SORT_CLS_CODE는 공식 샘플 docstring엔 "0000"으로 나오지만 실제 호출해보니
    // "ERROR INVALID INPUT_FILED_SIZE [FID_RANK_SORT_CLS_CODE] [4]"로 거부됨 — 한 자리
    // 코드("0"=등락률상위)가 맞는 것으로 확인되어 원래 값으로 되돌림.
    const res = await fetch(`${KIS_REST_BASE}/uapi/domestic-stock/v1/ranking/fluctuation?${params}`, {
      headers: kisRestHeaders(token, 'FHPST01700000'),
    });
    if (!res.ok) { console.warn(`[상따후보] SCAN 등락률순위 응답코드 ${res.status} — 스킵`); return []; }
    const json = await res.json();
    if (json.rt_cd !== '0') { console.warn(`[상따후보] SCAN 등락률순위 rt_cd=${json.rt_cd} msg=${json.msg1} — 파라미터 재검증 필요, 스킵`); return []; }
    return (json.output || []).slice(0, limit);
  } catch (err) {
    console.error('[상따후보] SCAN 등락률순위 조회 실패:', err.message);
    return [];
  }
}

// ── 임시 진단용(2026-09-10) ──────────────────────────────────────────────
// 에스투더블유(488280)처럼 하루 종일 완만히 오른 종목을, 제안한 SCAN
// 모멘텀 규칙(3분 연속 상승 + 3분 누적 1%p↑)으로 재구성해서 검증하기 위해
// KIS 주식당일분봉조회(FHKST03010200)로 1분봉 이력을 가져옴. 분석 끝나면
// 이 함수와 /debug/minute-chart 엔드포인트는 제거할 예정 — 상시 기능 아님.
// hour(HHMMSS) 기준 최대 30건을 그 이전 시각 순으로 반환하는 API라, 하루
// 전체(09:00~15:30)를 보려면 여러 번 호출해서 이어붙여야 함.
async function fetchMinuteChart(code, hour) {
  await kisRestThrottle();
  const token = await getKisRestToken();
  const params = new URLSearchParams({
    FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
    FID_INPUT_HOUR_1: hour, FID_PW_DATA_INCU_YN: 'Y',
  });
  const res = await fetch(`${KIS_REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params}`, {
    headers: kisRestHeaders(token, 'FHKST03010200'),
  });
  return res.json();
}

// intraday_candidates UPSERT — PostgREST on_conflict+merge-duplicates로
// SQL의 "ON CONFLICT (trade_date, code, source) DO UPDATE"와 동등하게 동작.
// created_at을 매번 명시적으로 채우는 이유: refreshSangttaCandidates()가
// "최근 갱신순" 정렬에 의존하는데, merge-duplicates UPDATE 경로에는 DB 기본값이
// 자동 적용되지 않기 때문(INSERT 시에만 default now()가 붙음).
async function upsertCandidates(rows, source) {
  if (!rows.length) { console.log(`[상따후보] ${source}: 후보 없음 — 저장 생략`); return; }
  const today = kstDateStr();
  const nowIso = new Date().toISOString();
  const payload = rows.map(r => ({
    trade_date: today, code: r.code, source, rank: r.rank, snapshot: r.snapshot, created_at: nowIso,
  }));
  try {
    await sbWrite('intraday_candidates?on_conflict=trade_date,code,source', 'POST', payload);
    console.log(`[상따후보] ${source}: ${rows.length}건 저장 완료`);
  } catch (err) {
    console.error(`[상따후보] ${source} 저장 실패:`, err.message);
  }
}

async function fetchCandidateCodesBySource(sources) {
  const today = kstDateStr();
  const rows = await sbGet(`intraday_candidates?select=code&trade_date=eq.${today}&source=in.(${sources.join(',')})`);
  return [...new Set(rows.map(r => r.code))];
}

async function fetchAllKnownCandidateCodes() {
  const today = kstDateStr();
  const rows = await sbGet(`intraday_candidates?select=code&trade_date=eq.${today}`);
  return new Set(rows.map(r => r.code));
}

const CANDIDATE_POOL_LIMIT = 40, CANDIDATE_TOP_N = 10, SCAN_TOP_N = 15;
const SCAN_START_MIN = 9 * 60 + 15, SCAN_END_MIN = 15 * 60 + 20; // 09:15~15:20 KST

// ── 1) PRE_MARKET — 순수 DB 기반(전략3단계 신호 + 무게상위), API 불필요 ──────
async function stagePreMarket() {
  const latestRows = await sbGet('signals?select=trade_date&signal_type=like.V4_CAND_*&order=trade_date.desc&limit=1');
  const latest = latestRows[0]?.trade_date;
  if (!latest) { console.log('[상따후보] PRE_MARKET: V4_CAND_* 신호가 없음 — 후보 생성 불가'); return; }

  const [trendRows, weightRows] = await Promise.all([
    sbGet(`signals?select=code,signal_type,score,reason&trade_date=eq.${latest}&signal_type=in.(V4_CAND_TREND_3,V4_CAND_CLOSEBET_3)`),
    sbGet(`daily_metrics?select=code,weight_rank,pick_score&trade_date=eq.${latest}&weight_rank=not.is.null&order=weight_rank.asc&limit=${CANDIDATE_TOP_N}`),
  ]);

  const codes = new Set([...trendRows.map(r => r.code), ...weightRows.map(r => r.code)]);
  const nameOf = new Map();
  if (codes.size) {
    const nameRows = await sbGet(`stocks?select=code,name&code=in.(${[...codes].join(',')})`);
    nameRows.forEach(r => nameOf.set(r.code, r.name));
  }

  const merged = new Map();
  for (const r of trendRows) {
    const m = merged.get(r.code) || { code: r.code, name: nameOf.get(r.code) || null, sources: [], score: null };
    m.sources.push(r.signal_type);
    m.reason = r.reason;
    if (r.score != null) m.score = Math.max(m.score ?? 0, +r.score);
    merged.set(r.code, m);
  }
  for (const r of weightRows) {
    const m = merged.get(r.code) || { code: r.code, name: nameOf.get(r.code) || null, sources: [], score: null };
    m.sources.push(`WEIGHT_TOP10(#${r.weight_rank})`);
    m.weight_rank = r.weight_rank;
    m.pick_score = r.pick_score != null ? +r.pick_score : null;
    merged.set(r.code, m);
  }

  const ordered = [...merged.values()].sort((a, b) => {
    const as = a.score ?? -1, bs = b.score ?? -1;
    if (as !== bs) return bs - as;
    return (a.weight_rank ?? 999) - (b.weight_rank ?? 999);
  });

  const rows = ordered.map((m, i) => ({
    code: m.code,
    rank: i + 1,
    snapshot: {
      name: m.name, base_date: latest, sources: m.sources,
      score: m.score ?? null, weight_rank: m.weight_rank ?? null, pick_score: m.pick_score ?? null,
    },
  }));
  console.log(`[상따후보] PRE_MARKET: 기준일 ${latest}, 전략3단계 ${trendRows.length}건 + 무게상위 ${weightRows.length}건 → 유니크 ${rows.length}건`);
  await upsertCandidates(rows, 'PRE_MARKET');
}

// ── 2) NXT (08:00~08:45) ────────────────────────────────────────────────────
async function stageNxt() {
  const pool = (await fetchCandidateCodesBySource(['PRE_MARKET'])).slice(0, CANDIDATE_POOL_LIMIT);
  if (!pool.length) { console.log('[상따후보] NXT: PRE_MARKET 후보가 없어 조회 유니버스가 비어있음 — 스킵'); return; }

  const scored = [];
  for (const code of pool) {
    const out = await fetchKisPrice(code, 'NX');
    if (!out) continue;
    scored.push({ code, change_pct: safeNum(out.prdy_ctrt), price: safeNum(out.stck_prpr) });
  }
  if (!scored.length) { console.log('[상따후보] NXT: 유효 응답 없음(market_div=NX 파라미터 재검증 필요) — 스킵'); return; }

  scored.sort((a, b) => b.change_pct - a.change_pct);
  const top = scored.slice(0, CANDIDATE_TOP_N);
  const rows = top.map((r, i) => ({ code: r.code, rank: i + 1, snapshot: { change_pct: r.change_pct, price: r.price, market_div_tried: 'NX' } }));
  console.log(`[상따후보] NXT: 조회 ${pool.length}건 중 유효 ${scored.length}건 → Top${rows.length} 저장`);
  await upsertCandidates(rows, 'NXT');
}

// ── 3) 정규장 초반 재선별 (09:10~09:15) ──────────────────────────────────────
async function stageRegular() {
  const pool = (await fetchCandidateCodesBySource(['PRE_MARKET', 'NXT'])).slice(0, CANDIDATE_POOL_LIMIT);
  if (!pool.length) { console.log('[상따후보] REGULAR: 이전 단계 후보가 없어 조회 유니버스가 비어있음 — 스킵'); return; }

  const scored = [];
  for (const code of pool) {
    const out = await fetchKisPrice(code, 'J');
    if (!out) continue;
    const price = safeNum(out.stck_prpr), high = safeNum(out.stck_hgpr);
    scored.push({
      code, price, acc_amt: safeNum(out.acml_tr_pbmn), change_pct: safeNum(out.prdy_ctrt),
      is_new_high: price > 0 && price >= high,
    });
  }
  if (!scored.length) { console.log('[상따후보] REGULAR: 유효 응답 없음 — 스킵'); return; }

  scored.sort((a, b) => (Number(b.is_new_high) - Number(a.is_new_high)) || (b.acc_amt - a.acc_amt));
  const top = scored.slice(0, CANDIDATE_TOP_N);
  const rows = top.map((r, i) => ({ code: r.code, rank: i + 1, snapshot: { price: r.price, acc_amt: r.acc_amt, change_pct: r.change_pct, is_new_high: r.is_new_high } }));
  console.log(`[상따후보] REGULAR: 조회 ${pool.length}건 중 유효 ${scored.length}건 → Top${rows.length} 저장 (신고가 ${top.filter(r => r.is_new_high).length}건)`);
  await upsertCandidates(rows, 'REGULAR');
}

// ── 4) 장중 연속 스캔 (SCAN, 09:15~15:20) ────────────────────────────────────
// GitHub Actions cron은 5분 간격이었으나, 상따는 초단타라 종목 편입/이탈을 더
// 빠르게 반영해야 한다는 요청에 따라 1분 간격으로 단축(SCAN_INTERVAL_MS 참고).
//
// 2026-09-09: 기존엔 "이미 한 번이라도 후보였던 종목(known)"은 매번 skip해서
// 다시는 건드리지 않았음 — 그 결과 09:15 REGULAR까지 정해진 리스트가 사실상
// 하루종일 고정되고(추가만 되고 교체는 안 됨), 이미 모멘텀이 식은 종목도
// 실시간 추적 대상에 계속 남아있는 문제가 있었음. 이제는 "지금도 등락률
// 상위권(top 30)에 남아있는 종목"은 이미 알던 종목이어도 매번 새 SCAN 행으로
// upsert해서 created_at을 갱신함 — refreshSangttaCandidates()가 이 데이터를
// 가지고 실시간 추적 대상을 뽑으므로, 상위권에서 계속 밀려나 갱신이 끊긴 예전
// 후보는 자연스럽게 추적 대상에서 빠지고 지금 뜨거운 종목이 그 자리를 대체함.
// 2026-09-09 2차 개선: SANGTTA_MAX_TRACKED를 40→소수로 줄이고
// refreshSangttaCandidates()의 정렬 기준도 "단순 최신순"에서 "최신순 + 동일
// 배치 내에서는 등락률순위(rank) 우선"으로 바꿔서, 지금 가장 강하게 오르는
// 종목이 확실히 앞자리를 차지하도록 함 — 교체가 더 자주, 더 확실하게 일어남.
// 보유 중인 포지션은 wantedCodes()에서 항상 별도로 포함되므로 이 로테이션으로
// 추적이 끊기지 않음.
async function stageScan() {
  const minutesNow = kstMinutesNow();
  if (minutesNow < SCAN_START_MIN || minutesNow > SCAN_END_MIN) return;

  const ranked = await fetchChangeRateRank(30);
  if (!ranked.length) {
    // fetchChangeRateRank()는 실패 시 반드시 warn/error를 남기므로, 이 로그가
    // 찍힌다는 건 KIS 응답 자체는 정상(rt_cd='0')인데 조건(등락률≥SCAN_MIN_CHANGE_PCT%,
    // 가격≥SCAN_MIN_PRICE, 거래량≥SCAN_MIN_VOL) 만족 종목이 0건이라는 뜻.
    // 2026-09-10 이전엔 이 분기가 완전히 무로그였어서 "진짜 0건"과 "조용한 실패"를
    // 구분할 수 없었음 — 그 문제를 해결하기 위해 추가.
    console.log(`[상따후보] SCAN: 등락률순위 0건 응답(조건 등락률≥${SCAN_MIN_CHANGE_PCT}%·가격≥${SCAN_MIN_PRICE}·거래량≥${SCAN_MIN_VOL} 만족 종목 없음) — 스킵`);
    return;
  }

  const known = await fetchAllKnownCandidateCodes();
  let skippedPref = 0, newCount = 0, refreshedCount = 0;
  const rows = [];
  const nowKstStr = new Intl.DateTimeFormat('en-GB', { timeZone: KST_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());

  for (let i = 0; i < ranked.length; i++) {
    const out = ranked[i];
    const code = out.stck_shrn_iscd || out.mksc_shrn_iscd || out.code;
    const name = out.hts_kor_isnm || '';
    if (!code) continue;
    if (PREFERRED_OR_SPAC_RE.test(name)) { skippedPref++; continue; }
    const price = safeNum(out.stck_prpr);
    if (price && price < SCAN_MIN_PRICE) continue;
    if (known.has(code)) refreshedCount++; else newCount++;
    rows.push({
      code, rank: i + 1,
      snapshot: { name: name || null, price, change_pct: safeNum(out.prdy_ctrt), acc_amt: safeNum(out.acml_tr_pbmn), detected_at: nowKstStr },
    });
    if (rows.length >= SCAN_TOP_N) break;
  }

  if (!rows.length) {
    console.log(`[상따후보] SCAN: 등락률순위 ${ranked.length}건 중 저장할 종목 없음(우선주/스팩 ${skippedPref}건 제외)`);
    return;
  }
  console.log(`[상따후보] SCAN: 등락률순위 ${ranked.length}건 중 신규 ${newCount}건 + 상위권 유지 갱신 ${refreshedCount}건 반영(우선주/스팩 ${skippedPref}건 제외)`);
  await upsertCandidates(rows, 'SCAN');
}

// ── 스케줄러 — GitHub Actions cron을 대신해 이 프로세스 안에서 시각을 감시 ────
// PRE_MARKET/NXT/REGULAR는 하루 1회, 지정 시각을 지나면 실행하고 당일 재실행하지
// 않음(실패 시 다음 하트비트에 재시도하도록 상태를 되돌림). SCAN은 유효 시간대
// 안에서 SCAN_INTERVAL_MS(1분)마다 반복 실행.
const _candidateStageDoneFor = { preMarket: null, nxt: null, regular: null };
async function runCandidateStageOnce(stageKey, minuteThreshold, fn) {
  const today = kstDateStr();
  if (_candidateStageDoneFor[stageKey] === today) return;
  if (kstMinutesNow() < minuteThreshold) return;
  _candidateStageDoneFor[stageKey] = today;
  try {
    await fn();
  } catch (err) {
    console.error(`[상따후보] ${stageKey} 실행 실패(다음 하트비트에 재시도):`, err.message);
    _candidateStageDoneFor[stageKey] = null;
  }
}

let _lastScanRunAt = 0;
const SCAN_INTERVAL_MS = 60 * 1000;
const CANDIDATE_HEARTBEAT_MS = 15 * 1000;

async function candidateEngineHeartbeat() {
  await runCandidateStageOnce('preMarket', 7 * 60 + 50, stagePreMarket);
  await runCandidateStageOnce('nxt', 8 * 60 + 40, stageNxt);
  await runCandidateStageOnce('regular', 9 * 60 + 12, stageRegular);

  const minutesNow = kstMinutesNow();
  if (minutesNow >= SCAN_START_MIN && minutesNow <= SCAN_END_MIN && Date.now() - _lastScanRunAt >= SCAN_INTERVAL_MS) {
    _lastScanRunAt = Date.now();
    stageScan().catch(err => console.error('[상따후보] SCAN 실행 실패:', err.message));
  }
}
setInterval(candidateEngineHeartbeat, CANDIDATE_HEARTBEAT_MS);

// ----------------------------------------------------------------------------
// 3-B) 전략성과2(상따) 실시간 엔진 — sangtta_virtual_trading_spec.md 4~7절
// ----------------------------------------------------------------------------
// 기존 "전략 성과"(VIRTUAL 스윙 포트폴리오)와 완전히 분리된 별도 엔진입니다.
// intraday_positions(portfolio='INTRADAY_SANGTTA') 테이블만 다루고,
// positions(portfolio='VIRTUAL') 쪽 로직(위 1~2절)에는 손대지 않습니다.
const SANGTTA_ENTRY_START_MIN = 9 * 60 + 15;   // 09:15 이전 진입 금지(관망+재선별 구간)
const SANGTTA_FORCE_CLOSE_MIN = 15 * 60 + 19;  // 15:19 이후 보유분 강제 청산(동시호가 직전)
const SANGTTA_MARKET_END_MIN  = 15 * 60 + 30;  // 이 시각 이후엔 신규 체결 자체가 없다고 보고 정산 트리거

// 2026-09-09 6차: 사용자가 직접 지정한 기준으로 확정.
// "진입 조건 전반을 완화했습니다(오늘 하루 다양한 표본을 쌓아 승률/평균
// 수익률을 보고 다시 조율하려는 목적)"는 방침은 유지하되, 구체적인 값은
// 아래처럼 사용자가 다시 명시한 값으로 고정:
//  · 체결강도 150%
//  · 대량체결 2회, 3천만원
//  · 분당거래대금비율 150%
//  · 분당 평균거래대금(유동성) 3천만원
//  · 실제 등락률 3%
//  · 프로그램 순매수 → 일단 제외
const SANGTTA_CTTR_MIN            = 150;         // 체결강도 150%↑
const SANGTTA_LARGE_PRINT_KRW     = 30_000_000;  // 순간체결금액 3천만원↑
const SANGTTA_LARGE_PRINT_WINDOW_MS = 60_000;    // "최근 1분 내"
const SANGTTA_LARGE_PRINT_MIN_COUNT = 2;         // 2회 이상
const SANGTTA_MINUTE_VOL_RATIO_MIN  = 1.5;       // 분당거래대금 최근5분평균 대비 150%↑
const SANGTTA_MINUTE_HISTORY_MIN    = 5;         // "최근 5분" 평균에 쓸 과거 분봉 수
// 2026-09-09 6차: 프로그램 순매수는 "일단 제외" — 진입을 막거나 허용하는
// 판단에 더 이상 쓰지 않음(아래 maybeEnterSangtta()에 있던 차단 로직 제거).
// 다만 데이터 구독·표시는 계속 유지하고(실시간 조건 트래킹 표의 "프로그램
// 순매수(2분)" 컬럼은 그대로 참고용으로 보임), 등급(A/B) 산정의 보너스
// 조건과 보유 중 반전매도 선제청산(PROGRAM_REVERSAL)에는 계속 쓰고 있음 —
// 이 부분도 빼길 원하면 알려줄 것. 아래 상수는 더는 진입 차단에 쓰이지
// 않지만, 나중에 다시 켤 수 있도록 남겨둠(현재 미사용).
const SANGTTA_PROGRAM_NET_SELL_BLOCK_KRW = -50_000_000; // (현재 미사용) 프로그램 순매수(2분) -5천만원 이하 기준값
const SANGTTA_MIN_CHANGE_PCT_ENTRY = 3;          // 현재 등락률 3%↑
// 매수 잔량(실제 체결 가능성) 문제 — 현재 엔진은 체결(H0STCNT0) 틱만 보고
// 실시간 호가(매도잔량)는 구독하지 않아 진짜 주문가능한 잔량을 보진 못함.
// 완전한 호가잔량 체크는 별도 KIS 호가 구독(추가 구독 슬롯 필요)이 있어야
// 정확함(추후 검토). 1차 조치로 "직전 5분 평균 분당거래대금"을 대리지표로
// 씀 — 시각과 무관하게 "지금 이 순간 실제로 거래가 활발한지"만 보므로
// 09:15든 14:00든 동일한 기준이 적용됨.
const SANGTTA_MIN_MINUTE_AMT_ENTRY = 30_000_000; // 직전 5분 평균 분당거래대금 3천만원↑
// 2026-09-09 2차 개선: 실제 전략은 하루 중 가장 강하게 오르는 1~3종목을 짧게
// 사고파는 단타 회전매매라, 40개씩이나 되는 넓은 후보 풀을 유지할 필요가
// 없음(오히려 교체가 뜸해지고 "지금 가장 뜨거운 종목"에 집중하기 어려워짐).
// 40 → 12로 축소해 추적 대상을 좁히고, 아래 refreshSangttaCandidates()의
// 정렬 로직도 "최신순 + 동률이면 등락률순위 우선"으로 바꿔 진짜 지금 강한
// 종목이 상위에 남도록 함. 너무 좁아서 매수 기회를 자주 놓친다면 다시 늘릴 것.
const SANGTTA_MAX_TRACKED           = 12;        // 실시간 추적(=웹소켓 구독) 대상 상위 N개
// 2026-09-10 3차 개선: "최신 갱신순" 정렬만으로는 회전이 느렸음 — 등락률 5%+
// 신규 종목이 드문드문 나오는 날엔 새 후보가 충분히 안 들어와서, 이미
// 마이너스로 전환된 예전 후보가 며칠이고 화면에 "후보"로 계속 남아있는 문제가
// 있었음(사용자 스크린샷으로 확인: 대한광통신 -3.48%, 우리기술 -5.87%,
// 가온전선 -7.72% 등이 계속 후보에 떠 있었음). 단타 전략 특성상 방향이
// 꺾인 종목을 계속 들고 감시할 이유가 없으므로, 실시간 등락률이 이 값
// 밑으로 떨어지면 즉시 후보 목록에서 제외한다(보유 중인 포지션은 청산
// 판단을 계속 해야 하므로 예외 — wantedCodes()가 별도로 구독을 유지함).
const SANGTTA_CANDIDATE_STALE_FLOOR_PCT = 0;
// 프로그램 순매수 규모가 이 이상이면 "강한 프로그램 매수세 동반"으로 보고
// 진입 등급을 A(풀사이즈)로 올림(기존엔 신고가 돌파 여부만 봤음) — 사용자
// 지적대로 프로그램 매수가 붙으면 상승 추세가 더 오래/가파르게 이어질 수
// 있다고 보고 사이징에 반영.
const SANGTTA_PROGRAM_NET_BUY_STRONG = 150_000_000; // 프로그램 순매수(2분) 1.5억원↑
// 보유 중 어느 정도 수익(peakRet)이 난 뒤, 프로그램매매가 순매수→순매도로
// 뚜렷하게 전환되면 "큰손/프로그램이 물량을 넘기기 시작"한 신호로 보고
// 트레일링 손절선에 닿기 전에 선제적으로 청산 — 사용자가 설명한 "초반 상승
// 후 고수 매도 물량이 상승을 꺾는" 패턴에 대응.
const SANGTTA_PROGRAM_REVERSAL_MIN_GAIN_PCT = 3;      // 최고수익 3%↑ 구간에서만 반전 신호 체크(노이즈 방지)
const SANGTTA_PROGRAM_REVERSAL_NET_SELL_KRW = -50_000_000; // 최근 2분 순매도 5천만원↑ 전환 시 선제 청산
const SANGTTA_MAX_ENTRIES_PER_CODE  = 2;         // 3번째 진입 시도부터는 등급 C(배제)로 간주

// 진입 등급별 가상매수 금액(스펙 4-1절 — 절대금액은 스펙에 없어 임의 기본값,
// 필요시 조정하세요). A=풀사이즈, B=1/2, C=진입 배제.
const SANGTTA_SIZE_KRW = { A: 10_000_000, B: 5_000_000 };

// 6-1절 단계형 트레일링 손절표 — 진입가 대비 "고점 기준" 최고수익률 구간별로
// 손절선을 좁혀감. 0~5% 구간만 예외적으로 "진입가" 기준 하드캡(-2%).
function sangttaStopLine(entryPrice, peakPrice) {
  const peakRet = (peakPrice - entryPrice) / entryPrice * 100;
  if (peakRet <= 5)  return { line: entryPrice * (1 - 0.02),  type: 'HARD_STOP' };
  if (peakRet <= 10) return { line: peakPrice  * (1 - 0.02),  type: 'TRAILING_STOP' };
  if (peakRet <= 20) return { line: peakPrice  * (1 - 0.015), type: 'TRAILING_STOP' };
  return                    { line: peakPrice  * (1 - 0.01),  type: 'TRAILING_STOP' };
}

function kstMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: KST_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = +parts.find(p => p.type === 'hour').value;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
}

const sangttaCandidates   = new Set();               // 오늘의 후보 코드 (intraday_candidates)
const sangttaOpenPositions = new Map();               // code -> {id, entryPrice, peakPrice, peakTime, qty, grade}
const sangttaEntriesToday  = new Map();               // code -> 오늘 누적 진입 시도 횟수 (등급 C 판정용)
const sangttaTickStats     = new Map();               // code -> {minuteBuckets:Map, largePrints:number[]}
let sangttaDailySummaryDoneFor = null;                // 오늘 이미 정산했으면 날짜 문자열

function getSangttaStats(code) {
  let st = sangttaTickStats.get(code);
  if (!st) { st = { minuteBuckets: new Map(), largePrints: [] }; sangttaTickStats.set(code, st); }
  return st;
}

// 틱마다 분당 누적거래대금 버킷과 "대량체결(5천만원↑)" 발생 시각을 갱신.
// minuteBuckets는 최근 SANGTTA_MINUTE_HISTORY_MIN+1분치만 남기고 정리.
function updateSangttaTickStats(code, price, cntgVol, now) {
  const st = getSangttaStats(code);
  const minuteKey = Math.floor(now / 60000);
  const amt = price * (Number.isFinite(cntgVol) ? cntgVol : 0);

  st.minuteBuckets.set(minuteKey, (st.minuteBuckets.get(minuteKey) || 0) + amt);
  const cutoffMinute = minuteKey - (SANGTTA_MINUTE_HISTORY_MIN + 1);
  for (const k of st.minuteBuckets.keys()) if (k < cutoffMinute) st.minuteBuckets.delete(k);

  if (amt >= SANGTTA_LARGE_PRINT_KRW) st.largePrints.push(now);
  const cutoffMs = now - SANGTTA_LARGE_PRINT_WINDOW_MS;
  while (st.largePrints.length && st.largePrints[0] < cutoffMs) st.largePrints.shift();

  return { minuteKey, st };
}

// 현재 진행 중인 분(minuteKey)의 누적거래대금 ÷ 그 직전 완결된 최근 N분 평균,
// 그리고 그 평균값(avg) 자체도 함께 돌려줌 — avg는 "지금 이 종목이 시각과
// 무관하게 분당 얼마나 거래되고 있는지"를 보여주는 유동성 지표로도 쓰임
// (SANGTTA_MIN_MINUTE_AMT_ENTRY 진입 조건). 과거 분봉 데이터가 부족하면
// (장 시작 직후 등) null을 돌려주고 진입 조건에서 스킵.
function sangttaMinuteVolumeStats(st, minuteKey) {
  const cur = st.minuteBuckets.get(minuteKey) || 0;
  const prevKeys = [];
  for (let k = minuteKey - 1; k >= minuteKey - SANGTTA_MINUTE_HISTORY_MIN; k--) prevKeys.push(k);
  const prevAmts = prevKeys.map(k => st.minuteBuckets.get(k)).filter(v => v != null);
  if (prevAmts.length < SANGTTA_MINUTE_HISTORY_MIN) return null;
  const avg = prevAmts.reduce((a, b) => a + b, 0) / prevAmts.length;
  return { ratio: avg > 0 ? cur / avg : null, avg, cur };
}

// service_role 키로 쓰기 + INSERT 결과 반환(대기 중인 id를 바로 알아야 해서
// 기존 sbWrite의 Prefer:return=minimal 대신 return=representation 사용).
async function sbWriteReturning(path, method, body) {
  if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY 미설정');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function refreshSangttaCandidates() {
  try {
    const today = kstDateStr();
    // created_at desc로 정렬해 "가장 최근에 (재)선정된" 순서를 얻되, 동일한
    // SCAN 배치는 upsertCandidates()가 created_at을 한 번에 같은 값으로
    // 채우므로(같은 분 안에서는 사실상 동시각) rank(등락률순위, 1이 가장 강함)
    // 오름차순을 2차 정렬 기준으로 둬서 "같은 시각에 갱신된 종목들 중에서도
    // 지금 진짜 더 강하게 오르는 종목"이 앞자리를 차지하도록 함. 이렇게 뽑은
    // 상위 SANGTTA_MAX_TRACKED개만 실시간 추적 대상으로 남긴다. 오래 갱신되지
    // 않은(=더 이상 조건에 안 걸리는) 후보는 자연스럽게 밀려나 제외된다.
    const rows = await sbGet(
      `intraday_candidates?select=code,rank,created_at&trade_date=eq.${today}&order=created_at.desc,rank.asc`
    );
    const seen = new Set();
    const allOrdered = [];
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      allOrdered.push(r.code);
    }
    // 순번을 자르기(top N) 전에 "지금 실시간으로 마이너스 전환된" 종목을 먼저
    // 걸러낸다. lastPrice는 H0STCNT0 틱마다 갱신되는 최신 시세 캐시라 DB보다
    // 훨씬 신선함 — 아직 틱을 한 번도 못 받은 신규 후보(lastPrice 없음)는
    // 판단할 근거가 없으니 일단 유지하고, 다음 주기에 다시 판단한다.
    const stillAlive = allOrdered.filter(code => {
      if (sangttaOpenPositions.has(code)) return true; // 보유 중이면 무조건 유지(청산 판단용)
      const live = lastPrice.get(code);
      if (!live || !Number.isFinite(live.changePct)) return true;
      return live.changePct >= SANGTTA_CANDIDATE_STALE_FLOOR_PCT;
    });
    const staleDropped = allOrdered.filter(c => !stillAlive.includes(c));
    const ordered = stillAlive.slice(0, SANGTTA_MAX_TRACKED);
    sangttaCandidates.clear();
    ordered.forEach(c => sangttaCandidates.add(c));
    if (staleDropped.length) {
      console.log(`[상따후보] 마이너스 전환으로 후보 제외: ${staleDropped.join(', ')}`);
    }
    const missingNames = [...sangttaCandidates].filter(c => !codeNames.has(c));
    if (missingNames.length) {
      const nameRows = await sbGet(`stocks?select=code,name&code=in.(${missingNames.join(',')})`);
      nameRows.forEach(r => codeNames.set(r.code, r.name));
    }
    reconcileKisSubscriptions();
    reconcileProgramTradeSubscriptions(); // 후보 목록이 바뀌었으므로 프로그램매매 구독도 재조정
  } catch (err) {
    console.error('[상따] 후보 갱신 실패:', err.message);
  }
}
// stageScan()의 신규 후보 발굴 자체는 KIS API 호출이 있어 1분 간격을 유지하지만,
// 여기(refreshSangttaCandidates)는 DB 조회 + 로컬 lastPrice 캐시 비교뿐이라
// 비용이 거의 없음. 마이너스 전환된 후보를 더 빨리 걸러내라는 요청(2026-09-10)에
// 따라 60초 → 20초로 단축 — "수시로" 후보 목록이 갱신되도록 함.
const SANGTTA_CANDIDATE_POLL_MS = 20 * 1000;
setInterval(refreshSangttaCandidates, SANGTTA_CANDIDATE_POLL_MS);

// 이미 CLOSED된 오늘자 포지션을 서버 재시작 후에도 "몇 번째 진입인지" 알 수 있게
// 시작 시 한 번 채워둠(sangttaEntriesToday는 메모리 상태라 재시작하면 0부터
// 다시 셀 위험이 있어서, 서버 켤 때 오늘자 기존 포지션 수로 보정).
async function primeSangttaEntryCounts() {
  try {
    const today = kstDateStr();
    const rows = await sbGet(`intraday_positions?select=code&portfolio=eq.INTRADAY_SANGTTA&trade_date=eq.${today}`);
    rows.forEach(r => sangttaEntriesToday.set(r.code, (sangttaEntriesToday.get(r.code) || 0) + 1));
  } catch (err) {
    console.error('[상따] 진입횟수 초기화 실패:', err.message);
  }
}

async function primeSangttaOpenPositions() {
  try {
    const rows = await sbGet('intraday_positions?select=*&portfolio=eq.INTRADAY_SANGTTA&status=eq.OPEN');
    rows.forEach(p => {
      sangttaOpenPositions.set(p.code, {
        id: p.id,
        entryPrice: +p.entry_price,
        peakPrice: +p.peak_price || +p.entry_price,
        entryTime: p.entry_time ? new Date(p.entry_time).getTime() : Date.now(),
        peakTime: p.peak_at ? new Date(p.peak_at).getTime() : Date.now(),
        qty: (p.entry_reason && p.entry_reason.quantity) || 0,
        grade: (p.entry_reason && p.entry_reason.entry_grade) || null,
      });
    });
    if (rows.length) {
      reconcileKisSubscriptions();
      reconcileProgramTradeSubscriptions(); // 서버 재시작 시에도 기존 보유분에 H0STPGM0 구독 복원
    }
  } catch (err) {
    console.error('[상따] 보유 포지션 초기화 실패:', err.message);
  }
}

// 2026-09-09: 신고가 돌파 여부만 보던 A/B 등급 판정에 프로그램 순매수 강도를
// 추가 — 신고가 돌파가 아니어도 프로그램 매수세가 강하면(SANGTTA_PROGRAM_NET_BUY_STRONG↑)
// 상승이 더 이어질 가능성이 높다고 보고 A등급(풀사이즈)을 부여.
function sangttaGradeFor(code, isNewHigh, programNetBuy) {
  const tries = (sangttaEntriesToday.get(code) || 0) + 1; // 이번 시도 포함
  if (tries >= SANGTTA_MAX_ENTRIES_PER_CODE + 1) return 'C';   // 3번째 시도부터 배제
  const strongProgram = Number.isFinite(programNetBuy) && programNetBuy >= SANGTTA_PROGRAM_NET_BUY_STRONG;
  if (tries === 1) return (isNewHigh || strongProgram) ? 'A' : 'B'; // 최초 진입: 신고가 돌파 or 강한 프로그램 매수면 A
  return 'B';                                                   // 재진입은 B(1/2 사이즈)
}

async function enterSangttaPosition(code, price, grade, ctx) {
  const sizeKrw = SANGTTA_SIZE_KRW[grade];
  const qty = Math.max(1, Math.floor(sizeKrw / price));
  const now = new Date();
  const programNetBuyManwon = Number.isFinite(ctx.programNetBuy) ? Math.round(ctx.programNetBuy / 10000) : null;
  const minuteAvgAmtManwon = Number.isFinite(ctx.minuteAvgAmt) ? Math.round(ctx.minuteAvgAmt / 10000) : null;
  const reasonText = `등락률 ${ctx.changePct.toFixed(1)}% · 체결강도 ${ctx.cttr.toFixed(0)}% · 1분내 대량체결 ${ctx.largePrints}회 · `
    + `분당거래대금 ${ctx.minuteRatio.toFixed(1)}배(평균 ${minuteAvgAmtManwon != null ? minuteAvgAmtManwon + '만원/분' : '–'}) · `
    + `프로그램순매수 ${programNetBuyManwon != null ? programNetBuyManwon + '만원' : '–'} · 등급${grade} (${ctx.source})`;
  const entry_reason = {
    entry_grade: grade,
    source: ctx.source,
    execution_strength: ctx.cttr,
    large_prints_1min: ctx.largePrints,
    minute_volume_ratio: ctx.minuteRatio,
    minute_avg_amt_krw: ctx.minuteAvgAmt != null ? Math.round(ctx.minuteAvgAmt) : null,
    program_net_buy_krw: ctx.programNetBuy != null ? Math.round(ctx.programNetBuy) : null,
    change_pct_at_entry: ctx.changePct,
    entry_amount_krw: sizeKrw,
    quantity: qty,
    reason_text: reasonText,
  };

  sangttaEntriesToday.set(code, (sangttaEntriesToday.get(code) || 0) + 1);
  // 낙관적으로 먼저 메모리에 반영 — DB insert가 늦게 끝나는 사이 다음 틱이
  // 같은 종목을 중복 진입시키지 않도록 함(placeholder id는 insert 성공 시 교체).
  sangttaOpenPositions.set(code, { id: null, entryPrice: price, peakPrice: price, entryTime: now.getTime(), peakTime: now.getTime(), qty, grade });

  try {
    const rows = await sbWriteReturning('intraday_positions', 'POST', [{
      portfolio: 'INTRADAY_SANGTTA', code, name: codeNames.get(code) || null,
      trade_date: kstDateStr(), entry_time: now.toISOString(), entry_price: Math.round(price),
      entry_reason, peak_price: Math.round(price), peak_time: now.toISOString(), status: 'OPEN',
    }]);
    const row = rows && rows[0];
    if (row) {
      const pos = sangttaOpenPositions.get(code);
      if (pos) pos.id = row.id;
      insertSangttaDecisionEvent(row.id, 'ENTRY', { price, ...entry_reason }).catch(() => {});
      console.log(`[상따] 진입 ${codeNames.get(code) || code}(${code}) ${grade}등급 @${price} — ${reasonText}`);
    }
  } catch (err) {
    console.error(`[상따] ${code} 진입 기록 실패:`, err.message);
  }
  reconcileKisSubscriptions();
  reconcileProgramTradeSubscriptions(); // 방금 보유 종목이 됐으므로 H0STPGM0 구독 추가
}

async function exitSangttaPosition(code, price, exitType, extra = {}) {
  const pos = sangttaOpenPositions.get(code);
  if (!pos) return;
  sangttaOpenPositions.delete(code); // 중복 청산 방지를 위해 먼저 제거

  const now = new Date();
  const holdMinutes = Math.round((now.getTime() - (pos.entryTime || pos.peakTime)) / 60000);
  const realized_pnl = Math.round(pos.qty * (price - pos.entryPrice));
  const return_pct = (price - pos.entryPrice) / pos.entryPrice * 100;
  const peakRet = (pos.peakPrice - pos.entryPrice) / pos.entryPrice * 100;
  const reasonText = exitType === 'MARKET_CLOSE'
    ? `장마감 강제청산 · 최고수익 ${peakRet >= 0 ? '+' : ''}${peakRet.toFixed(1)}%에서 마감`
    : exitType === 'PROGRAM_REVERSAL'
    ? `프로그램 매도 전환 감지 · 최고수익 ${peakRet >= 0 ? '+' : ''}${peakRet.toFixed(1)}%에서 선제청산`
    : `${exitType === 'HARD_STOP' ? '하드캡' : '트레일링'} 손절 · 최고수익 ${peakRet >= 0 ? '+' : ''}${peakRet.toFixed(1)}%에서 반락`;
  const exit_reason = {
    exit_type: exitType,
    peak_price: Math.round(pos.peakPrice),
    peak_time: new Date(pos.peakTime).toISOString(),
    hold_minutes: holdMinutes,
    reason_text: reasonText,
  };

  try {
    await sbWrite(`intraday_positions?id=eq.${pos.id}`, 'PATCH', {
      status: 'CLOSED', exit_time: now.toISOString(), exit_price: Math.round(price),
      exit_reason, realized_pnl, return_pct,
    });
    insertSangttaDecisionEvent(pos.id, 'EXIT', { price, ...exit_reason, realized_pnl, return_pct }).catch(() => {});
    console.log(`[상따] 청산 ${codeNames.get(code) || code}(${code}) ${exitType} @${price} — ${reasonText}`);
  } catch (err) {
    console.error(`[상따] ${code} 청산 기록 실패:`, err.message);
  }
  reconcileKisSubscriptions();
  reconcileProgramTradeSubscriptions(); // 더 이상 보유 종목이 아니므로 H0STPGM0 구독 해제
}

async function insertSangttaDecisionEvent(positionId, eventType, metrics) {
  if (!positionId) return;
  try {
    await sbWrite('intraday_decision_events', 'POST', [{
      position_id: positionId, event_type: eventType,
      event_time: new Date().toISOString(), metrics,
    }]);
  } catch (err) {
    console.error('[상따] decision_event 기록 실패:', err.message);
  }
}

// 진입 조건 판정 (스펙 4절) — 후보 목록에 있거나, 목록 밖이라도 대량체결이
// 반복되면(3-3절 "장중 신규 편입") 조건 검사 대상에 포함.
function maybeEnterSangtta(code, price, rec, now) {
  if (sangttaOpenPositions.has(code)) return;              // 이미 보유 중
  // 통계(분당거래대금 버킷·대량체결 카운트)는 진입 허용 시각과 무관하게 09:00
  // 장 시작 틱부터 계속 쌓아둬야, 09:15에 진입이 열리는 순간 바로 "최근 5분
  // 평균"을 계산할 수 있음(그렇지 않으면 09:15~09:20은 항상 데이터 부족으로
  // 진입 불가능해짐).
  const { minuteKey, st } = updateSangttaTickStats(code, price, Number(rec[F_CNTG_VOL]), now);

  const minutesNow = kstMinutesNow();
  if (minutesNow < SANGTTA_ENTRY_START_MIN || minutesNow >= SANGTTA_FORCE_CLOSE_MIN) return;

  const isCandidate = sangttaCandidates.has(code);
  const largePrints = st.largePrints.length;
  const isNewDetected = !isCandidate && largePrints >= SANGTTA_LARGE_PRINT_MIN_COUNT;
  if (!isCandidate && !isNewDetected) return;

  const cttr = Number(rec[F_CTTR]);
  const changePct = Number(rec[F_RATE]);
  const high = Number(rec[F_HIGH]);
  if (!Number.isFinite(cttr) || cttr < SANGTTA_CTTR_MIN) return;
  if (largePrints < SANGTTA_LARGE_PRINT_MIN_COUNT) return;
  const mv = sangttaMinuteVolumeStats(st, minuteKey);
  if (mv == null || mv.ratio == null || mv.ratio < SANGTTA_MINUTE_VOL_RATIO_MIN) return;
  const minuteRatio = mv.ratio, minuteAvgAmt = mv.avg;
  // 2026-09-09 3차 개선: "지금 실제로 오늘 뜨는 종목인지"를 직접 확인하되,
  // 상따는 "이미 많이 오른 종목"이 아니라 "오를 기미가 보이는 종목을 초반에"
  // 잡는 전략이므로 등락률 기준은 완전 평평한 노이즈만 거르는 낮은 값(3%)만
  // 씀. 유동성은 "오늘 09:00부터 누적거래대금"이 아니라 "지금 이 순간의
  // 분당 평균 거래대금"으로 봐서 09:15 초반 진입을 불리하게 만들지 않음.
  if (!Number.isFinite(changePct) || changePct < SANGTTA_MIN_CHANGE_PCT_ENTRY) return;
  if (minuteAvgAmt < SANGTTA_MIN_MINUTE_AMT_ENTRY) return;
  // 2026-09-09 6차: 프로그램 순매수는 "일단 제외" — 더 이상 진입을 막는
  // 조건으로 쓰지 않음(이전엔 뚜렷한 순매도 전환 시 차단했었음). 데이터는
  // 계속 받아서 아래 등급(A등급 보너스) 판정에만 참고용으로 씀.
  const pt = getProgramTradeSnapshot(code);

  const isNewHigh = Number.isFinite(high) && price >= high;
  const grade = sangttaGradeFor(code, isNewHigh, pt ? pt.netBuyAmt : null);
  if (grade === 'C') {
    console.log(`[상따] ${code} 조건 충족했으나 등급C(배제) — 진입 스킵`);
    return;
  }
  enterSangttaPosition(code, price, grade, {
    source: isCandidate ? 'CANDIDATE' : 'NEW_DETECTED',
    cttr, largePrints, minuteRatio, minuteAvgAmt, changePct, programNetBuy: pt ? pt.netBuyAmt : null,
  });
}

// 보유 중인 상따 포지션의 고점 갱신 + 트레일링 손절 판정 (스펙 6-1절) +
// 장마감 강제청산 (6-2절)
function checkSangttaExit(code, price, now) {
  const pos = sangttaOpenPositions.get(code);
  if (!pos) return;
  if (price > pos.peakPrice) { pos.peakPrice = price; pos.peakTime = now; }

  const minutesNow = kstMinutesNow();
  if (minutesNow >= SANGTTA_FORCE_CLOSE_MIN) {
    exitSangttaPosition(code, price, 'MARKET_CLOSE');
    return;
  }

  // 2026-09-09: 프로그램 반전 매도 선제 청산 — 어느 정도 수익(peakRet)이 난
  // 뒤 프로그램매매가 순매수→뚜렷한 순매도로 돌아서면, 트레일링 손절선에
  // 닿기 전에 먼저 빠져나옴. "초반 상승 후 고수 물량이 상승을 꺾는" 패턴을
  // 트레일링 손절보다 한 박자 빠르게 잡아내기 위한 leading-indicator 성격의
  // 청산으로, 아래 일반 손절 판정보다 먼저 체크한다.
  const peakRet = (pos.peakPrice - pos.entryPrice) / pos.entryPrice * 100;
  if (peakRet >= SANGTTA_PROGRAM_REVERSAL_MIN_GAIN_PCT) {
    const pt = getProgramTradeSnapshot(code);
    if (pt && pt.netBuyAmt <= SANGTTA_PROGRAM_REVERSAL_NET_SELL_KRW) {
      exitSangttaPosition(code, price, 'PROGRAM_REVERSAL');
      return;
    }
  }

  const { line, type } = sangttaStopLine(pos.entryPrice, pos.peakPrice);
  if (price <= line) exitSangttaPosition(code, price, type);
}

// 프론트 "실시간 조건 트래킹" 표용 스냅샷. 후보/보유 종목이 아니면 null을
// 반환해 관계없는 종목(기존 VIRTUAL 보유분 등)의 페이로드를 부풀리지 않는다.
// handleSangttaTick() 호출(통계 갱신 + 진입/청산 판정) 이후에 불러야 그 틱의
// 최신 상태(방금 갱신된 largePrints/minuteRatio, 방금 발생한 진입/청산 등)가
// 반영된다. 기존 websocket 'price' 메시지에 sangtta 필드만 추가하는 방식이라
// 새 메시지 타입/프로토콜 변경 없이, 이미 그 종목을 구독 중인 클라이언트가
// 그대로 이 필드를 받는다.
function sangttaLiveSnapshot(code, rec, price, now) {
  const isCandidate = sangttaCandidates.has(code);
  const pos = sangttaOpenPositions.get(code);
  const isOpenPosition = !!pos;
  if (!isCandidate && !isOpenPosition) return null;

  const st = getSangttaStats(code);
  const minuteKey = Math.floor(now / 60000);
  const cttr = Number(rec[F_CTTR]);
  const high = Number(rec[F_HIGH]);
  const changePct = Number(rec[F_RATE]);
  const largePrints = st.largePrints.length;
  const mv = sangttaMinuteVolumeStats(st, minuteKey);
  const minuteRatio = mv ? mv.ratio : null;
  const minuteAvgAmt = mv ? mv.avg : null;
  const isNewHigh = Number.isFinite(high) && Number.isFinite(price) && price >= high;
  // 2026-09-09 6차: 프로그램 순매수는 진입 조건에서 "일단 제외"했으므로
  // 아래 conditions(=진입 필수조건 5개)에는 더 이상 포함하지 않음. 다만
  // 후보 단계까지 구독은 계속 유지해 snap.programTrade로 참고용 표시는
  // 계속하고, 등급(A등급 보너스) 판정에도 그대로 씀.
  const pt = getProgramTradeSnapshot(code);

  const conditions = {
    changePctMin: {
      ok: Number.isFinite(changePct) && changePct >= SANGTTA_MIN_CHANGE_PCT_ENTRY,
      value: Number.isFinite(changePct) ? changePct : null,
      threshold: SANGTTA_MIN_CHANGE_PCT_ENTRY,
      label: '실제 등락률',
    },
    cttr: {
      ok: Number.isFinite(cttr) && cttr >= SANGTTA_CTTR_MIN,
      value: Number.isFinite(cttr) ? cttr : null,
      threshold: SANGTTA_CTTR_MIN,
      label: '체결강도',
    },
    largePrints: {
      ok: largePrints >= SANGTTA_LARGE_PRINT_MIN_COUNT,
      value: largePrints,
      threshold: SANGTTA_LARGE_PRINT_MIN_COUNT,
      label: '순간체결 5천만원+ (1분내)',
    },
    minuteRatio: {
      ok: minuteRatio != null && minuteRatio >= SANGTTA_MINUTE_VOL_RATIO_MIN,
      value: minuteRatio,
      threshold: SANGTTA_MINUTE_VOL_RATIO_MIN,
      label: '분당거래대금 비율',
    },
    liquidity: {
      ok: minuteAvgAmt != null && minuteAvgAmt >= SANGTTA_MIN_MINUTE_AMT_ENTRY,
      value: minuteAvgAmt,
      threshold: SANGTTA_MIN_MINUTE_AMT_ENTRY,
      label: '분당거래대금(유동성)',
    },
  };
  const metConditions = Object.values(conditions).filter(c => c.ok).length;

  const snap = {
    isCandidate,
    isOpenPosition,
    entriesToday: sangttaEntriesToday.get(code) || 0,
    isNewHigh,
    changePct: Number.isFinite(changePct) ? changePct : null,
    conditions,
    metConditions,
    totalConditions: Object.keys(conditions).length,
  };
  if (pt) snap.programTrade = pt;

  if (isOpenPosition) {
    const { line, type } = sangttaStopLine(pos.entryPrice, pos.peakPrice);
    snap.position = {
      entryPrice: pos.entryPrice,
      peakPrice: pos.peakPrice,
      grade: pos.grade,
      returnPct: (price - pos.entryPrice) / pos.entryPrice * 100,
      peakReturnPct: (pos.peakPrice - pos.entryPrice) / pos.entryPrice * 100,
      stopLine: line,
      stopType: type,
    };
  }
  return snap;
}

// handleKisMessage의 체결 틱 루프에서 매 틱 호출 — 후보/보유 종목이 아니면
// 즉시 리턴하므로 관계없는 종목(기존 VIRTUAL 보유분 등) 처리에 부담을 주지 않음.
function handleSangttaTick(code, price, rec, now) {
  now = now || Date.now();
  if (sangttaOpenPositions.has(code)) {
    checkSangttaExit(code, price, now);
    return;
  }
  if (!sangttaCandidates.has(code)) {
    // 후보 목록 밖이라도 대량체결 누적 여부는 계속 추적해야 "장중 신규 편입"을
    // 감지할 수 있으므로, 통계 갱신 자체는 스킵하지 않고 진행.
  }
  maybeEnterSangtta(code, price, rec, now);
}

// intraday_daily_summary는 trade_date가 PK라 그냥 POST하면 이미 있을 때 실패함 —
// POST 먼저 시도하고 충돌 나면 PATCH로 덮어써서 upsert처럼 동작시킴(재정산 시에도 안전).
async function upsertSangttaDailySummary(row) {
  try {
    await sbWrite('intraday_daily_summary', 'POST', [row]);
  } catch (_) {
    await sbWrite(`intraday_daily_summary?trade_date=eq.${row.trade_date}`, 'PATCH', row);
  }
}

async function computeAndSaveSangttaDailySummary() {
  const today = kstDateStr();
  if (sangttaDailySummaryDoneFor === today) return;
  try {
    const closed = await sbGet(`intraday_positions?select=entry_price,exit_price,entry_reason,realized_pnl&portfolio=eq.INTRADAY_SANGTTA&status=eq.CLOSED&trade_date=eq.${today}`);
    if (!closed.length) { sangttaDailySummaryDoneFor = today; return; }
    const qtyOf = p => (p.entry_reason && p.entry_reason.quantity) || 0;
    const total_buy_amt  = closed.reduce((a, p) => a + (+p.entry_price || 0) * qtyOf(p), 0);
    const total_sell_amt = closed.reduce((a, p) => a + (+p.exit_price  || 0) * qtyOf(p), 0);
    const realized_pnl = closed.reduce((a, p) => a + (+p.realized_pnl || 0), 0);
    const win_count = closed.filter(p => +p.realized_pnl > 0).length;
    const loss_count = closed.filter(p => +p.realized_pnl <= 0).length;
    const return_pct = total_buy_amt > 0 ? realized_pnl / total_buy_amt * 100 : null;
    await upsertSangttaDailySummary({
      trade_date: today, total_buy_amt, total_sell_amt, realized_pnl, return_pct,
      trade_count: closed.length, win_count, loss_count,
    });
    sangttaDailySummaryDoneFor = today;
    console.log(`[상따] 일별 정산 완료 (${today}) — ${closed.length}건, 손익 ${realized_pnl.toLocaleString('ko-KR')}원`);
  } catch (err) {
    console.error('[상따] 일별 정산 실패:', err.message);
  }
}

// 15:19~15:25 KST 사이, 남아있는 상따 보유분을 마지막 시세로 강제 청산하고
// 정산을 트리거. setInterval 주기(30초) 안에서 매번 체크하되 하루 한 번만 동작.
setInterval(() => {
  const minutesNow = kstMinutesNow();
  if (minutesNow < SANGTTA_FORCE_CLOSE_MIN || minutesNow > SANGTTA_MARKET_END_MIN) return;
  for (const code of [...sangttaOpenPositions.keys()]) {
    const cached = lastPrice.get(code);
    const price = cached ? cached.price : sangttaOpenPositions.get(code).peakPrice;
    exitSangttaPosition(code, price, 'MARKET_CLOSE');
  }
  computeAndSaveSangttaDailySummary();
}, 30_000);


function handleKisMessage(text) {
  if (text[0] === '{') {
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    const trId = json.header && json.header.tr_id;
    if (trId === 'PINGPONG') {
      if (kisWs && kisWs.readyState === WebSocket.OPEN) kisWs.send(text);
      return;
    }
    if (json.body && json.body.rt_cd && json.body.rt_cd !== '0') {
      console.warn('[KIS WS] 구독 응답 에러:', json.body.msg1 || json);
    }
    return;
  }

  const parts = text.split('|');
  if (parts.length < 4) return;
  const [encFlag, trId, countStr, dataStr] = parts;
  if (trId === KIS_PROGRAM_TRADE_TR_ID) { handleProgramTradeMessage(countStr, dataStr); return; }
  if (trId !== 'H0STCNT0') return;

  const count = parseInt(countStr, 10) || 1;
  const fields = dataStr.split('^');
  const perRecord = Math.floor(fields.length / count);
  if (perRecord <= 0) return;

  for (let i = 0; i < count; i++) {
    const rec = fields.slice(i * perRecord, (i + 1) * perRecord);
    const code = rec[F_CODE];
    if (!code) continue;
    const price = Number(rec[F_PRICE]);
    const rate = Number(rec[F_RATE]);
    if (!Number.isFinite(price)) continue;

    const dayHigh = trackDayHighLow(code, price); // 보유 종목이면 당일 고가/저가를 틱마다 갱신(트레일링·화면표시 공용)
    const tickNow = Date.now();
    handleSangttaTick(code, price, rec, tickNow); // 전략성과2(상따) 실시간 진입/청산 판정 — 스냅샷 생성 전에 먼저 실행해야 이번 틱 결과가 반영됨

    const payload = {
      type: 'price',
      code,
      price,
      changePct: Number.isFinite(rate) ? rate : null,
      sign: rec[F_SIGN] || null,
      time: rec[F_TIME] || null,
    };
    if (dayHigh) {
      // 프론트 "전략성과" 표의 "고점"/"고점시각" 컬럼을 시세와 같은 틱으로 즉시 갱신하기 위한 필드.
      payload.dayHigh = dayHigh.high;
      payload.dayHighAt = dayHigh.highAt;
    }
    const sangttaSnap = sangttaLiveSnapshot(code, rec, price, tickNow); // 전략성과2 "실시간 조건 트래킹" 표용 — 후보/보유 종목이 아니면 null
    if (sangttaSnap) payload.sangtta = sangttaSnap;
    lastPrice.set(code, payload);
    broadcastToSubscribers(code, payload);
    checkAlerts(code, price);
    if (dayHigh) maybePersistPeak(code, dayHigh); // Supabase에 스로틀 저장(재시작/재접속 대비 영속화)
  }
}

function broadcastToSubscribers(code, payload) {
  const set = subscribers.get(code);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const client of set) {
    if (client.readyState ===WebSocket.OPEN) client.send(msg);
  }
}

// ----------------------------------------------------------------------------
// 3) 보유 종목 조회 (Supabase) — 프론트엔드가 안 열려있어도 알림은 계속 돌게 함
// ----------------------------------------------------------------------------
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// PostgREST statement timeout(57014)이 종종 발생하는 무거운 뷰 조회용 —
// 짧은 간격을 두고 최대 attempts회 재시도하고, 그래도 실패하면 fallback으로
// 넘어가서 "오늘의 종목 요약" 전체가 죽지 않도록 함(개별 섹션만 빠짐).
async function sbGetResilient(path, { attempts = 3, delayMs = 4000, label = path, fallback = [] } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sbGet(path);
    } catch (err) {
      lastErr = err;
      console.error(`[오늘의 종목 요약] ${label} 조회 실패 (시도 ${i + 1}/${attempts}):`, err.message);
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  console.error(`[오늘의 종목 요약] ${label} 최종 실패, 해당 섹션 생략:`, lastErr?.message);
  return fallback;
}

// service_role 키로 쓰기 (alert_targets 전용, RLS 우회)
async function sbWrite(path, method, body) {
  if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY 미설정');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${await res.text().catch(() => '')}`);
}

// ── 목표가 영속 저장 (alert_targets 테이블) ─────────────────────────────
async function loadTargetPrices() {
  try {
    const rows = await sbGet('alert_targets?select=code,target_price');
    targetPrices.clear();
    rows.forEach(r => targetPrices.set(r.code, { price: +r.target_price }));
    console.log(`[목표가] Supabase에서 ${rows.length}건 로드`);
  } catch (err) {
    console.error('[목표가] 로드 실패:', err.message);
  }
}

async function persistTargetPrice(code, price) {
  try {
    await sbWrite('alert_targets', 'POST', [{ code, target_price: price, updated_at: new Date().toISOString() }]);
  } catch (err) {
    console.error('[목표가] 저장 실패 (메모리에는 반영됨):', err.message);
  }
}

async function deleteTargetPrice(code) {
  try {
    await sbWrite(`alert_targets?code=eq.${code}`, 'DELETE');
  } catch (err) {
    console.error('[목표가] 삭제 실패 (메모리에서는 반영됨):', err.message);
  }
}

// ── 웹푸시(PWA 앱 알림) 구독 저장/발송 ──────────────────────────────────
// endpoint(브라우저가 발급하는 구독 고유 URL) 기준으로 Map에 들고, Supabase
// push_subscriptions 테이블에도 영구 저장(Render 재배포로 날아가지 않게).
const pushSubscriptions = new Map(); // endpoint -> {endpoint, keys:{p256dh,auth}}

async function loadPushSubscriptions() {
  try {
    const rows = await sbGet('push_subscriptions?select=endpoint,p256dh,auth');
    pushSubscriptions.clear();
    rows.forEach(r => pushSubscriptions.set(r.endpoint, {
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth },
    }));
    console.log(`[push] Supabase에서 구독 ${rows.length}건 로드`);
  } catch (err) {
    console.error('[push] 구독 로드 실패:', err.message);
  }
}

async function savePushSubscription(sub) {
  pushSubscriptions.set(sub.endpoint, sub);
  try {
    await sbWrite('push_subscriptions', 'POST', [{
      endpoint: sub.endpoint,
      p256dh: sub.keys && sub.keys.p256dh,
      auth: sub.keys && sub.keys.auth,
      created_at: new Date().toISOString(),
    }]);
  } catch (err) {
    console.error('[push] 구독 저장 실패 (메모리에는 반영됨):', err.message);
  }
}

async function removePushSubscription(endpoint) {
  pushSubscriptions.delete(endpoint);
  try {
    await sbWrite(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, 'DELETE');
  } catch (err) {
    console.error('[push] 구독 삭제 실패:', err.message);
  }
}

// 등록된 모든 기기에 웹푸시 발송. 구독이 만료/취소된 경우(410/404) 자동 정리.
async function sendWebPushToAll(payload) {
  if (!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)) return;
  const body = JSON.stringify(payload);
  for (const sub of [...pushSubscriptions.values()]) {
    try {
      await webpush.sendNotification(sub, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removePushSubscription(sub.endpoint);
      } else {
        console.error('[push] 발송 실패:', err.statusCode, err.message);
      }
    }
  }
}

// 텔레그램 + 웹푸시 동시 발송 (알림 조건 감지·오늘의 종목 요약에서 공용으로 사용)
async function notifyAll(text, opts = {}) {
  await sendTelegram(text);
  await sendWebPushToAll({
    title: opts.title || 'STOCK RADAR',
    body: text,
    url: opts.url || 'https://bjkim-pixel.github.io/stock-radar-data/',
    tag: opts.tag,
  });
}

async function refreshHoldings() {
  try {
    const positions = await sbGet('positions?select=code,avg_price,peak_price,quantity,invested&portfolio=eq.VIRTUAL&status=eq.OPEN');
    const newHeld = new Set(positions.map(p => p.code));

    positionsByCode.clear();
    positions.forEach(p => positionsByCode.set(p.code, p));

    const missingNames = [...newHeld].filter(c => !codeNames.has(c));
    if (missingNames.length) {
      const rows = await sbGet(`stocks?select=code,name&code=in.(${missingNames.join(',')})`);
      rows.forEach(r => codeNames.set(r.code, r.name));
    }

    heldCodes.clear();
    newHeld.forEach(c => heldCodes.add(c));
    reconcileKisSubscriptions();
  } catch (err) {
    console.error('[holdings] 갱신 실패:', err.message);
  }
}
const HOLDINGS_POLL_MS = 5 * 60 * 1000; // 보유 종목은 하루 단위로만 바뀌므로 5분이면 충분
setInterval(refreshHoldings, HOLDINGS_POLL_MS);

// ----------------------------------------------------------------------------
// 4) 알림 조건 감지 (당일 신고가/신저가, 트레일링 손절 근접/도달, 목표가 도달)
// ----------------------------------------------------------------------------
function getAlertState(code) {
  const today = kstDateStr();
  let st = alertState.get(code);
  if (!st || st.date !== today) {
    st = { date: today, high: null, low: null, highAt: null, lowAt: null,
           alertedHigh: null, alertedLow: null, trailNear: false, trailHit: false, targetHit: false };
    alertState.set(code, st);
  }
  return st;
}

// 틱마다(브로드캐스트 이전에) 보유 종목의 당일 고가/저가와 그 시각을 갱신.
// 알림 스팸 방지용 임계치(alertedHigh/alertedLow)와는 별개로, 실제 당일 고점/저점
// 자체는 여기서 매 틱 정확하게 추적해서 화면 표시(전략성과 "고점"/"고점시각")와
// 트레일링 손절 판정에 공용으로 씀. 보유 종목이 아니면 추적하지 않고 null 반환.
function trackDayHighLow(code, price) {
  if (!heldCodes.has(code)) return null;
  const st = getAlertState(code);
  const now = Date.now();
  st._isNewHigh = false;
  st._isNewLow = false;
  if (st.high == null) {
    st.high = price; st.low = price;
    st.highAt = now; st.lowAt = now;
    st.alertedHigh = price; st.alertedLow = price;
  } else {
    if (price > st.high) { st.high = price; st.highAt = now; st._isNewHigh = true; }
    if (price < st.low) { st.low = price; st.lowAt = now; st._isNewLow = true; }
  }
  return { high: st.high, highAt: st.highAt };
}

// positions.peak_price가 재배포/재시작 후에도 살아남도록, 그리고 relay-server를
// 안 보고 있던 다른 기기·다음 방문에서도 정확한 고점이 보이도록 Supabase에
// 스로틀(종목당 최소 간격)을 두고 써둠. 배치(06_portfolio.py)가 매일 밤 이
// 값을 다시 계산해서 덮어쓰므로, 여기서는 "오늘 하루" 동안만 유효한 값.
const lastPeakWriteAt = new Map(); // code -> 마지막 DB 기록 시각(ms)
const PEAK_WRITE_MIN_INTERVAL_MS = 5000;

async function maybePersistPeak(code, dayHigh) {
  const pos = positionsByCode.get(code);
  if (!pos) return;
  const known = +pos.peak_price || 0;
  if (dayHigh.high <= known) return;              // DB에 이미 반영된 값보다 높지 않으면 쓸 필요 없음
  const last = lastPeakWriteAt.get(code) || 0;
  if (Date.now() - last < PEAK_WRITE_MIN_INTERVAL_MS) return;  // 너무 잦은 쓰기 방지
  lastPeakWriteAt.set(code, Date.now());
  pos.peak_price = dayHigh.high;                  // 로컬 캐시도 즉시 갱신 → effPeak 계산에 바로 반영
  try {
    await sbWrite(
      `positions?portfolio=eq.VIRTUAL&status=eq.OPEN&code=eq.${code}`,
      'PATCH',
      { peak_price: dayHigh.high, peak_at: new Date(dayHigh.highAt).toISOString() }
    );
  } catch (err) {
    console.error(`[peak] ${code} 고점 영속화 실패(다음 틱에 재시도):`, err.message);
  }
}

// 매수가/수익률/수익금을 알림 문구에 덧붙이기 위한 요약 문자열
// (수익률은 사이트 "보유 중" 표와 동일하게 현재가 기준으로 계산: (현재가-매수가)/현재가)
function posInfo(code, price) {
  const pos = positionsByCode.get(code);
  if (!pos) return null;
  const avg = +pos.avg_price;
  if (!Number.isFinite(avg) || avg <= 0) return null;
  const qty = +pos.quantity, invested = +pos.invested;
  const retPct = (price - avg) / price * 100;
  const pnl = (Number.isFinite(qty) && Number.isFinite(invested)) ? Math.round(qty * price - invested) : null;
  const sign = v => (v >= 0 ? '+' : '');
  const bits = [`매수가 ${fmt(avg)}원`, `수익률 ${sign(retPct)}${retPct.toFixed(2)}%`];
  if (pnl != null) bits.push(`수익금 ${sign(pnl)}${fmt(pnl)}원`);
  return bits.join(' · ');
}

function checkAlerts(code, price) {
  if (!heldCodes.has(code)) return; // 보유 중인 종목만 알림 대상
  const name = codeNames.get(code) || code;
  const st = getAlertState(code);
  const info = posInfo(code, price);
  const infoSuffix = info ? ` (${info})` : '';

  // ── 당일 신고가/신저가 알림 ─────────────────────────────────────────
  // st.high/st.low 자체는 trackDayHighLow()가 브로드캐스트 전에 이미 갱신해둠
  // (화면 표시·트레일링 손절 계산 공용). 여기서는 "알림을 보낼지"만 판단 —
  // 마지막으로 알림을 보낸 고점/저점 대비 ALERT_MIN_MOVE_PCT% 이상 갱신됐을
  // 때만 보내서, 상승/하락 추세에서 틱마다 알림이 쏟아지는 걸 방지.
  if (st._isNewHigh && !alertsPaused && price >= st.alertedHigh * (1 + ALERT_MIN_MOVE_PCT / 100)) {
    st.alertedHigh = price;
    notifyAll(`📈 ${name}(${code}) 당일 신고가 갱신: ${fmt(price)}원${infoSuffix}`, { title: `📈 ${name} 신고가`, tag: `high-${code}` });
  }
  if (st._isNewLow && !alertsPaused && price <= st.alertedLow * (1 - ALERT_MIN_MOVE_PCT / 100)) {
    st.alertedLow = price;
    notifyAll(`📉 ${name}(${code}) 당일 신저가 갱신: ${fmt(price)}원${infoSuffix}`, { title: `📉 ${name} 신저가`, tag: `low-${code}` });
  }

  // ── 트레일링 손절(-7%) 근접/도달 ───────────────────────────────────
  const pos = positionsByCode.get(code);
  if (pos) {
    const effPeak = Math.max(+pos.peak_price || 0, st.high || 0);
    if (effPeak > 0) {
      const drawdown = (price / effPeak - 1) * 100;
      if (drawdown <= -7 && !st.trailHit && !alertsPaused) {
        st.trailHit = true;
        notifyAll(`🚨 ${name}(${code}) 트레일링 손절선(-7%) 도달! 고점 대비 ${drawdown.toFixed(1)}% · 현재가 ${fmt(price)}원${infoSuffix}`, { title: `🚨 ${name} 손절선 도달`, tag: `trail-hit-${code}` });
      } else if (drawdown <= -5 && !st.trailNear && !st.trailHit && !alertsPaused) {
        st.trailNear = true;
        notifyAll(`⚠️ ${name}(${code}) 트레일링 손절(-7%) 근접: 고점 대비 ${drawdown.toFixed(1)}% · 현재가 ${fmt(price)}원${infoSuffix}`, { title: `⚠️ ${name} 손절 근접`, tag: `trail-near-${code}` });
      }
    }
  }

  // ── 목표가 도달 (평단보다 높으면 상향 도달, 낮으면 하향 도달로 판단) ──
  const target = targetPrices.get(code);
  if (target && !st.targetHit) {
    const avg = pos ? +pos.avg_price : null;
    const upward = avg == null || target.price >= avg;
    const reached = upward ? price >= target.price : price <= target.price;
    if (reached && !alertsPaused) {
      st.targetHit = true;
      notifyAll(`🎯 ${name}(${code}) 목표가(${fmt(target.price)}원) 도달! 현재가 ${fmt(price)}원${infoSuffix}`, { title: `🎯 ${name} 목표가 도달`, tag: `target-${code}` });
    }
  }
}

// ----------------------------------------------------------------------------
// 5) 텔레그램 전송 + 명령 처리 (목표가 등록/삭제/조회)
// ----------------------------------------------------------------------------
async function sendTelegramTo(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.error('[telegram] 전송 실패:', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[telegram] 전송 에러:', err.message);
  }
}
function sendTelegram(text) {
  if (!TELEGRAM_CHAT_ID) {
    console.warn('[telegram] TELEGRAM_CHAT_ID 미설정 — 메시지 스킵:', text);
    return;
  }
  return sendTelegramTo(TELEGRAM_CHAT_ID, text);
}

function parsePriceNum(s) { return Number(String(s).replace(/[^\d]/g, '')); }

// 종목코드(6자리 숫자) 또는 종목명(보유 종목 기준, 정확히/부분 일치)을 코드로 변환.
// 여러 종목이 부분 일치하면 ambiguous:true와 후보 목록을 돌려줌.
function resolveCode(token) {
  const t = String(token).trim();
  if (/^\d{6}$/.test(t)) return { code: t };
  for (const [code, name] of codeNames.entries()) {
    if (name === t) return { code };
  }
  const partial = [...codeNames.entries()].filter(
    ([, name]) => name.includes(t) || t.includes(name)
  );
  if (partial.length === 1) return { code: partial[0][0] };
  if (partial.length > 1) {
    return { ambiguous: true, candidates: partial.map(([c, n]) => `${n}(${c})`) };
  }
  return { notFound: true };
}

async function handleTelegramCommand(chatId, text) {
  let m;
  if ((m = text.match(/^\/?(?:target|목표가)\s+(\S+)\s+([\d,]+)\s*원?\s*$/i))) {
    const price = parsePriceNum(m[2]);
    const r = resolveCode(m[1]);
    if (r.notFound) {
      await sendTelegramTo(chatId, `"${m[1]}" 종목을 찾지 못했어요. 종목코드로 시도하거나, 보유 종목명으로 정확히 입력해보세요.`);
      return;
    }
    if (r.ambiguous) {
      await sendTelegramTo(chatId, `"${m[1]}"에 해당하는 종목이 여러 개예요: ${r.candidates.join(', ')}\n종목코드로 다시 시도해주세요.`);
      return;
    }
    const code = r.code;
    if (!Number.isFinite(price) || price <= 0) {
      await sendTelegramTo(chatId, '목표가 형식이 올바르지 않아요. 예) /목표가 005930 165000 또는 /목표가 삼성전자 165000');
      return;
    }
    targetPrices.set(code, { price });
    getAlertState(code).targetHit = false;
    await persistTargetPrice(code, price);
    const savedNote = SUPABASE_SERVICE_KEY ? '' : ' (⚠ 영구저장 미설정 — 서버 재배포 시 초기화될 수 있어요)';
    await sendTelegramTo(chatId, `✅ ${codeNames.get(code) || code}(${code}) 목표가 ${fmt(price)}원으로 설정했어요.${savedNote}`);
    return;
  }
  if ((m = text.match(/^\/?(?:target|목표가)\s*(?:clear|삭제|취소)\s+(\S+)\s*$/i))) {
    const r = resolveCode(m[1]);
    if (r.notFound) {
      await sendTelegramTo(chatId, `"${m[1]}" 종목을 찾지 못했어요.`);
      return;
    }
    if (r.ambiguous) {
      await sendTelegramTo(chatId, `"${m[1]}"에 해당하는 종목이 여러 개예요: ${r.candidates.join(', ')}\n종목코드로 다시 시도해주세요.`);
      return;
    }
    const code = r.code;
    targetPrices.delete(code);
    await deleteTargetPrice(code);
    await sendTelegramTo(chatId, `🗑 ${codeNames.get(code) || code}(${code}) 목표가를 삭제했어요.`);
    return;
  }
  if (/^\/?(?:target|목표가)\s*(?:list|목록|확인)\s*$/i.test(text)) {
    if (!targetPrices.size) {
      await sendTelegramTo(chatId, '설정된 목표가가 없어요.');
      return;
    }
    const lines = [...targetPrices.entries()].map(([code, t]) => `${codeNames.get(code) || code}(${code}): ${fmt(t.price)}원`);
    await sendTelegramTo(chatId, '📋 현재 목표가 설정\n' + lines.join('\n'));
    return;
  }
  if (/^\/?(?:알림끄기|알림중지|알림일시정지|mute|pause)\s*$/i.test(text)) {
    alertsPaused = true;
    await sendTelegramTo(chatId, '🔕 신고가·신저가·손절·목표가 알림을 일시정지했어요. ("오늘의 종목" 요약은 계속 발송돼요)\n다시 켜려면 /알림켜기');
    return;
  }
  if (/^\/?(?:알림켜기|알림재개|알림켜|unmute|resume)\s*$/i.test(text)) {
    alertsPaused = false;
    await sendTelegramTo(chatId, '🔔 알림을 다시 켰어요.');
    return;
  }
  if (/^\/?(?:오늘요약|todaysummary|today)\s*$/i.test(text)) {
    await sendTelegramTo(chatId, '오늘의 종목 요약을 불러오는 중…');
    try {
      const text2 = await buildDailySummaryText();
      await sendTelegramTo(chatId, text2);
    } catch (err) {
      await sendTelegramTo(chatId, `요약 생성 실패: ${err.message}`);
    }
    return;
  }
  if (/^\/?(?:help|도움말|start)\s*$/i.test(text)) {
    await sendTelegramTo(chatId,
      '📌 사용 가능한 명령어\n' +
      '/목표가 [종목코드 또는 종목명] [가격] — 목표가 설정 (예: /목표가 005930 165000, /목표가 삼성전자 165000)\n' +
      '/목표가삭제 [종목코드 또는 종목명] — 목표가 삭제\n' +
      '/목표가확인 — 현재 설정 목록\n' +
      '/오늘요약 — "오늘의 종목" 요약 즉시 받기 (매일 16:10엔 자동 발송)\n' +
      '/알림끄기 — 신고가·신저가·손절·목표가 알림 일시정지 (오늘의 종목 요약은 계속 발송)\n' +
      '/알림켜기 — 알림 다시 켜기\n' +
      '※ 종목명은 현재 보유 중인 종목만 인식돼요.\n\n' +
      `보유 종목의 당일 신고가·신저가 갱신(직전 알림 대비 ${ALERT_MIN_MOVE_PCT}% 이상 갱신 시), 트레일링 손절(-7%) 근접·도달은 자동으로 알려드려요.`);
    return;
  }
  if (text.startsWith('/')) {
    await sendTelegramTo(chatId, '이해하지 못했어요. /help 로 사용법을 확인하세요.');
  }
}

let tgUpdateOffset = 0;
async function pollTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${tgUpdateOffset}&timeout=0`);
    const json = await res.json();
    if (!json.ok) return;
    for (const upd of json.result) {
      tgUpdateOffset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      if (!TELEGRAM_CHAT_ID) {
        console.log(`[telegram] 새 메시지 수신 — chat_id=${msg.chat.id} (이 값을 Render 환경변수 TELEGRAM_CHAT_ID로 등록하세요)`);
      }
      handleTelegramCommand(msg.chat.id, msg.text.trim());
    }
  } catch (err) {
    console.error('[telegram] getUpdates 에러:', err.message);
  }
}
setInterval(pollTelegramCommands, 4000);

// ----------------------------------------------------------------------------
// 6) "오늘의 종목" 요약 — 매일 장마감 후 텔레그램으로 발송
// ----------------------------------------------------------------------------
// 사이트의 "오늘의 종목" 탭(종합스코어/섹터RS/수급 상위)과 동일한 로직을
// 서버에서 재계산해 텔레그램 메시지로 요약합니다. 발송 시점(16:10 KST)에는
// Render 무료 플랜이 이미 슬립 상태일 수 있어, 서버 내부 타이머 대신
// GitHub Actions 크론이 /trigger-daily-summary 를 호출하는 방식으로 깨움+발송을
// 한 번에 처리합니다(daily_summary_trigger.yml 참고).
const DAILY_SUMMARY_TOKEN = process.env.DAILY_SUMMARY_TOKEN || '';
if (!DAILY_SUMMARY_TOKEN) {
  console.warn('[오늘의 종목 요약] DAILY_SUMMARY_TOKEN 미설정 — /trigger-daily-summary 가 인증 없이 열려있습니다.');
}

const N1 = (v, d = 0) => (v == null || isNaN(+v)) ? '–' : (+v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pm1 = (v, d = 2) => (v == null || isNaN(+v)) ? '–' : (v > 0 ? '+' : '') + N1(v, d);

async function buildDailySummaryText() {
  const EOK = 1e8, JO = 1e12;
  const TODAY_LIQ_CAP = 1e11, TODAY_LIQ_AMT = 1e9, TODAY_FLOW_CAP = 1e11;

  const dateRows = await sbGet('v_market_overview?select=trade_date&order=trade_date.desc&limit=1');
  const date = dateRows[0]?.trade_date;
  if (!date) throw new Error('기준일(trade_date)을 찾지 못함');

  const [kospiRows, kosdaqRows, amtRows, flowRow, screener, flowPeriods, sectors] = await Promise.all([
    sbGet('market_daily?select=trade_date,index_close,regime&market=eq.KOSPI&order=trade_date.desc&limit=2'),
    sbGet('market_daily?select=trade_date,index_close&market=eq.KOSDAQ&order=trade_date.desc&limit=2'),
    sbGet('v_market_amount_real?select=*&order=trade_date.desc&limit=1'),
    // 이 뷰는 종종 몇 초 걸려서 PostgREST statement timeout에 걸릴 때가 있음 —
    // 실패해도 "최다 순매수 주체" 한 줄만 빠질 뿐 나머지 요약은 정상 발송되게
    // 요약 전체를 막지 않고 null로 넘어감(트리거 워크플로의 3회 재시도와 별개 방어).
    sbGetResilient('v_market_flow_periods?select=*', { label: 'v_market_flow_periods', fallback: [] }).then(r => r[0] || null),
    sbGetResilient(`v_screener?select=*&trade_date=eq.${date}`, { label: 'v_screener', fallback: [] }),
    sbGetResilient('v_stock_flow_periods?select=code,foreign_1d,inst_1d,fin_inv_1d,inv_trust_1d,pension_1d,pe_1d,program_1d', { label: 'v_stock_flow_periods', fallback: [] }),
    sbGetResilient('v_sector_rank?select=*', { label: 'v_sector_rank', fallback: [] }),
  ]);

  const idxChg = rows => (rows.length >= 2 && rows[1].index_close) ? ((+rows[0].index_close / +rows[1].index_close - 1) * 100) : null;
  const kospiChg = idxChg(kospiRows), kosdaqChg = idxChg(kosdaqRows);
  const regime = kospiRows[0]?.regime || null;
  const regimeKr = { RISK_ON: '양호', RISK_OFF: '위험', NEUTRAL: '중립' }[regime] || '–';
  const amt = amtRows[0];

  // 시장 요약 타일의 "최다 순매수 주체" 계산용 (사이트와 동일한 8개 주체)
  const MKT_SUBJ_COLS = ['foreign', 'inst', 'fin_inv', 'inv_trust', 'pension', 'pe', 'corp_other', 'individual'];
  const MKT_SUBJ_SHORT = { foreign: '외국인', inst: '기관', fin_inv: '금투', inv_trust: '투신', pension: '연금', pe: '사모', corp_other: '기타', individual: '개인' };
  function flowVal(row, subj, period) {
    if (subj === 'combo') return (+row['foreign_' + period] || 0) + (+row['inst_' + period] || 0);
    return +row[subj + '_' + period] || 0;
  }
  let topSubj = null, topSubjV = -Infinity;
  if (flowRow) {
    MKT_SUBJ_COLS.forEach(k => { const v = flowVal(flowRow, k, '1d'); if (v > topSubjV) { topSubjV = v; topSubj = k; } });
  }

  const byFlowCode = new Map(flowPeriods.map(p => [p.code, p]));
  const raw = screener.map(r => ({ ...r, ...(byFlowCode.get(r.code) || {}) }));

  // 섹터 RS 상위의 "매수/매도 X/7" 태그 계산용 — 독립 7개 주체(사이트 sectorFlowMap과 동일)
  const FLOW_COMMON_SUBJ = ['foreign', 'fin_inv', 'inv_trust', 'pension', 'pe', 'individual', 'corp_other'];
  function sectorFlowMap(rows) {
    const m = {};
    FLOW_COMMON_SUBJ.forEach(subj => {
      rows.forEach(r => {
        if (!r.sector) return;
        const v = flowVal(r, subj, '1d');
        if (!v) return;
        const g = m[r.sector] || (m[r.sector] = { buySet: new Set(), sellSet: new Set(), net: 0 });
        (v > 0 ? g.buySet : g.sellSet).add(subj);
        g.net += v;
      });
    });
    const out = {};
    Object.keys(m).forEach(k => { out[k] = { buyN: m[k].buySet.size, sellN: m[k].sellSet.size, net: m[k].net }; });
    return out;
  }
  const sflow = sectorFlowMap(raw);

  const todayLiqOk = r => +r.market_cap >= TODAY_LIQ_CAP && +r.trade_amount >= TODAY_LIQ_AMT;
  const universe = raw.filter(todayLiqOk);

  const top5Sectors = sectors.filter(s => s.rs_rank).sort((a, b) => a.rs_rank - b.rs_rank).slice(0, 5);

  // 오늘 강했던 종목 — 사이트 renderTodayMomentum과 동일: 무게/주식수 desc, 개별RS desc, Top10
  const momentumTop = [...universe]
    .sort((a, b) => (+b.weight_per_share || 0) - (+a.weight_per_share || 0)
      || (+(b.rs20_vs_mkt || -999) - +(a.rs20_vs_mkt || -999)))
    .slice(0, 10);

  // 수급 주체별 매수 상위 종목 — 사이트 tdFlowSubjSel의 8개 주체 탭을 전부 순회
  // (pgtr 칩은 "program_*" 컬럼을 씀 — TODAY_FLOW_KEY_MAP과 동일)
  const FLOW_SUBJ_TABS = [
    { key: 'combo', label: '외국인+기관합계' },
    { key: 'foreign', label: '외국인' },
    { key: 'inst', label: '기관합계' },
    { key: 'pgtr', label: '프로그램', col: 'program' },
    { key: 'fin_inv', label: '금융투자' },
    { key: 'inv_trust', label: '투신' },
    { key: 'pension', label: '연기금' },
    { key: 'pe', label: '사모' },
  ];
  const FLOW_TOP_N = 5;
  const flowBySubj = FLOW_SUBJ_TABS.map(tab => {
    const col = tab.col || tab.key;
    const rows = raw.filter(r => +r.market_cap >= TODAY_FLOW_CAP)
      .map(r => {
        const v = flowVal(r, col, '1d');
        const ratio = +r.market_cap > 0 ? v / (+r.market_cap) * 100 : null;
        return { ...r, v, ratio };
      })
      .filter(r => r.v > 0 && r.ratio != null)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, FLOW_TOP_N);
    return { ...tab, rows };
  });

  const lines = [];
  lines.push(`📊 오늘의 종목 요약 (${date})`);
  lines.push('');
  lines.push('📈 시장');
  lines.push(`코스피 ${N1(kospiRows[0]?.index_close, 2)} (${pm1(kospiChg, 2)}%) · 코스닥 ${N1(kosdaqRows[0]?.index_close, 2)} (${pm1(kosdaqChg, 2)}%)`);
  if (amt) {
    const ok = +amt.total_amount >= +amt.amt_ma20;
    lines.push(`거래대금 ${N1(+amt.total_amount / JO, 1)}조 (20일평균 ${ok ? '상회' : '하회'})`);
  }
  lines.push(`시장레짐 ${regimeKr}${topSubj ? ` · 최다 순매수 ${MKT_SUBJ_SHORT[topSubj]}(${pm1(topSubjV / EOK, 0)}억)` : ''}`);

  if (top5Sectors.length) {
    lines.push('');
    lines.push('🏭 주도업종 Top5');
    top5Sectors.forEach((s, i) => {
      const sf = sflow[s.sector];
      const flowTag = sf ? (sf.buyN > sf.sellN ? `매수${sf.buyN}/7` : sf.sellN > sf.buyN ? `매도${sf.sellN}/7` : '중립') : '–';
      lines.push(`${i + 1}. ${s.sector} (RS ${s.rs_rank}위, ${pm1(+s.avg_change_pct)}%, ${flowTag})`);
    });
  }

  if (momentumTop.length) {
    lines.push('');
    lines.push('🔥 오늘 강했던 종목');
    momentumTop.forEach((r, i) => {
      const rsTxt = r.rs20_vs_mkt == null ? '–' : `${pm1(+r.rs20_vs_mkt, 1)}%p`;
      const secRankTxt = r.sector_rs_rank ? `섹터RS${r.sector_rs_rank}위` : '섹터RS–';
      lines.push(`${i + 1}. ${r.name} ${pm1(+r.change_pct)}% · 무게${N1(+r.weight_per_share, 2)} · 개별RS${rsTxt} · ${secRankTxt}`);
    });
  }

  const anyFlow = flowBySubj.some(g => g.rows.length);
  if (anyFlow) {
    lines.push('');
    lines.push('💰 수급 주체별 매수 상위 종목 (시가총액 대비 비중순)');
    flowBySubj.forEach(g => {
      if (!g.rows.length) return;
      lines.push(`[${g.label}]`);
      g.rows.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.name} ${pm1(+r.change_pct)}% · ${pm1(r.v / EOK, 0)}억 · ${r.ratio != null ? pm1(r.ratio, 2) + '%' : '–'}`);
      });
    });
  }

  return lines.join('\n');
}

let lastDailySummaryDate = null;
async function sendDailySummary(force = false) {
  const today = kstDateStr();
  if (!force && lastDailySummaryDate === today) {
    console.log('[오늘의 종목 요약] 오늘 이미 발송함, 스킵');
    return;
  }
  const text = await buildDailySummaryText();
  await notifyAll(text, { title: '📊 오늘의 종목 요약', tag: 'daily-summary' });
  lastDailySummaryDate = today;
  console.log('[오늘의 종목 요약] 발송 완료');
}

// ----------------------------------------------------------------------------
// 7) 프론트엔드용 웹소켓 서버
// ----------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  // /push-subscribe 는 GitHub Pages(다른 오리진)에서 fetch로 호출하므로 CORS 필요
  if (req.url === '/push-subscribe') {
    const origin = req.headers.origin;
    const corsOrigin = (origin&& ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    readBody(req).then(async (raw) => {
      let sub;
      try { sub = JSON.parse(raw); } catch (_) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        return;
      }
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid subscription' }));
        return;
      }
      await savePushSubscription(sub);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch(err => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }
  if (req.url && req.url.startsWith('/trigger-daily-summary')) {
    const u = new URL(req.url, 'http://internal');
    const token = u.searchParams.get('token');
    const force = u.searchParams.get('force') === '1';
    if (DAILY_SUMMARY_TOKEN && token !== DAILY_SUMMARY_TOKEN) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }
    sendDailySummary(force)
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(err => {
        console.error('[오늘의 종목 요약] 트리거 실패:', err.message);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }
  if (req.url && req.url.startsWith('/trigger-intraday-summary')) {
    const u = new URL(req.url, 'http://internal');
    const token = u.searchParams.get('token');
    if (DAILY_SUMMARY_TOKEN && token !== DAILY_SUMMARY_TOKEN) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }
    sangttaDailySummaryDoneFor = null; // 강제 트리거는 이미 정산했어도 다시 계산
    computeAndSaveSangttaDailySummary()
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(err => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }
  // 2026-09-10: 프론트("전략성과2" 화면)가 지금까지는 intraday_candidates
  // 테이블을 직접 다시 읽어서 "표시할 후보"를 자체적으로 근사 추정했음
  // (source.asc,rank.asc 정렬 — PRE_MARKET/NXT/REGULAR가 알파벳순으로 항상
  // SCAN보다 앞에 와서, 정작 장중 실시간으로 새로 뜨는 SCAN 후보가 상위
  // 18개 표시 슬롯에 거의 못 들어가는 문제가 있었음). 게다가 relay-server가
  // 이미 실시간 시세로 마이너스 전환된 종목을 걸러낸 "진짜 지금 추적 중인"
  // sangttaCandidates Set을 따로 들고 있는데, 프론트는 그 결과를 전혀 못
  // 받아서 자체 근사치(DB 원본)를 계속 보여주고 있었음. 이 엔드포인트로
  // 그 실제 목록을 그대로 노출해서 프론트가 근사 대신 이 값을 쓰게 함.
  if (req.url === '/sangtta-candidates') {
    const origin = req.headers.origin;
    const corsOrigin = (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      candidates: [...sangttaCandidates],
      openPositions: [...sangttaOpenPositions.keys()],
    }));
    return;
  }
  // 임시 진단용(2026-09-10) — 위 fetchMinuteChart() 참고. 분석 끝나면 제거 예정.
  if (req.url && req.url.startsWith('/debug/minute-chart')) {
    const u = new URL(req.url, 'http://internal');
    const code = u.searchParams.get('code');
    const hour = u.searchParams.get('hour') || '153000';
    if (!code) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'code query param required' }));
      return;
    }
    fetchMinuteChart(code, hour).then(json => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    }).catch(err => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      kisWsReady,
      subscribedCodes: [...currentKisSubs],
      programTradeSubscribedCodes: [...currentProgramTradeSubs],
      heldCodes: [...heldCodes],
      targetPrices: Object.fromEntries([...targetPrices].map(([c, t]) => [c, t.price])),
      targetPricesPersisted: !!SUPABASE_SERVICE_KEY,
      telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      dailySummaryTokenSet: !!DAILY_SUMMARY_TOKEN,
      lastDailySummaryDate,
      pushConfigured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      pushSubscriptionCount: pushSubscriptions.size,
      alertsPaused,
      approvalKeyAgeMs: approvalKey ? Date.now() - approvalKeyIssuedAt : null,
      sangtta: {
        candidateCount: sangttaCandidates.size,
        openPositionCount: sangttaOpenPositions.size,
        dailySummaryDoneFor: sangttaDailySummaryDoneFor,
      },
      candidateEngine: {
        preMarketDoneFor: _candidateStageDoneFor.preMarket,
        nxtDoneFor: _candidateStageDoneFor.nxt,
        regularDoneFor: _candidateStageDoneFor.regular,
        lastScanAt: _lastScanRunAt ? new Date(_lastScanRunAt).toISOString() : null,
        kisRestTokenAgeMs: kisAccessToken ? Date.now() - (kisAccessTokenExpiresAt - 86400 * 1000) : null,
      },
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (client, req) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn('[client] 허용되지 않은 origin 접속 거부:', origin);
    client.close(4001, 'origin not allowed');
    return;
  }

  client.subscribedCodes = new Set();

  client.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf-8')); } catch (_) { return; }

    if (msg.type === 'subscribe' && Array.isArray(msg.codes)) {
      for (const code of msg.codes) {
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) continue;
        addSubscription(client, code);
        const cached = lastPrice.get(code);
        if (cached) client.send(JSON.stringify(cached));
      }
    } else if (msg.type === 'unsubscribe' && Array.isArray(msg.codes)) {
      for (const code of msg.codes) removeSubscription(client, code);
    }
  });

  client.on('close', () => {
    for (const code of [...client.subscribedCodes]) removeSubscription(client, code);
  });
});

function addSubscription(client, code) {
  if (client.subscribedCodes.has(code)) return;
  client.subscribedCodes.add(code);
  let set = subscribers.get(code);
  if (!set) { set = new Set(); subscribers.set(code, set); }
  set.add(client);
  reconcileKisSubscriptions();
}

function removeSubscription(client, code) {
  client.subscribedCodes.delete(code);
  const set = subscribers.get(code);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) subscribers.delete(code);
  reconcileKisSubscriptions();
}

// ----------------------------------------------------------------------------
// 시작
// ----------------------------------------------------------------------------
if (!SUPABASE_SERVICE_KEY) {
  console.warn('[목표가] SUPABASE_SERVICE_KEY 미설정 — 목표가가 메모리에만 저장되고 재배포 시 초기화됩니다.');
}

issueApprovalKey()
  .then(() => {
    connectKisWs();
    refreshHoldings();
    loadTargetPrices();
    loadPushSubscriptions();
    primeSangttaEntryCounts();
    primeSangttaOpenPositions();
    refreshSangttaCandidates();
    candidateEngineHeartbeat(); // 서버 재시작이 장중 시간대에 일어나도 그 즉시 해당 단계를 따라잡음
    server.listen(PORT, () => {
      console.log(`[server] 릴레이 서버 실행 중 (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('[FATAL] 시작 실패:', err.message);
    process.exit(1);
  });
