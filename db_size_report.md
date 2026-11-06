# DB 용량 점검

- DB 전체: 218 MB / 무료 한도 500 MB (남은 282 MB)

| 테이블 | 총크기(MB, 인덱스 포함) | 데이터(MB) | 행수(추정) | 행당 총바이트 |
|---|---|---|---|---|
| daily_metrics | 68.8 | 57.8 | 75560 | 911 |
| daily_flow | 42.0 | 18.9 | 122855 | 342 |
| daily_price | 41.8 | 18.7 | 108107 | 387 |
| daily_program | 17.5 | 11.6 | 90427 | 194 |
| signals | 15.4 | 11.9 | 16505 | 932 |
| etf_daily | 4.1 | 2.4 | 26895 | 151 |
| global_series_daily | 2.7 | 1.5 | 28344 | 95 |
| sector_daily | 2.3 | 1.7 | 10424 | 217 |
| intraday_positions | 2.1 | 1.9 | 1402 | 1508 |
| intraday_decision_events | 2.0 | 1.8 | 2696 | 735 |
| intraday_candidates | 1.4 | 1.2 | 4625 | 312 |
| sector_flow_daily | 0.6 | 0.4 | 3264 | 196 |
| ingest_log | 0.6 | 0.3 | 1964 | 292 |
| smart_money_signal | 0.5 | 0.3 | 4136 | 121 |
| stocks | 0.4 | 0.2 | 10 | 36864 |
| positions | 0.3 | 0.1 | 223 | 1543 |
| global_pack | 0.3 | 0.0 | 3 | 101035 |
| market_daily | 0.2 | 0.1 | 580 | 367 |
| ai_brief | 0.2 | 0.0 | 5 | 40960 |
| journal_images | 0.2 | 0.0 | 1 | 163840 |
| etf_holdings | 0.2 | 0.1 | 432 | 379 |
| smart_money_state | 0.1 | 0.1 | 312 | 368 |
| access_log | 0.1 | 0.0 | 32 | 3072 |
| sector_override | 0.1 | 0.0 | 11 | 7447 |
| flow_cap_ratio | 0.1 | 0.0 | 313 | 262 |

- stocks 행수: 1414
- daily_price 종목/행/기간/거래일수: (442, 108107, datetime.date(2025, 9, 1), datetime.date(2026, 11, 6), 290)
- daily_flow: (589, 122855, datetime.date(2025, 9, 1), datetime.date(2026, 11, 5))
- daily_metrics: (390, 75560, datetime.date(2026, 1, 2), datetime.date(2026, 11, 6))
- smart_money_state: (312, 312)
- etf_daily 행/종목/시작/끝: [(26895, 101, datetime.date(2025, 9, 1), datetime.date(2026, 11, 6))]
- etf_master 행/시총있음: [(101, 101)]
- etf_master 분야별: [('국내 업종·테마', 54), ('인버스·레버리지', 21), ('국가별(해외주식)', 12), ('국내 시장지수', 5), ('원자재', 5), ('커버드콜·옵션', 1), ('현금성·단기채', 1), ('채권', 1), ('통화', 1)]
- 봉수 150 미만 종목: [('0239Z0', 35), ('0219B0', 78), ('0209D0', 93), ('0207G0', 98), ('0197X0', 111), ('0193W0', 111), ('0193T0', 111), ('0193L0', 111), ('0182R0', 139)]
- etf_daily 크기 / DB 전체: [('3960 kB', '208 MB')]