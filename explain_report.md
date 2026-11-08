# EXPLAIN ANALYZE (PG 17.6, 기준일 2026-11-06)

| 쿼리 | 실행(ms) | 계획(ms) | 행 |
|---|---|---|---|
| v_stock_flow_periods 전체 | 3677 | 25 | 576 |
| v_stock_flow_periods 1종목 | 34 | 1 | 1 |
| v_etf_screener 오늘 | 4340 | 25 | 101 |
| v_flow_rank_today 오늘 | 2911 | 1 | 311 |
| flow_rank_on 오늘 | 171 | 0 | 311 |
| v_market_overview | 324 | 16 | 290 |
| v_kospi_flow_daily | 627 | 3 | 288 |
| v_stock_chart 1종목 | 123 | 8 | 290 |
| v_screener 오늘 * | 281 | 57 | 311 |
| v_stock_summary 1종목 | 92 | 3 | 1 |
| v_sector_rank | 88 | 0 | 22 |
| v_sector_flow_daily 반도체 | 58 | 1 | 288 |
| v_sector_stocks 반도체 오늘 | 4 | 2 | 45 |
| v_market_amount_real | 15 | 3 | 288 |
| v_market_flow_periods | 124 | 1 | 1 |
| v_data_status | 0 | 2 | 1 |
| distinct trade_date daily_price | 25 | 0 | 290 |

## v_stock_flow_periods 전체
```
Hash Join   rows=576 loops=1 t=3676.214
  WindowAgg   rows=290 loops=1 t=354.808
    Sort   rows=290 loops=1 t=354.057
      Unique   rows=290 loops=1 t=353.65
        Index Only Scan daily_price idx_price_date rows=107822 loops=1 t=343.818
  Aggregate   rows=576 loops=1 t=2558.726
    Nested Loop   rows=50684 loops=1 t=2449.229
      CTE Scan   rows=125 loops=1 t=355.07
      Index Scan daily_flow idx_flow_date rows=405 loops=125 t=15.25
  Hash   rows=312 loops=1 t=1117.065
    Subquery Scan   rows=312 loops=1 t=1116.897
      Aggregate   rows=312 loops=1 t=1116.843
        Nested Loop   rows=38978 loops=1 t=1092.169
          CTE Scan   rows=125 loops=1 t=0.28
          Index Scan daily_program daily_program_pkey rows=312 loops=125 t=8.677
```

## v_etf_screener 오늘
```
Subquery Scan   rows=101 loops=1 t=4337.086
  WindowAgg   rows=101 loops=1 t=4337.046
    Sort   rows=101 loops=1 t=4335.44
      WindowAgg   rows=101 loops=1 t=4335.309
        Sort   rows=101 loops=1 t=4335.185
          Subquery Scan   rows=101 loops=1 t=4334.923
            WindowAgg   rows=26895 loops=1 t=4332.406
              Sort   rows=26895 loops=1 t=4262.35
                Hash Join   rows=26895 loops=1 t=4197.451
                  Hash Join   rows=26895 loops=1 t=1054.907
                    Subquery Scan   rows=26895 loops=1 t=1031.074
                      WindowAgg   rows=26895 loops=1 t=1021.274
                        WindowAgg   rows=26895 loops=1 t=975.42
                          WindowAgg   rows=26895 loops=1 t=916.065
                            WindowAgg   rows=26895 loops=1 t=855.332
                              WindowAgg   rows=26895 loops=1 t=482.238
                                WindowAgg   rows=26895 loops=1 t=423.907
                                  WindowAgg   rows=26895 loops=1 t=361.802
                                    Index Scan etf_daily etf_daily_pkey rows=26895 loops=1 t=254.469
                    Hash   rows=101 loops=1 t=4.359
                      Seq Scan etf_master  rows=101 loops=1 t=4.309
                  Hash   rows=290 loops=1 t=3126.315
                    Subquery Scan   rows=290 loops=1 t=3126.203
                      Aggregate   rows=290 loops=1 t=3126.157
                        WindowAgg   rows=107822 loops=1 t=3071.552
                          Incremental Sort   rows=107822 loops=1 t=2961.157
                            Index Scan daily_price idx_price_code_date rows=107822 loops=1 t=2888.197
```

