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
//   3) 텔레그램 봇에 "/목표가 종목코드 가격" 같은 명령을 보내면 목표가를
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
// service_role 키 — 목표가(alert_targets) 쓰기 전용. RLS를 우회하므로 절대
// 프론트엔드에는 넣지 말고 Render 환경변수로만 보관. 없으면 목표가는
// 메모리에만 저장되고(재배포 시 초기화) 경고만 남김.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

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
const currentKisSubs = new Set(); // 지금 KIS에 실제로 등록해둔 코드

const heldCodes = new Set();        // "보유 중" 종목 코드 (Supabase에서 주기적으로 갱신)
const positionsByCode = new Map();  // code -> {avg_price, peak_price}
const codeNames = new Map();        // code -> 종목명
const targetPrices = new Map();     // code -> {price} (텔레그램 명령으로 설정)
const alertState = new Map();       // code -> {date, high, low, alertedHigh, alertedLow, trailNear, trailHit, targetHit}

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
    currentKisSubs.clear(); // 새 연결이라 KIS 쪽엔 아무것도 등록 안 된 상태
    reconcileKisSubscriptions();
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

// tr_type: '1' = 등록(구독), '2' = 해지
function sendKisSubscribe(code, subscribe) {
  if (!kisWsReady || !approvalKey) return;
  const msg = {
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: subscribe ? '1' : '2',
      'content-type': 'utf-8',
    },
    body: { input: { tr_id: 'H0STCNT0', tr_key: code } },
  };
  kisWs.send(JSON.stringify(msg));
}

const F_CODE = 0, F_TIME = 1, F_PRICE = 2, F_SIGN = 3, F_DIFF = 4, F_RATE = 5;

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

    const payload = {
      type: 'price',
      code,
      price,
      changePct: Number.isFinite(rate) ? rate : null,
      sign: rec[F_SIGN] || null,
      time: rec[F_TIME] || null,
    };
    lastPrice.set(code, payload);
    broadcastToSubscribers(code, payload);
    checkAlerts(code, price);
  }
}

function broadcastToSubscribers(code, payload) {
  const set = subscribers.get(code);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
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
    st = { date: today, high: null, low: null, alertedHigh: false, alertedLow: false, trailNear: false, trailHit: false, targetHit: false };
    alertState.set(code, st);
  }
  return st;
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

  // ── 당일 신고가/신저가 갱신 ─────────────────────────────────────────
  if (st.high == null) {
    st.high = price;
    st.low = price;
  } else {
    if (price > st.high) {
      st.high = price;
      sendTelegram(`📈 ${name}(${code}) 당일 신고가 갱신: ${fmt(price)}원${infoSuffix}`);
    }
    if (price < st.low) {
      st.low = price;
      sendTelegram(`📉 ${name}(${code}) 당일 신저가 갱신: ${fmt(price)}원${infoSuffix}`);
    }
  }

  // ── 트레일링 손절(-7%) 근접/도달 ───────────────────────────────────
  const pos = positionsByCode.get(code);
  if (pos) {
    const effPeak = Math.max(+pos.peak_price || 0, st.high || 0);
    if (effPeak > 0) {
      const drawdown = (price / effPeak - 1) * 100;
      if (drawdown <= -7 && !st.trailHit) {
        st.trailHit = true;
        sendTelegram(`🚨 ${name}(${code}) 트레일링 손절선(-7%) 도달! 고점 대비 ${drawdown.toFixed(1)}% · 현재가 ${fmt(price)}원${infoSuffix}`);
      } else if (drawdown <= -5 && !st.trailNear && !st.trailHit) {
        st.trailNear = true;
        sendTelegram(`⚠️ ${name}(${code}) 트레일링 손절(-7%) 근접: 고점 대비 ${drawdown.toFixed(1)}% · 현재가 ${fmt(price)}원${infoSuffix}`);
      }
    }
  }

  // ── 목표가 도달 (평단보다 높으면 상향 도달, 낮으면 하향 도달로 판단) ──
  const target = targetPrices.get(code);
  if (target && !st.targetHit) {
    const avg = pos ? +pos.avg_price : null;
    const upward = avg == null || target.price >= avg;
    const reached = upward ? price >= target.price : price <= target.price;
    if (reached) {
      st.targetHit = true;
      sendTelegram(`🎯 ${name}(${code}) 목표가(${fmt(target.price)}원) 도달! 현재가 ${fmt(price)}원${infoSuffix}`);
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

function parsePriceNum(s) { return Number(String(s).replace(/,/g, '')); }

async function handleTelegramCommand(chatId, text) {
  let m;
  if ((m = text.match(/^\/?(?:target|목표가)\s+(\d{6})\s+([\d,]+)\s*$/i))) {
    const code = m[1], price = parsePriceNum(m[2]);
    if (!Number.isFinite(price) || price <= 0) {
      await sendTelegramTo(chatId, '목표가 형식이 올바르지 않아요. 예) /목표가 005930 165000');
      return;
    }
    targetPrices.set(code, { price });
    getAlertState(code).targetHit = false;
    await persistTargetPrice(code, price);
    const savedNote = SUPABASE_SERVICE_KEY ? '' : ' (⚠ 영구저장 미설정 — 서버 재배포 시 초기화될 수 있어요)';
    await sendTelegramTo(chatId, `✅ ${codeNames.get(code) || code}(${code}) 목표가 ${fmt(price)}원으로 설정했어요.${savedNote}`);
    return;
  }
  if ((m = text.match(/^\/?(?:target|목표가)\s*(?:clear|삭제|취소)\s+(\d{6})\s*$/i))) {
    const code = m[1];
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
  if (/^\/?(?:help|도움말|start)\s*$/i.test(text)) {
    await sendTelegramTo(chatId,
      '📌 사용 가능한 명령어\n' +
      '/목표가 [종목코드] [가격] — 목표가 설정 (예: /목표가 005930 165000)\n' +
      '/목표가삭제 [종목코드] — 목표가 삭제\n' +
      '/목표가확인 — 현재 설정 목록\n\n' +
      '보유 종목의 당일 신고가·신저가 갱신, 트레일링 손절(-7%) 근접·도달은 자동으로 알려드려요.');
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
// 6) 프론트엔드용 웹소켓 서버
// ----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      kisWsReady,
      subscribedCodes: [...currentKisSubs],
      heldCodes: [...heldCodes],
      targetPrices: Object.fromEntries([...targetPrices].map(([c, t]) => [c, t.price])),
      targetPricesPersisted: !!SUPABASE_SERVICE_KEY,
      telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      approvalKeyAgeMs: approvalKey ? Date.now() - approvalKeyIssuedAt : null,
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
    server.listen(PORT, () => {
      console.log(`[server] 릴레이 서버 실행 중 (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('[FATAL] 시작 실패:', err.message);
    process.exit(1);
  });
