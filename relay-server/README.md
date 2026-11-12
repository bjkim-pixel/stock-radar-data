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
매수 상위)과 같은 로직을 서버에서 재계산해서 매 거래일 수집·계산(Daily Collect + Compute)이 끝난 직후 텔레그램으로
요약을 보냅니다(`.github/workflows/daily_summary_trigger.yml`이 그 직후에
서버를 깨우며 `/trigger-daily-summary`를 호출). 종합스코어 랭킹은 정확도가
검증되지 않은 참고용 휴리스틱이라 요약에서는 제외했습니다.

위의 모든 알림(신고가/신저가, 트레일링 손절, 목표가 도달, 오늘의 종목 요약)은
텔레그램과 **PWA 앱 웹푸시**로 동시에 발송됩니다(`notifyAll()`). 사이트를
홈화면에 설치한 기기가 있으면 그 기기로도 알림이 옵니다.

## 장중 실시간 고점(peak) 추적

보유 종목(VIRTUAL 포트폴리오)의 당일 고점은 틱마다 `trackDayHighLow()`가
갱신하고(`/ws` 응답에 `dayHigh`/`dayHighAt` 필드로 실려 프론트 "전략성과" 표의
"고점"/"고점시각" 컬럼을 즉시 갱신), Supabase `positions.peak_price`/`peak_at`에도
스로틀(종목당 최소 5초 간격)을 두고 써둡니다(`maybePersistPeak()`). 이렇게 하면
페이지를 안 보고 있어도, 서버가 재시작돼도(재시작 직후 한 틱만 받으면) 정확한
장중 고점이 유지됩니다.

다만 VIRTUAL 포트폴리오는 `06_portfolio.py`가 실행될 때마다 전 기간을 통째로
재생성하는 구조라, 그 배치가 어떤 날을 다시 계산하는 순간 그날의 `peak_at`은
정확한 분단위 값 대신 그날 15:30(장마감 근사치) KST로 대체됩니다 — "오늘" 하루
동안은 분단위로 정확하다가, 그날 밤 배치가 한 번 더 돌고 나면 근사치로 바뀌는
구조입니다. 장중 실시간 모니터링 용도로는 충분하지만, 분단위 이력을 영구
보존하려면 별도 로그 테이블이 추가로 필요합니다(`62_positions_peak_at.sql` 참고).

## 텔레그램 명령어

봇에게 아래 메시지를 보내면 됩니다 (`/` 없이 보내도 인식).

- `/목표가 005930 165000` — 삼성전자 목표가를 165,000원으로 설정
- `/목표가 삼성전자 165000` — 종목명으로도 설정 가능 (현재 보유 중인 종목만 인식)
- `/목표가삭제 005930` (또는 종목명) — 목표가 삭제
- `/목표가확인` — 현재 설정된 목표가 목록
- `/오늘요약` — "오늘의 종목" 요약을 즉시 받기 (자동 발송은 매 거래일 수집·계산 완료 직후)
- `/알림끄기` — 신고가·신저가·트레일링 손절·목표가 알림을 일시정지 ("오늘의 종목" 요약은 계속 발송됨)
- `/알림켜기` — 알림 다시 켜기
- `/help` — 사용법 안내

신고가·신저가 알림은 스팸 방지를 위해 마지막으로 알림을 보낸 고점/저점 대비
`ALERT_MIN_MOVE_PCT`(기본 1%) 이상 갱신됐을 때만 다시 발송됩니다(틱마다 오지 않음).

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

`GET /health` → `{ ok, kisWsReady, subscribedCodes, heldCodes, targetPrices, targetPricesPersisted, telegramConfigured, dailySummaryTokenSet, lastDailySummaryDate, pushConfigured, pushSubscriptionCount, approvalKeyAgeMs }`

## 웹푸시 구독 등록

`POST /push-subscribe` — 프론트엔드가 `PushManager.subscribe()`로 받은 구독 객체를
그대로 JSON body로 보내면 Supabase `push_subscriptions` 테이블에 저장합니다.
`ALLOWED_ORIGIN`에 등록된 오리진에서만 호출 가능(CORS).

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
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — PWA 웹푸시용 키 쌍
  (`npx web-push generate-vapid-keys`로 생성). 공개키는 `web/index.html`·
  `docs/index.html`에도 그대로 박혀 있어 노출돼도 안전하지만, **비밀키는 반드시
  Render 환경변수로만 보관**하세요. `VAPID_PRIVATE_KEY`가 비어 있으면 웹푸시
  기능 전체가 꺼진 채로 시작하고(텔레그램은 정상 동작) 서버 로그에 경고가 남습니다.
  둘 다 실행해야 하는 `61_push_subscriptions.sql` 마이그레이션과 세트입니다.
- `VAPID_SUBJECT` — 웹푸시 표준이 요구하는 연락처(기본값: 사이트 URL). 보통
  안 바꿔도 됩니다.

## 참고

