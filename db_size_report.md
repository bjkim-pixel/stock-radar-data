# DB 용량 점검

- DB 전체: 223 MB / 무료 한도 500 MB (남은 277 MB)

| 테이블 | 총크기(MB, 인덱스 포함) | 데이터(MB) | 행수(추정) | 행당 총바이트 |
|---|---|---|---|---|
| daily_metrics | 70.5 | 58.9 | 75351 | 936 |
| daily_flow | 42.1 | 18.9 | 122911 | 343 |
| daily_price | 41.9 | 18.7 | 107822 | 388 |
| daily_program | 18.1 | 12.1 | 90142 | 201 |
| signals | 15.0 | 11.4 | 15889 | 944 |
| etf_daily | 4.1 | 2.4 | 26895 | 151 |
| global_series_daily | 2.7 | 1.5 | 28541 | 95 |
| sector_daily | 2.3 | 1.7 | 10424 | 222 |
| intraday_positions | 2.1 | 1.9 | 1408 | 1513 |
| intraday_decision_events | 2.0 | 1.8 | 2712 | 734 |
| journal_images | 1.5 | 0.0 | 10 | 153190 |
| intraday_candidates | 1.5 | 1.2 | 4729 | 308 |
| sector_flow_daily | 1.1 | 0.8 | 3780 | 288 |
| global_pack | 1.0 | 0.0 | 4 | 239616 |
| stock_earnings | 0.8 | 0.6 | 5704 | 139 |
| ingest_log | 0.6 | 0.3 | 1989 | 288 |
| smart_money_signal | 0.5 | 0.3 | 4139 | 121 |
| stocks | 0.4 | 0.2 | 9 | 40960 |
| positions | 0.3 | 0.1 | 134 | 2262 |
| ai_brief | 0.3 | 0.0 | 6 | 49152 |
| market_daily | 0.2 | 0.1 | 580 | 367 |
| etf_holdings | 0.2 | 0.1 | 432 | 379 |
| journal_entries | 0.1 | 0.0 | 14 | 8777 |
| smart_money_state | 0.1 | 0.1 | 311 | 369 |
| access_log | 0.1 | 0.0 | 37 | 2657 |

- stocks 행수: 1413
- daily_price 종목/행/기간/거래일수: (441, 107822, datetime.date(2025, 9, 1), datetime.date(2026, 11, 6), 290)
- daily_flow: (588, 122911, datetime.date(2025, 9, 1), datetime.date(2026, 11, 6))
- daily_metrics: (389, 75351, datetime.date(2026, 1, 2), datetime.date(2026, 11, 6))
- smart_money_state: (311, 311)
- etf_daily 행/종목/시작/끝: [(26895, 101, datetime.date(2025, 9, 1), datetime.date(2026, 11, 6))]
- etf_master 행/시총있음: [(101, 101)]
- etf_master 분야별: [('국내 업종·테마', 54), ('인버스·레버리지', 21), ('국가별(해외주식)', 12), ('국내 시장지수', 5), ('원자재', 5), ('커버드콜·옵션', 1), ('현금성·단기채', 1), ('채권', 1), ('통화', 1)]
- 봉수 150 미만 종목: [('0239Z0', 35), ('0219B0', 78), ('0209D0', 93), ('0207G0', 98), ('0197X0', 111), ('0193W0', 111), ('0193T0', 111), ('0193L0', 111), ('0182R0', 139)]
- etf_daily 크기 / DB 전체: [('3960 kB', '213 MB')]