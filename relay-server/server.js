// ============================================================================
// KIS 실시간 시세 릴레이 서버
// ============================================================================
// 역할: 한국투자증권(KIS) 실전투자 웹소켓에 접속해서 실시간 체결가를 받아오고,
// 우리 프론트엔드(index.html)가 이 서버의 웹소켓에 붙어서 원하는 종목의
// 실시간 시세를 받아볼 수 있도록 중계합니다.
//
// 흐름:
//   1) 서버 시작 시 KIS App Key/Secret으로 실시간 접속키(approval_key)를 발급받음
//      (approval_key는 유효기간이 있어 주기적으로 재발급함)
//   2) KIS 웹소켓(ws://ops.koreainvestment.com:21000)에 접속
//   3) 프론트엔드 클라이언트가 이 서버 /ws 에 접속해서
//      {"type":"subscribe","codes":["005930","000660"]} 형태로 원하는 종목을 알려주면
//      서버가 (아직 구독 안 한 종목이면) KIS에 실시간 체결가(H0STCNT0)를 등록
//   4) KIS에서 데이터가 오면 파싱해서 구독 중인 프론트엔드 클라이언트들에게 전달
//      {"type":"price","code":"005930","price":71400,"changePct":1.23,"time":"093012"}
//
// 환경변수(.env 또는 Render 대시보드에 등록):
//   KIS_APP_KEY     - 실전투자 App Key
//   KIS_APP_SECRET  - 실전투자 App Secret
//   PORT            - (Render가 자동 주입, 기본 3000)
//   ALLOWED_ORIGIN  - 프론트엔드 도메인 (CORS/Origin 체크용, 콤마로 여러개 가능)
//                     기본값: https://bjkim-pixel.github.io
// ============================================================================

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://bjkim-pixel.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

// 실전투자 도메인 (모의투자로 바꾸려면 openapivts.../ops.../31000 로 교체)
const KIS_REST_BASE = 'https://openapi.koreainvestment.com:9443';
const KIS_WS_URL = 'ws://ops.koreainvestment.com:21000';

if (!KIS_APP_KEY || !KIS_APP_SECRET) {
  console.error('[FATAL] KIS_APP_KEY / KIS_APP_SECRET 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 상태
// ----------------------------------------------------------------------------
let approvalKey = null;
let approvalKeyIssuedAt = 0;
let kisWs = null;
let kisWsReady = false;
let reconnectAttempt = 0;

// code -> Set(clientWs) : 이 종목을 구독 중인 프론트엔드 클라이언트들
const subscribers = new Map();
// code -> 마지막으로 받은 시세 (클라이언트가 새로 구독하자마자 바로 보여줄 캐시)
const lastPrice = new Map();

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

// approval_key는 발급 후 24시간 유효. 12시간마다 선제적으로 재발급하고
// KIS 웹소켓을 재연결(새 키로 재등록)한다.
const APPROVAL_KEY_REFRESH_MS = 12 * 60 * 60 * 1000;
setInterval(() => {
  console.log('[approval_key] 정기 재발급 + 웹소켓 재연결');
  issueApprovalKey()
    .then(() => reconnectKisWs())
    .catch(err => console.error('[approval_key] 재발급 실패:', err.message));
}, APPROVAL_KEY_REFRESH_MS);

// ----------------------------------------------------------------------------
// 2) KIS 웹소켓 연결 + 구독 관리
// ----------------------------------------------------------------------------
function connectKisWs() {
  kisWs = new WebSocket(KIS_WS_URL);
  kisWsReady = false;

  kisWs.on('open', () => {
    console.log('[KIS WS] 연결됨');
    kisWsReady = true;
    reconnectAttempt = 0;
    // 재연결 시 기존에 구독 중이던 종목들을 다시 등록
    for (const code of subscribers.keys()) {
      sendKisSubscribe(code, true);
    }
  });

  kisWs.on('message', (raw) => {
    const text = raw.toString('utf-8');
    handleKisMessage(text);
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
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5)); // 최대 30초
  setTimeout(() => connectKisWs(), delay);
}

function reconnectKisWs() {
  try { kisWs && kisWs.close(); } catch (_) {}
  // close 이벤트 핸들러가 재연결을 예약하므로 별도 호출 불필요.
  // 다만 approval_key 재발급 직후엔 바로 붙고 싶으므로 즉시 시도.
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
    body: {
      input: {
        tr_id: 'H0STCNT0', // 주식 실시간 체결가
        tr_key: code,
      },
    },
  };
  kisWs.send(JSON.stringify(msg));
}

// H0STCNT0(실시간 체결가) 레코드 1건의 필드 순서 중 우리가 쓰는 것만 인덱스로.
// 공식 필드 순서: 0 종목코드, 1 체결시간, 2 현재가, 3 전일대비부호, 4 전일대비,
// 5 전일대비율, ... (전체 40여개 필드 중 앞부분만 사용)
const F_CODE = 0, F_TIME = 1, F_PRICE = 2, F_SIGN = 3, F_DIFF = 4, F_RATE = 5;

function handleKisMessage(text) {
  // PINGPONG 등 제어 메시지는 JSON, 실시간 데이터는 '0|TR_ID|건수|필드^필드^...' 형태
  if (text[0] === '{') {
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    const trId = json.header && json.header.tr_id;
    if (trId === 'PINGPONG') {
      // 살아있음을 알리기 위해 받은 그대로 되돌려준다
      if (kisWs && kisWs.readyState === WebSocket.OPEN) kisWs.send(text);
      return;
    }
    if (json.body && json.body.rt_cd && json.body.rt_cd !== '0') {
      console.warn('[KIS WS] 구독 응답 에러:', json.body.msg1 || json);
    }
    return;
  }

  // 암호화 플래그(0/1) | tr_id | 데이터건수 | 데이터...
  const parts = text.split('|');
  if (parts.length < 4) return;
  const [encFlag, trId, countStr, dataStr] = parts;
  if (trId !== 'H0STCNT0') return; // 다른 tr_id는 아직 미사용

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
      sign: rec[F_SIGN] || null, // 1:상한 2:상승 3:보합 4:하한 5:하락
      time: rec[F_TIME] || null,
    };
    lastPrice.set(code, payload);
    broadcastToSubscribers(code, payload);
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
// 3) 프론트엔드용 웹소켓 서버
// ----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      kisWsReady,
      subscribedCodes: [...subscribers.keys()],
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
        // 캐시된 최근 시세가 있으면 즉시 전달
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
  const isNewCode = !set;
  if (isNewCode) {
    set = new Set();
    subscribers.set(code, set);
  }
  set.add(client);

  if (isNewCode) {
    console.log('[구독 추가]', code);
    sendKisSubscribe(code, true);
  }
}

function removeSubscription(client, code) {
  client.subscribedCodes.delete(code);
  const set = subscribers.get(code);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    subscribers.delete(code);
    lastPrice.delete(code);
    console.log('[구독 해제]', code);
    sendKisSubscribe(code, false);
  }
}

// ----------------------------------------------------------------------------
// 시작
// ----------------------------------------------------------------------------
issueApprovalKey()
  .then(() => {
    connectKisWs();
    server.listen(PORT, () => {
      console.log(`[server] 릴레이 서버 실행 중 (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('[FATAL] 시작 실패:', err.message);
    process.exit(1);
  });