- 실전투자 도메인 기준입니다 (`openapi.koreainvestment.com:9443`,
  `ws://ops.koreainvestment.com:21000`). 모의투자로 바꾸려면 `server.js`의
  `KIS_REST_BASE`/`KIS_WS_URL`을 모의투자 도메인으로 교체하세요.
- `approval_key`는 24시간 유효해서 12시간마다 자동 재발급 + 웹소켓 재연결합니다.
- 현재는 실시간 체결가(H0STCNT0)만 지원합니다. 호가(H0STASP0) 등은 필요 시 추가.


## 매매 보안 기반 (`trade.js`, 2026-11-12)

KIS 매매 기능의 보안 층입니다. 주문 코드는 아직 없고(3단계), 주문이 반드시 거쳐야 하는 검증만 있습니다.
브라우저는 KIS 키를 갖지 않으며, 모든 `/trade/*` 요청은 서버에서 아래를 확인합니다.

| 항목 | 동작 |
|---|---|
| 로그인 토큰 | `Authorization: Bearer <Supabase 토큰>` 을 `/auth/v1/user` 로 검증(서명·만료), 이메일이 `ALLOWED_EMAIL` 과 같아야 함. 결과 60초 캐시 |
| 거래 PIN | `POST /trade/session {pin}` — `TRADE_PIN_HASH`(PBKDF2)와 비교. 5회 틀리면 30분 잠금. 통과하면 15분(사용할 때마다 연장, 최대 4시간) 세션을 발급, 이후 요청은 `x-trade-session` 헤더 |
| 재전송 방어 | 모든 POST 본문에 `nonce`(12~64자 1회용)와 `ts`(ms) 필수. 같은 nonce 재사용·±30초 밖 시각 거부. `GET /trade/status` 의 `now` 로 시계 차이를 보정 |
| 긴급 정지 | `TRADING_ENABLED=0` 이면 전부 정지, `REAL_TRADING_ENABLED=0` 이면 실전 정지. 화면의 정지 버튼은 `POST /trade/kill`(로그인만), 해제는 `POST /trade/resume`(PIN 세션 필요). 정지 중에도 보유 종목 매도·취소는 허용 |
| 한도 | `checkLimits()` — 1회 금액·1일 누적·동시 보유 종목, `guard()` — 시간대·스위치. 주문 API가 호출 |
| 감사·알림 | 모든 요청(거부 포함)을 `trade_audit` 에 기록(PIN·토큰 원문 제외), PIN 실패·세션 열림·정지/해제·허용 안 된 계정은 텔레그램·웹푸시(+ `NTFY_TOPIC` 있으면 ntfy) |

- PIN 해시는 사이트의 `pin-hash.html` 에서 만듭니다(브라우저 안에서만 계산, 전송 없음).
- 시험: `cd relay-server && npm test` (Supabase 호출은 가짜로 대체)
- 알려진 한계: 세션·PIN 잠금·nonce 는 메모리에 있어 서버 재시작 시 초기화됩니다(재시작 후엔 PIN 다시 입력, 잠금도 풀림).


## 가상매매 (자체 체결 시뮬레이터 · 매매 3단계)

KIS 모의투자를 쓰지 않습니다. 시세·호가는 실전 API 읽기 전용 조회를 그대로 쓰고, 가상 주문·체결·보유는 Supabase `paper_*` 테이블(서비스 키, relay 전용)에만 기록합니다. **이 단계에는 KIS 주문 API를 호출하는 코드가 없습니다.**

| 경로 | 설명 |
|---|---|
| `GET /trade/paper/state` | 보유·미체결·오늘 체결·시장 상태 (거래 세션 필요) |
| `POST /trade/paper/order` | `{code,name,side,type:'limit'|'market',price?,qty,plan?}` — 로그인·PIN 세션·한도·긴급 정지 통과 필요 |
| `POST /trade/paper/cancel` | `{id}` — 자동 매도(익절·손절) 주문은 취소 불가(계획 수정으로) |
| `POST /trade/paper/plan` | `{code, stop|stopPct, target?, steps:[{n,p,q}]}` — 보유 중 계획 수정. 단계 수량 합계 = 매도 가능 수량 |

- 준비: Actions › [수시] DB 테이블·뷰 생성 › 대상 `paper_trading` 실행, Render 환경변수 `TRADING_ENABLED=1`.
- 체결 규칙(`paper-engine.js`): 호가 소진(시장가는 10호가 초과분을 2호가단위 불리하게), 대기 주문은 내 앞 대기 잔량을 체결량이 먼저 소진해야 체결, 시세 조회 사이 거래량 증가분 안에서만 체결. 정규장(09:00~15:30)·휴장일(KIS chk-holiday)·시세 갱신 여부를 확인하고, VI·거래정지는 거부.
- 호가 10단계 저장: 09:00·12:00·15:10(보유·미체결 종목)과 주문·체결 시점만, 14일 뒤 자동 삭제.
- 서버 재시작: 보유·미체결을 DB에서 복구. 재시작 사이의 거래량은 체결로 인정하지 않음(보수적).
- 테스트: `npm test` (relay + 체결 규칙 + 계산).