## v_flow_rank_today 오늘
```
Subquery Scan   rows=311 loops=1 t=2910.102
  WindowAgg   rows=112125 loops=1 t=2899.339
    WindowAgg   rows=112125 loops=1 t=2712.244
      Incremental Sort   rows=112125 loops=1 t=2601.244
        WindowAgg   rows=112125 loops=1 t=2499.221
          Incremental Sort   rows=112125 loops=1 t=2387.486
            WindowAgg   rows=112125 loops=1 t=2285.638
              Incremental Sort   rows=112125 loops=1 t=2173.921
                WindowAgg   rows=112125 loops=1 t=2065.766
                  Incremental Sort   rows=112125 loops=1 t=1954.816
                    WindowAgg   rows=112125 loops=1 t=1855.563
                      Incremental Sort   rows=112125 loops=1 t=1744.674
                        WindowAgg   rows=112125 loops=1 t=1649.28
                          Incremental Sort   rows=112125 loops=1 t=1538.886
                            WindowAgg   rows=112125 loops=1 t=1442.4
                              Incremental Sort   rows=112125 loops=1 t=1332.469
                                WindowAgg   rows=112125 loops=1 t=1232.843
                                  Incremental Sort   rows=112125 loops=1 t=1125.864
                                    WindowAgg   rows=112125 loops=1 t=1019.3
                                      Sort   rows=112125 loops=1 t=907.998
                                        Hash Join   rows=112125 loops=1 t=527.634
                                          Seq Scan daily_flow  rows=122911 loops=1 t=229.816
                                          Hash   rows=260 loops=1 t=22.472
                                            Limit   rows=260 loops=1 t=22.397
                                              Unique   rows=260 loops=1 t=22.356
                                                Index Only Scan daily_price idx_price_date rows=96397 loops=1 t=14.015
```

## v_market_overview
```
WindowAgg   rows=290 loops=1 t=323.576
  WindowAgg   rows=290 loops=1 t=322.972
    Aggregate   rows=290 loops=1 t=322.254
      Gather Merge   rows=578 loops=1 t=320.838
        Sort   rows=289 loops=2 t=200.655
          Aggregate   rows=289 loops=2 t=200.417
            Hash Join   rows=45055 loops=2 t=176.681
              Hash Join   rows=53879 loops=2 t=150.412
                Seq Scan daily_flow  rows=61456 loops=2 t=11.603
                Hash   rows=53879 loops=2 t=73.867
                  Seq Scan daily_price  rows=53879 loops=2 t=42.149
              Hash   rows=312 loops=2 t=1.807
                Index Scan stocks idx_stocks_active rows=312 loops=2 t=1.72
```

## v_kospi_flow_daily
```
Aggregate   rows=288 loops=1 t=627.202
  Gather Merge   rows=576 loops=1 t=624.198
    Sort   rows=288 loops=2 t=610.35
      Aggregate   rows=288 loops=2 t=610.043
        Nested Loop   rows=32586 loops=2 t=582.915
          Hash Join   rows=32822 loops=2 t=50.396
            Seq Scan daily_price  rows=53911 loops=2 t=24.799
            Hash   rows=227 loops=2 t=0.535
              Index Scan stocks idx_stocks_active rows=227 loops=2 t=0.464
          Index Scan daily_flow idx_flow_code_date rows=1 loops=65644 t=0.015
```

