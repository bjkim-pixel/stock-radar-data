# 요청 성능 측정 (기준일 2026-11-06, GitHub Runner→Supabase, 브라우저 구간 제외)

| 요청 | 상태 | 1회(ms) | 2회(ms) | 크기(KB) | 행수 |
|---|---|---|---|---|---|
| v_flow_rank_today(뷰) | 200 | 2275 | 2200 | 118 | 311 |
| v_etf_screener 오늘 | 200 | 2150 | 1694 | 82 | 101 |
| v_stock_flow_periods 전체 | 200 | 1658 | 525 | 783 | 576 |
| v_market_overview 전체이력 | 200 | 1287 | 740 | 97 | 290 |
| v_kospi_flow_daily | 200 | 1182 | 623 | 97 | 288 |
| v_screener select=* 전체 | 200 | 804 | 571 | 352 | 311 |
| v_sector_flow_daily(업종1) | 200 | 732 | 355 | 140 | 288 |
| smart_money_state 전체(페이지1) | 200 | 585 | 307 | 179 | 311 |
| v_stock_chart 종목1 전체이력 | 200 | 574 | 686 | 189 | 290 |
| v_market_flow_periods | 200 | 539 | 279 | 2 | 1 |
| v_sector_stocks(업종1,오늘) | 200 | 532 | 201 | 38 | 45 |
| v_sector_rank | 200 | 491 | 500 | 9 | 22 |
| stocks 목록 | 200 | 455 | 425 | 13 | 312 |
| etf_master | 200 | 448 | 422 | 9 | 101 |
| market_daily KOSPI | 200 | 440 | 189 | 26 | 290 |
| rpc flow_rank_on | 200 | 399 | 363 | 118 | 311 |
| flow_cap_ratio 전체 | 200 | 382 | 190 | 38 | 312 |
| sector_flow_daily 6/1~(페이지1) | 200 | 333 | 545 | 115 | 1000 |
| v_screener 상위8 | 200 | 319 | 280 | 1 | 8 |
| v_screener 일부컬럼 전체 | 200 | 275 | 526 | 27 | 311 |
| v_stock_summary 종목1 | 200 | 259 | 499 | 1 | 1 |
| rpc data_version(캐시 버전) | 200 | 224 | 447 | 0 | 7 |
| v_market_amount_real 전체이력 | 200 | 215 | 448 | 26 | 288 |
| v_data_status | 200 | 206 | 445 | 0 | 1 |
| v_stock_flow_periods 종목1 | 200 | 203 | 198 | 2 | 1 |
| v_stock_sector(업종필터) | 200 | 197 | 188 | 37 | 1000 |
| stock_earnings 종목1 | 200 | 190 | 186 | 4 | 19 |
| v_sector_cluster 오늘 | 200 | 189 | 196 | 0 | 0 |
| daily_flow 하루 전종목 | 200 | 189 | 169 | 37 | 311 |
| signals 오늘 V4 | 200 | 188 | 190 | 5 | 22 |
| daily_flow 종목1 5일(N+1 1건) | 200 | 179 | 175 | 0 | 5 |