### 자동 매도 엔진 (매매 4단계)

5초마다(정규장·거래일·시세 갱신 확인) 종목별로: ① 대기 주문 체결 판단 → ② 손절 확인(현재가 또는 시세 사이 새 저가 ≤ 손절가면 걸린 매도 주문을 모두 취소하고 남은 수량 전부 시장가 매도, 체결 못 하면 다음 주기 재시도) → ③ 익절 1~5단계 지정가 매도를 계획 비중대로 맞춰 걸어둠(이미 맞으면 그대로 두어 대기 순서 유지).
- 손절가: 계획에 % 가 있으면 실제 평균 매수가 기준, 가격이면 그 가격. 긴급 정지 중에도 매도는 계속(정지는 신규 매수만). `TRADING_ENABLED=0` 이면 엔진 전체가 멈춤.
- 장 마감(15:30) 후 당일 주문은 소멸, 다음 거래일 첫 시세에서 다시 접수(시가가 손절가 아래면 즉시 손절).
- 부분 체결: 체결된 수량만큼만 익절을 걸고, 추가 체결 때 다시 배분. 수동 매도는 익절 주문을 먼저 취소하고 남은 수량으로 다시 배분.
- 알림: 감시 시작(장 시작)·장 마감 요약·익절·손절·장중 재시작·손절 실패·시세 조회 실패(같은 내용 10분에 한 번).
- 같은 주문 버튼 연타: 화면이 주문마다 만드는 `cid` 가 같으면 처음 결과를 돌려줌.

### 성과 리포트 (매매 5단계)

`GET /trade/paper/report?from=YYYY-MM-DD&to=YYYY-MM-DD` (거래 세션 필요, 날짜 생략 = 전체) — `paper-report.js` 순수 계산.
기간 요약(실현·평가·합계·실현 수익률·같은 기간 코스피), 월별 실현손익·누적, 매매 통계(보유 0→0 = 1회: 승률·평균 이익/손실·손익비·손절 비율·평균 보유일), 종목별 수익, 체결 품질(시장가·손절의 기준가 대비 불리 %, 지정가 체결률·첫 체결까지 시간), 주문 내역(출처: 직접·자동 익절·자동 손절·장 시작 재접수), 거부된 요청(trade_audit).
슬리피지 기준가는 주문마다 `paper_orders.ref_price` 에 저장(손절 = 손절가, 시장가 = 주문 순간 상대 1호가, 지정가 = 지정가).

## 실전매매 (매매 6단계 · `live.js` + `kis-order.js`)

KIS 주문 API 를 부르는 코드는 `kis-order.js` 하나뿐입니다. 규격은 KIS 공식 예제 저장소(koreainvestment/open-trading-api)로 확인: 현금 주문 `order-cash` 매수 TTTC0012U·매도 TTTC0011U, 취소 `order-rvsecncl` TTTC0013U(02·잔량 전부), 일별 주문체결 `inquire-daily-ccld` TTTC0081R, 잔고 `inquire-balance` TTTC8434R. 주문 요청은 자동 재시도하지 않습니다.

| 경로 | 설명 |
|---|---|
| `GET /trade/live/state` | 잔고(KIS)·우리 주문·오늘 체결·예수금·감시 상태 |
| `POST /trade/live/order` · `/cancel` · `/plan` | 가상과 같은 형식. 실전 한도(1회 50만·1일 200만·5종목) 적용 |
| `GET /trade/live/report` | 가상과 같은 리포트 + `shadow`(같은 순간 호가로 계산한 가상 체결가 대비 실제 체결 차이) |
| `GET /trade/live/probe` | 계좌 연결 점검: 잔고·체결조회 응답의 필드 이름과 건수만(값·계좌번호 없음) |

- 켜는 조건: `TRADING_ENABLED=1` + `REAL_TRADING_ENABLED=1` + `KIS_ACCOUNT_NO` + Actions `live_trading` 테이블 생성.
- 주문 전 DB 기록 → KIS 주문. 응답을 못 받으면 '접수 확인 중'으로 두고 체결조회로 같은 종목·방향·수량·시각의 주문을 찾아 연결(60초 안에 없으면 접수 안 됨 + 알림). 확인 중인 주문이 있는 종목은 새 주문·자동 매도를 내지 않음.
- 손절: 걸린 매도 취소 → 잔고 재조회 → 실제 매도 가능 수량만 시장가 매도(취소 실패분은 빼고, 다음 주기 재시도). 익절 재배분은 취소가 체결조회로 확인된 다음 주기에 새 주문.
- 계획 없는 보유 종목(HTS 매수 등)은 자동 매도하지 않음. 장 마감 후 15:40 까지 종가 단일가 체결을 받아 두고 남은 주문을 소멸 처리.
