# KIS 실시간 시세 릴레이 서버 + 텔레그램 알림

한국투자증권(KIS) 실전투자 API의 실시간 체결가(H0STCNT0) 웹소켓을 구독해서,
`stock-radar` 프론트엔드가 원하는 종목의 실시간 시세를 받아볼 수 있도록
중계하는 작은 Node.js 서버입니다.

추가로 Supabase의 "보유 중"(positions, status=OPEN) 종목을 5분마다 조회해서
프론트엔드가 열려있지 않아도 항상 그 종목들을 KIS에 구독해두고, 아래 조건을
감지하면 텔레그램으로 알림을 보냅니다.

- 당일 신고가·신저가 갱신
- 트레일링 손절(-7%) 근접(고점 대비 -5%↓) / 도달(-7%↓)
- 텔레그램 명령으로 지정한 목표가 도달

## 텔레그램 명령어

봇에게 아래 메시지를 보내면 됩니다 (`/` 없이 보내도 인식).

- `/목표가 005930 165000` — 삼성전자 목표가를 165,000원으로 설정
- `/목표가삭제 005930` — 목표가 삭제
- `/목표가확인` — 현재 설정된 목표가 목록
- `/help` — 사용법 안내

## 로컬 실행

```bash
cd relay-server
npm install
cp .env.example .env   # 실제 App Key/Secret으로 채우기
npm start
```

## 프론트엔드에서 사용법

```js
const ws = new WebSocket('wss://<render-service>.onrender.com/ws');
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', codes: ['005930', '000660'] }));
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // msg: {type:'price', code, price, changePct, sign, time}
};
```

더 이상 필요 없는 종목은 `{ type: 'unsubscribe', codes: [...] }` 로 해지합니다.
종목당 구독자가 0명이 되면 서버가 자동으로 KIS 쪽 구독도 해지합니다.

## 헬스체크

`GET /health` → `{ ok, kisWsReady, subscribedCodes, heldCodes, targetPrices, telegramConfigured, approvalKeyAgeMs }`

## Render 배포 시 환경변수

- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `ALLOWED_ORIGIN` (기본값 `https://bjkim-pixel.github.io`)
- `TELEGRAM_BOT_TOKEN` — BotFather에서 발급받은 봇 토큰
- `TELEGRAM_CHAT_ID` — 알림 받을 chat_id. 모르면 일단 비워두고 배포한 뒤
  봇에게 아무 메시지나 보내면 서버 로그(Render 대시보드 Logs)에
  `chat_id=...`가 찍힙니다. 그 값을 이 환경변수로 등록하고 재배포하세요.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — 기본값이 이미 stock-radar 것으로
  채워져 있어 보통 설정 불필요 (읽기 전용 public anon key)
- `SUPABASE_SERVICE_KEY` — Supabase 대시보드 › Project Settings › API ›
  `service_role` 비밀키. 목표가(`alert_targets` 테이블) 쓰기 전용으로만
  사용됩니다. **비워두면 목표가가 서버 메모리에만 저장되어 재배포 시
  초기화됩니다** — 반드시 실행해야 하는 `60_alert_targets.sql` 마이그레이션과
  세트입니다. RLS를 우회하는 강력한 키라 절대 프론트엔드 코드나 공개
  저장소에는 넣지 말고 Render 환경변수로만 보관하세요.

## 참고

- 실전투자 도메인 기준입니다 (`openapi.koreainvestment.com:9443`,
  `ws://ops.koreainvestment.com:21000`). 모의투자로 바꾸려면 `server.js`의
  `KIS_REST_BASE`/`KIS_WS_URL`을 모의투자 도메인으로 교체하세요.
- `approval_key`는 24시간 유효해서 12시간마다 자동 재발급 + 웹소켓 재연결합니다.
- 현재는 실시간 체결가(H0STCNT0)만 지원합니다. 호가(H0STASP0) 등은 필요 시 추가.