## v_stock_chart 1종목
```
WindowAgg   rows=290 loops=1 t=123.26
  WindowAgg   rows=290 loops=1 t=122.099
    WindowAgg   rows=290 loops=1 t=121.359
      WindowAgg   rows=290 loops=1 t=120.592
        WindowAgg   rows=290 loops=1 t=119.868
          WindowAgg   rows=290 loops=1 t=119.011
            Nested Loop   rows=290 loops=1 t=117.6
              Nested Loop   rows=290 loops=1 t=117.263
                Merge Join   rows=290 loops=1 t=1.098
                  Index Scan daily_price idx_price_code_date rows=290 loops=1 t=0.417
                  Materialize   rows=288 loops=1 t=0.303
                    Index Scan daily_flow idx_flow_code_date rows=288 loops=1 t=0.173
                Index Scan daily_program daily_program_pkey rows=1 loops=290 t=0.399
              Materialize   rows=1 loops=290 t=0.0
                Index Scan stocks stocks_pkey rows=1 loops=1 t=0.013
```

## v_screener 오늘 *
```
Nested Loop   rows=311 loops=1 t=280.234
  Hash Join   rows=311 loops=1 t=277.922
    Hash Join   rows=311 loops=1 t=275.626
      Nested Loop   rows=311 loops=1 t=79.017
        Hash Join   rows=311 loops=1 t=45.89
          Nested Loop   rows=311 loops=1 t=7.803
            Nested Loop   rows=311 loops=1 t=3.684
              Hash Join   rows=311 loops=1 t=1.315
                Bitmap Heap Scan daily_price  rows=311 loops=1 t=0.32
                  Bitmap Index Scan  idx_price_date rows=313 loops=1 t=0.051
                Hash   rows=312 loops=1 t=0.708
                  Index Scan stocks idx_stocks_active rows=312 loops=1 t=0.547
              Index Scan stocks stocks_pkey rows=1 loops=311 t=0.006
            Index Scan sector_override sector_override_pkey rows=1 loops=311 t=0.012
          Hash   rows=311 loops=1 t=37.699
            Index Scan daily_metrics idx_metrics_date rows=311 loops=1 t=37.32
        Index Scan daily_flow idx_flow_code_date rows=1 loops=311 t=0.105
      Hash   rows=22 loops=1 t=196.315
        Subquery Scan   rows=22 loops=1 t=196.299
          Sort   rows=22 loops=1 t=196.29
            WindowAgg   rows=10424 loops=1 t=175.082
              WindowAgg   rows=10424 loops=1 t=154.779
                WindowAgg   rows=10424 loops=1 t=137.609
                  Sort   rows=10424 loops=1 t=123.266
                    Seq Scan sector_daily  rows=10424 loops=1 t=99.098
            Hash Join   rows=22 loops=1 t=196.23
              CTE Scan   rows=10424 loops=1 t=124.03
              Hash   rows=1 loops=1 t=70.372
                Aggregate   rows=1 loops=1 t=70.364
                  CTE Scan   rows=10424 loops=1 t=68.487
    Hash   rows=0 loops=1 t=2.095
      Index Scan signals signals_trade_date_code_signal_type_key rows=0 loops=1 t=2.094
  Index Scan daily_program daily_program_pkey rows=1 loops=311 t=0.004
```

## 인덱스
- daily_flow.daily_flow_pkey
- daily_flow.idx_flow_code_date
- daily_flow.idx_flow_date
- daily_flow.idx_flow_smart
- daily_metrics.daily_metrics_pkey
- daily_metrics.idx_metrics_code
- daily_metrics.idx_metrics_date
- daily_price.daily_price_pkey
- daily_price.idx_price_code_date
- daily_price.idx_price_date
- daily_price.idx_price_weight
- daily_program.daily_program_pkey
- etf_daily.etf_daily_pkey
- etf_daily.idx_etf_daily_date
- market_daily.market_daily_pkey
- signals.idx_signals_code
- signals.idx_signals_date_grade
- signals.idx_signals_pending
- signals.signals_pkey
- signals.signals_trade_date_code_signal_type_key
