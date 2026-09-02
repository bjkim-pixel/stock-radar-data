# KIS 실시간 시세 릴레이 서버

한국투자증권(KIS) 실전투자 API의 실시간 체결가(H0STCNT0) 웹소켓을 구독해서,
`stock-radar` 프론트엔드가 원하는 종목의 실시간 시세를 받아볼 수 있도록
중계하는 작은 Node.js 서버입니다.

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

`GET /health` → `{ ok, kisWsReady, subscribedCodes, approvalKeyAgeMs }`

## Render 배포 시 환경변수

- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `ALLOWED_ORIGIN` (기본값 `https://bjkim-pixel.github.io`)

## 참고

- 실전투자 도메인 기준입니다 (`openapi.koreainvestment.com:9443`,
  `ws://ops.koreainvestment.com:21000`). 모의투자로 바꾸려면 `server.js`의
  `KIS_REST_BASE`/`KIS_WS_URL`을 모의투자 도메인으로 교체하세요.
- `approval_key`는 24시간 유효해서 12시간마다 자동 재발급 + 웹소켓 재연결합니다.
- 현재는 실시간 체결가(H0STCNT0)만 지원합니다. 호가(H0STASP0) 등은 필요 시 추가.
