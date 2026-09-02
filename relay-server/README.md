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

또한 사이트의 "오늘의 종목" 탭(시장 요약/주도업종/오늘 강했던 종목/수급 주체별
매수 상위)과 같은 로직을 서버에서 재계산해서 매 거래일 16:10 KST에 텔레그램으로
요약을 보냅니다(`.github/workflows/daily_summary_trigger.yml`이 그 시각에
서버를 깨우며 `/trigger-daily-summary`를 호출). 종합스코어 랭킹은 정확도가
검증되지 않은 참고용 휴리스틱이라 요약에서는 제외했습니다.

## 텔레그램 명령어

봇에게 아래 메시지를 보내면 됩니다 (`/` 없이 보내도 인식).

- `/목표가 005930 165000` — 삼성전자 목표가를 165,000원으로 설정
- `/목표가 삼성전자 165000` — 종목명으로도 설정 가능 (현재 보유 중인 종목만 인식)
- `/목표가삭제 005930` (또는 종목명) — 목표가 삭제
- `/목표가확인` — 현재 설정된 목표가 목록
- `/오늘요약` — "오늘의 종목" 요약을 즉시 받기 (자동 발송은 매일 16:10)
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

`GET /health` → `{ ok, kisWsReady, subscribedCodes, heldCodes, targetPrices, targetPricesPersisted, telegramConfigured, dailySummaryTokenSet, lastDailySummaryDate, approvalKeyAgeMs }`

## 오늘의 종목 요약 수동 트리거

`GET /trigger-daily-summary?token=<DAILY_SUMMARY_TOKEN>` — 즉시 요약을 계산해서
텔레그램으로 보냅니다. 같은 날 이미 보냈으면 스킵하고, `&force=1`을 추가하면
이미 보냈어도 다시 보냅니다(테스트용). `DAILY_SUMMARY_TOKEN`이 설정 안 돼 있으면
토큰 검사 없이 열려있으니 반드시 설정하세요.

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
- `DAILY_SUMMARY_TOKEN` — `/trigger-daily-summary` 엔드포인트를 아무나 못 부르게
  막는 임의의 비밀 문자열. GitHub 저장소의 Actions 시크릿에도 같은 값으로
  `DAILY_SUMMARY_TOKEN`을 등록해야 `daily_summary_trigger.yml`이 호출할 수
  있습니다. 비워두면 인증 없이 열려있게 되니 반드시 설정하세요.

## 참고

- 실전투자 도메인 기준입니다 (`openapi.koreainvestment.com:9443`,
  `ws://ops.koreainvestment.com:21000`). 모의투자로 바꾸려면 `server.js`의
  `KIS_REST_BASE`/`KIS_WS_URL`을 모의투자 도메인으로 교체하세요.
- `approval_key`는 24시간 유효해서 12시간마다 자동 재발급 + 웹소켓 재연결합니다.
- 현재는 실시간 체결가(H0STCNT0)만 지원합니다. 호가(H0STASP0) 등은 필요 시 추가.
