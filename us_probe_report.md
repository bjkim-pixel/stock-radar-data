# 미국 개별 종목 수집 가능성 점검 (2026-10-31 01:59 UTC)

## 1) Yahoo Finance 일봉 (OHLCV)
- AAPL: 251봉 · 필드 ['volume', 'high', 'close', 'open', 'low'] · 거래소 NMS · 통화 USD · 최신 2026-10-30 종가 344.6300048828125
- NVDA: 251봉 · 필드 ['open', 'high', 'volume', 'close', 'low'] · 거래소 NMS · 통화 USD · 최신 2026-10-30 종가 204.63999938964844
- JPM: 251봉 · 필드 ['high', 'low', 'volume', 'open', 'close'] · 거래소 NYQ · 통화 USD · 최신 2026-10-30 종가 337.0400085449219
- BRK-B: 251봉 · 필드 ['low', 'close', 'volume', 'open', 'high'] · 거래소 NYQ · 통화 USD · 최신 2026-10-30 종가 542.489990234375

## 2) KIS 해외주식 시세 (이 앱키 권한 확인)
- 토큰 발급/캐시 사용: OK
- 기간별시세(HHDFS76240000) NAS:AAPL: HTTP 500 rt_cd=1 msg=조회 처리 중 오류 발생하였습니다. 재 조회 수행 부탁드립니다. · output2 0건
- 기간별시세(HHDFS76240000) NYS:JPM: HTTP 200 rt_cd=0 msg=정상처리 되었습니다. · output2 100건 · 최신 20261030 종가 337.0400 거래량 7907915 거래대금 2670248385
- 기간별시세(HHDFS76240000) NAS:NVDA: HTTP 500 rt_cd=1 msg=조회 처리 중 오류 발생하였습니다. 재 조회 수행 부탁드립니다. · output2 0건
- 현재가상세(HHDFS76200200) NAS:AAPL: HTTP 500 rt_cd=1 msg=Gateway 라우팅 오류가 발생했습니다.

## 3) DB 현황
- global_series_daily: 행/티커/기간 = (26428, 135, datetime.date(2025, 8, 20), datetime.date(2026, 10, 31))
- 미국 ETF 보유종목 행/고유 종목 = (201, 169)
- 상위 보유종목 예: [('MU', 'Micron Technology, Inc.', 'NMS', 4), ('TSLA', 'Tesla, Inc.', 'NMS', 4), ('NVDA', 'NVIDIA Corporation', 'NMS', 4), ('AMD', 'Advanced Micro Devices, Inc.', 'NMS', 3), ('GEV', 'GE Vernova Inc.', 'NYQ', 3), ('MSFT', 'Microsoft Corporation', 'NMS', 3), ('AVGO', 'Broadcom Inc.', 'NMS', 3), ('DUK', 'Duke Energy Corporation', 'NYQ', 2), ('CAT', 'Caterpillar Inc.', 'NYQ', 2), ('BE', 'Bloom Energy Corporation', 'NYQ', 2), ('PLTR', 'Palantir Technologies Inc.', 'NMS', 2), ('APH', 'Amphenol Corporation', 'NYQ', 2), ('AAPL', 'Apple Inc.', 'NMS', 2), ('ETN', 'Eaton Corporation plc', 'NYQ', 2), ('FGXXX', 'First American Government Obligs X', 'NAS', 2)]
- DB 전체 용량: 201 MB (Supabase 무료 한도 500MB)