## 전략 목록 (auto_strategies 열: archived, builtin, created_at, desc, enabled, id, kind, name, params, source, updated_at, version )

- `closing-default` **장중 강세 이월** · closing · 켜짐=False · v4 · 모드=paper · 승인=auto · 실전자동승인=False · dryDays=None · source=None
- `intraday-default` **수급 돌파 장중** · intraday · 켜짐=True · v2 · 모드=paper · 승인=auto · 실전자동승인=None · dryDays=None · source=None
- `intraday-mwn2lizr` **수급 돌파 장중 (실전)** · intraday · 켜짐=True · v7 · 모드=dryrun · 승인=auto · 실전자동승인=False · dryDays=10 · source=intraday-default

## 짝(원본→실전) 설정 차이

### 수급 돌파 장중 (`intraday-default`) ↔ 수급 돌파 장중 (실전) (`intraday-mwn2lizr`) — 다른 항목 31개

- `altAutoBuy`: 원본 `null` / 실전 `true`
- `altFlowMinEok`: 원본 `null` / 실전 `1`
- `altFlowOn`: 원본 `null` / 실전 `true`
- `amtMinEok`: 원본 `null` / 실전 `100`
- `cancelWaitMin`: 원본 `null` / 실전 `3`
- `dryDays`: 원본 `null` / 실전 `10`
- `execMode`: 원본 `null` / 실전 `"dryrun"`
- `kwMax`: 원본 `null` / 실전 `100`
- `kwOn`: 원본 `null` / 실전 `true`
- `liveAutoOk`: 원본 `null` / 실전 `false`
- `maxOrdersDay`: 원본 `null` / 실전 `20`
- `maxTries`: 원본 `null` / 실전 `3`
- `minOrderKrw`: 원본 `null` / 실전 `100000`
- `minRr`: 원본 `null` / 실전 `3`
- `paperCapitalKrw`: 원본 `null` / 실전 `10000000`
- `ratchet`: 원본 `null` / 실전 `true`
- `regimeCaution`: 원본 `null` / 실전 `50`
- `regimeDefense`: 원본 `null` / 실전 `25`
- `regimeMode`: 원본 `null` / 실전 `"info"`
- `rejectStop`: 원본 `null` / 실전 `3`
- `repriceTo`: 원본 `null` / 실전 `"bid1"`
- `retryUnfilled`: 원본 `null` / 실전 `true`
- `runnerPct`: 원본 `null` / 실전 `20`
- `sizeMode`: 원본 `null` / 실전 `"balance"`
- `sizePct`: 원본 `null` / 실전 `0`
- `smxWin`: 원본 `null` / 실전 `"63"`
- `totalCapKrw`: 원본 `null` / 실전 `0`
- `tpStyle`: 원본 `null` / 실전 `"r"`
- `unfilledEnd`: 원본 `null` / 실전 `"cancel"`
- `unsureStop`: 원본 `null` / 실전 `2`
- `weights`: 원본 `{"amt": 15, "cttr": 15, "flow": 40, "rise": 15, "trend": 15}` / 실전 `{"kw": 10, "amt": 15, "cttr": 15, "flow": 35, "rise": 15, "trend": 10}`

## 드라이런 기록(auto_config.dryrun)

```json
{
 "items": {
  "intraday-mwn2lizr": {
   "at": 1795083185991,
   "since": "2026-11-20",
   "notified": "2026-11-24"
  }
 }
}
```

## 스위치(auto_config.main: on/liveOn만)

{'on': True, 'liveOn': True}

## 최근 실행 기록(auto_runs) 전략×거래일

- `intraday-default`: 2026-11-16, 2026-11-17, 2026-11-18, 2026-11-19, 2026-11-20, 2026-11-23, 2026-11-24
- `intraday-mwn2lizr`: 2026-11-20, 2026-11-23, 2026-11-24
