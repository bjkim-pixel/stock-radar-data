-- ============================================================================
-- STOCK RADAR · 파생지표 계산
-- ============================================================================
-- market_daily(시장 레짐) → sector_daily(업종) → daily_metrics(종목) 순서로 계산.
--
-- 모든 계산이 DB 안에서 끝납니다. 데이터를 파이썬으로 끌어오지 않으므로
-- 65만 행 기준 수십 초 안에 완료됩니다.
--
-- 파라미터 (05_compute.py가 주입)
--   %(start_date)s  결과를 저장할 시작일 (YYYY-MM-DD)
--   %(end_date)s    결과를 저장할 종료일
--   %(lookback)s    창(window) 확보용 조회 시작일 = start_date - 400일
--                   250일 신고가·90일 누적을 계산하려면 범위 밖 과거가 필요합니다.
--
-- 멱등성: 전부 UPSERT라 몇 번을 다시 돌려도 같은 결과가 됩니다.
-- ============================================================================


-- @@STEP: market_daily (시장 지수 + 레짐 판정)
-- ----------------------------------------------------------------------------
-- ⚠️ index_close는 "합성 지수"입니다.
--    아직 KOSPI/KOSDAQ 실제 지수를 수집하지 않으므로, 보유 종목의
--    시가총액 가중 평균 등락률을 누적곱해 지수를 만들어 씁니다(기준 1000).
--    레짐 판정은 "지수 > MA20" 이라는 상대 비교만 쓰기 때문에 프록시로 충분합니다.
--    나중에 KIS 지수 API를 붙이면 이 STEP만 교체하면 됩니다.
-- ----------------------------------------------------------------------------
INSERT INTO market_daily (
  trade_date, market, index_close, index_change, index_change_pct, index_ma20,
  total_amount, foreign_net, inst_net, individual_net, regime
)
WITH base AS (
  SELECT p.trade_date,
         s.market,
         p.market_cap,
         p.change_pct,
         p.trade_amount,
         f.foreign_net,
         f.inst_net,
         f.individual_net
  FROM daily_price p
  JOIN stocks s      ON s.code = p.code
  LEFT JOIN daily_flow f ON f.trade_date = p.trade_date AND f.code = p.code
  WHERE s.security_type = 'STOCK'
    AND s.market IN ('KOSPI', 'KOSDAQ')
    AND p.trade_date BETWEEN %(lookback)s AND %(end_date)s
    AND p.close > 0
    AND p.market_cap > 0
),
agg AS (
  SELECT trade_date,
         market,
         sum(trade_amount)   AS total_amount,
         sum(foreign_net)    AS foreign_net,
         sum(inst_net)       AS inst_net,
         sum(individual_net) AS individual_net,
         -- 시총 가중 평균 등락률 (= 지수 일간 수익률 프록시)
         sum(market_cap::numeric * coalesce(change_pct, 0))
           / nullif(sum(market_cap::numeric), 0) AS ret_pct
  FROM base
  GROUP BY trade_date, market
),
idx AS (
  SELECT a.*,
         -- 누적곱: 1000 × Π(1 + r)  =  1000 × exp(Σ ln(1 + r))
         1000 * exp(
           sum(ln(greatest(1 + coalesce(ret_pct, 0) / 100.0, 0.01)))
             OVER (PARTITION BY market ORDER BY trade_date ROWS UNBOUNDED PRECEDING)
         ) AS index_close
  FROM agg a
),
fin AS (
  SELECT i.*,
         index_close - lag(index_close)
           OVER (PARTITION BY market ORDER BY trade_date) AS index_change,
         avg(index_close) OVER w20 AS index_ma20,
         count(*)         OVER w20 AS c20
  FROM idx i
  WINDOW w20 AS (PARTITION BY market ORDER BY trade_date
                 ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
)
SELECT trade_date,
       market,
       round(index_close::numeric, 2),
       round(index_change::numeric, 2),
       round(ret_pct::numeric, 4),
       CASE WHEN c20 >= 20 THEN round(index_ma20::numeric, 2) END,
       total_amount,
       foreign_net,
       inst_net,
       individual_net,
       -- 레짐: 지수가 MA20 위 + 시장 전체 외국인·기관 순매수 → RISK_ON
       CASE
         WHEN c20 < 20 THEN 'NEUTRAL'                        -- MA20 미형성 구간
         WHEN index_close > index_ma20
          AND coalesce(foreign_net, 0) + coalesce(inst_net, 0) > 0 THEN 'RISK_ON'
         WHEN index_close > index_ma20
           OR coalesce(foreign_net, 0) + coalesce(inst_net, 0) > 0 THEN 'NEUTRAL'
         ELSE 'RISK_OFF'
       END
FROM fin
WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
ON CONFLICT (trade_date, market) DO UPDATE SET
  index_close      = EXCLUDED.index_close,
  index_change     = EXCLUDED.index_change,
  index_change_pct = EXCLUDED.index_change_pct,
  index_ma20       = EXCLUDED.index_ma20,
  total_amount     = EXCLUDED.total_amount,
  foreign_net      = EXCLUDED.foreign_net,
  inst_net         = EXCLUDED.inst_net,
  individual_net   = EXCLUDED.individual_net,
  regime           = EXCLUDED.regime;


-- @@STEP: sector_daily (업종별 집계)
-- ----------------------------------------------------------------------------
INSERT INTO sector_daily (
  trade_date, sector, market, avg_change_pct,
  total_amount, foreign_net, inst_net, smart_net, stock_count
)
SELECT p.trade_date,
       s.sector_krx,
       'ALL',
       round(avg(p.change_pct)::numeric, 4),
       sum(p.trade_amount),
       sum(f.foreign_net),
       sum(f.inst_net),
       sum(coalesce(f.foreign_net, 0) + coalesce(f.inst_net, 0)),
       count(*)
FROM daily_price p
JOIN stocks s      ON s.code = p.code
LEFT JOIN daily_flow f ON f.trade_date = p.trade_date AND f.code = p.code
WHERE s.security_type = 'STOCK'
  AND s.sector_krx IS NOT NULL
  AND p.trade_date BETWEEN %(start_date)s AND %(end_date)s
  AND p.close > 0
GROUP BY p.trade_date, s.sector_krx
ON CONFLICT (trade_date, sector, market) DO UPDATE SET
  avg_change_pct = EXCLUDED.avg_change_pct,
  total_amount   = EXCLUDED.total_amount,
  foreign_net    = EXCLUDED.foreign_net,
  inst_net       = EXCLUDED.inst_net,
  smart_net      = EXCLUDED.smart_net,
  stock_count    = EXCLUDED.stock_count;


-- @@STEP: daily_metrics (종목별 파생지표 — 핵심)
-- ----------------------------------------------------------------------------
INSERT INTO daily_metrics (
  trade_date, code,
  ma5, ma10, ma20, ma60, above_ma20, ma_aligned,
  amt_avg20, amt_ratio20, vol_avg20, vol_ratio20, quarter_amt,
  high_period, high_period_date, pct_from_high, is_new_high, near_high, high_60d,
  data_span_days, high_label,
  foreign_cum5, foreign_cum20, inst_cum5, inst_cum20,
  smart_cum5, smart_cum20, smart_cum5_prev,
  smart_cum5_cap_pct, smart_cum20_cap_pct,
  foreign_slope, inst_slope, flow_lead,
  consec_both_buy, consec_both_sell,
  inst_lead_field, inst_lead_value,
  computed_at
)
WITH src AS (
  SELECT p.trade_date, p.code, p.close, p.volume, p.trade_amount,
         p.market_cap, p.change_pct,
         coalesce(f.foreign_net,   0) AS foreign_net,
         coalesce(f.inst_net,      0) AS inst_net,
         coalesce(f.smart_net,     0) AS smart_net,
         coalesce(f.fin_inv_net,   0) AS fin_inv_net,
         coalesce(f.inv_trust_net, 0) AS inv_trust_net,
         coalesce(f.pension_net,   0) AS pension_net,
         coalesce(f.pe_net,        0) AS pe_net
  FROM daily_price p
  JOIN stocks s      ON s.code = p.code
  LEFT JOIN daily_flow f ON f.trade_date = p.trade_date AND f.code = p.code
  WHERE s.security_type = 'STOCK'
    AND p.trade_date BETWEEN %(lookback)s AND %(end_date)s
    AND p.close > 0
),
flg AS (
  SELECT src.*,
         row_number() OVER (PARTITION BY code ORDER BY trade_date) AS rn,
         CASE WHEN foreign_net > 0 AND inst_net > 0 THEN 1 ELSE 0 END AS both_buy,
         CASE WHEN foreign_net < 0 AND inst_net < 0 THEN 1 ELSE 0 END AS both_sell
  FROM src
),
grp AS (
  -- 연속일 계산용 그룹 번호 (동반매수가 끊길 때마다 +1 → gaps & islands)
  SELECT flg.*,
         sum(1 - both_buy)  OVER (PARTITION BY code ORDER BY trade_date
                                  ROWS UNBOUNDED PRECEDING) AS g_buy,
         sum(1 - both_sell) OVER (PARTITION BY code ORDER BY trade_date
                                  ROWS UNBOUNDED PRECEDING) AS g_sell
  FROM flg
),
w AS (
  SELECT grp.*,
         -- 이동평균 (유효성 검사용 건수 동반)
         avg(close) OVER w5  AS a5,  count(*) OVER w5  AS c5,
         avg(close) OVER w10 AS a10, count(*) OVER w10 AS c10,
         avg(close) OVER w20 AS a20, count(*) OVER w20 AS c20,
         avg(close) OVER w60 AS a60, count(*) OVER w60 AS c60,
         -- 거래대금 · 거래량
         avg(trade_amount) OVER w20 AS amt_avg20,
         avg(volume)       OVER w20 AS vol_avg20,
         sum(trade_amount) OVER w90 AS quarter_amt,
         -- 신고가: 배열 비교로 [최고종가, 그 날짜]를 한 번에 구합니다.
         --   배열은 사전식으로 비교되므로 max()가 곧 "최고 종가를 기록한 행"입니다.
         max(ARRAY[close, (trade_date - DATE '1970-01-01')::bigint]) OVER w250 AS hi,
         max(close) OVER w60  AS high_60d,
         count(*)   OVER wall AS span_days,
         -- 누적 순매수
         sum(foreign_net)   OVER w5  AS f5,
         sum(foreign_net)   OVER w20 AS f20,
         sum(inst_net)      OVER w5  AS i5,
         sum(inst_net)      OVER w20 AS i20,
         sum(smart_net)     OVER w5  AS s5,
         sum(smart_net)     OVER w20 AS s20,
         sum(fin_inv_net)   OVER w5  AS fi5,
         sum(inv_trust_net) OVER w5  AS it5,
         sum(pension_net)   OVER w5  AS pn5,
         sum(pe_net)        OVER w5  AS pe5,
         -- 수급 기울기: 시총 대비 bp로 정규화한 5일 선형회귀 계수
         regr_slope(foreign_net::numeric / nullif(market_cap, 0) * 10000, rn) OVER w5 AS f_slope,
         regr_slope(inst_net::numeric    / nullif(market_cap, 0) * 10000, rn) OVER w5 AS i_slope,
         -- 연속 동반매수/매도일
         sum(both_buy)  OVER (PARTITION BY code, g_buy  ORDER BY trade_date
                              ROWS UNBOUNDED PRECEDING) AS cbuy,
         sum(both_sell) OVER (PARTITION BY code, g_sell ORDER BY trade_date
                              ROWS UNBOUNDED PRECEDING) AS csell
  FROM grp
  WINDOW
    w5   AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN   4 PRECEDING AND CURRENT ROW),
    w10  AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN   9 PRECEDING AND CURRENT ROW),
    w20  AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN  19 PRECEDING AND CURRENT ROW),
    w60  AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN  59 PRECEDING AND CURRENT ROW),
    w90  AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN  89 PRECEDING AND CURRENT ROW),
    w250 AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN 249 PRECEDING AND CURRENT ROW),
    wall AS (PARTITION BY code ORDER BY trade_date ROWS UNBOUNDED PRECEDING)
),
fin AS (
  SELECT w.*,
         -- 직전 5일 누적 (가속/감속 판정용): 5행 전의 5일 누적값
         lag(s5, 5) OVER (PARTITION BY code ORDER BY trade_date) AS s5_prev
  FROM w
)
SELECT
  trade_date,
  code,
  CASE WHEN c5  >= 5  THEN round(a5::numeric,  2) END,
  CASE WHEN c10 >= 10 THEN round(a10::numeric, 2) END,
  CASE WHEN c20 >= 20 THEN round(a20::numeric, 2) END,
  CASE WHEN c60 >= 60 THEN round(a60::numeric, 2) END,
  CASE WHEN c20 >= 20 THEN close > a20 END                                AS above_ma20,
  CASE WHEN c60 >= 60 THEN (close > a20 AND a20 > a60) END                AS ma_aligned,
  round(amt_avg20)::bigint,
  CASE WHEN amt_avg20 > 0 THEN round(trade_amount / amt_avg20 * 100, 2) END,
  round(vol_avg20)::bigint,
  CASE WHEN vol_avg20 > 0 THEN round(volume       / vol_avg20 * 100, 2) END,
  quarter_amt,
  hi[1]                                                                   AS high_period,
  DATE '1970-01-01' + hi[2]::int                                          AS high_period_date,
  CASE WHEN hi[1] > 0 THEN round((close - hi[1])::numeric / hi[1] * 100, 2) END,
  close >= hi[1]                                                          AS is_new_high,
  close >= hi[1] * 0.97                                                   AS near_high,
  high_60d,
  span_days,
  CASE WHEN span_days >= 250 THEN '52주 신고가'
       ELSE '기간 내 신고가(' || span_days || '일)' END                    AS high_label,
  f5, f20, i5, i20, s5, s20, s5_prev,
  CASE WHEN market_cap > 0 THEN round(s5::numeric  / market_cap * 100, 6) END,
  CASE WHEN market_cap > 0 THEN round(s20::numeric / market_cap * 100, 6) END,
  round(f_slope::numeric, 6),
  round(i_slope::numeric, 6),
  -- 주도 주체: 외국인/기관 방향과 우열
  CASE
    WHEN f5 > 0 AND i5 > 0 THEN
      CASE WHEN abs(f5) >= 2 * abs(i5) THEN 'FOREIGN_LEAD'
           WHEN abs(i5) >= 2 * abs(f5) THEN 'INST_LEAD'
           ELSE 'SYNC' END
    WHEN f5 < 0 AND i5 < 0 THEN 'SYNC'                    -- 동조 매도
    WHEN (f5 > 0 AND i5 < 0) OR (f5 < 0 AND i5 > 0) THEN 'DIVERGE'
    ELSE 'NONE'
  END                                                                     AS flow_lead,
  cbuy, csell,
  -- 기관 내부에서 가장 크게 움직인 주체
  CASE greatest(abs(fi5), abs(it5), abs(pn5), abs(pe5))
    WHEN abs(fi5) THEN 'fin_inv'
    WHEN abs(it5) THEN 'inv_trust'
    WHEN abs(pn5) THEN 'pension'
    WHEN abs(pe5) THEN 'pe'
  END                                                                     AS inst_lead_field,
  CASE greatest(abs(fi5), abs(it5), abs(pn5), abs(pe5))
    WHEN abs(fi5) THEN fi5
    WHEN abs(it5) THEN it5
    WHEN abs(pn5) THEN pn5
    WHEN abs(pe5) THEN pe5
  END                                                                     AS inst_lead_value,
  now()
FROM fin
WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
ON CONFLICT (trade_date, code) DO UPDATE SET
  ma5                 = EXCLUDED.ma5,
  ma10                = EXCLUDED.ma10,
  ma20                = EXCLUDED.ma20,
  ma60                = EXCLUDED.ma60,
  above_ma20          = EXCLUDED.above_ma20,
  ma_aligned          = EXCLUDED.ma_aligned,
  amt_avg20           = EXCLUDED.amt_avg20,
  amt_ratio20         = EXCLUDED.amt_ratio20,
  vol_avg20           = EXCLUDED.vol_avg20,
  vol_ratio20         = EXCLUDED.vol_ratio20,
  quarter_amt         = EXCLUDED.quarter_amt,
  high_period         = EXCLUDED.high_period,
  high_period_date    = EXCLUDED.high_period_date,
  pct_from_high       = EXCLUDED.pct_from_high,
  is_new_high         = EXCLUDED.is_new_high,
  near_high           = EXCLUDED.near_high,
  high_60d            = EXCLUDED.high_60d,
  data_span_days      = EXCLUDED.data_span_days,
  high_label          = EXCLUDED.high_label,
  foreign_cum5        = EXCLUDED.foreign_cum5,
  foreign_cum20       = EXCLUDED.foreign_cum20,
  inst_cum5           = EXCLUDED.inst_cum5,
  inst_cum20          = EXCLUDED.inst_cum20,
  smart_cum5          = EXCLUDED.smart_cum5,
  smart_cum20         = EXCLUDED.smart_cum20,
  smart_cum5_prev     = EXCLUDED.smart_cum5_prev,
  smart_cum5_cap_pct  = EXCLUDED.smart_cum5_cap_pct,
  smart_cum20_cap_pct = EXCLUDED.smart_cum20_cap_pct,
  foreign_slope       = EXCLUDED.foreign_slope,
  inst_slope          = EXCLUDED.inst_slope,
  flow_lead           = EXCLUDED.flow_lead,
  consec_both_buy     = EXCLUDED.consec_both_buy,
  consec_both_sell    = EXCLUDED.consec_both_sell,
  inst_lead_field     = EXCLUDED.inst_lead_field,
  inst_lead_value     = EXCLUDED.inst_lead_value,
  computed_at         = now();


-- @@STEP: 키움 보유계좌수 20일 증감률
-- ----------------------------------------------------------------------------
-- 키움 데이터는 업로드가 불규칙(233일 중 113일)해서 정확히 20거래일 전 행이
-- 없을 수 있습니다. 26~60일 전 구간에서 "가장 최근" 기록을 찾아 비교합니다.
-- ----------------------------------------------------------------------------
UPDATE daily_metrics m
SET accounts_chg_20d_pct = sub.chg
FROM (
  SELECT k.trade_date,
         k.code,
         round((k.accounts - prev.accounts)::numeric
               / nullif(prev.accounts, 0) * 100, 2) AS chg
  FROM kiwoom_holder_stats k
  CROSS JOIN LATERAL (
    SELECT k2.accounts
    FROM kiwoom_holder_stats k2
    WHERE k2.code = k.code
      AND k2.trade_date <= k.trade_date - 26
      AND k2.trade_date >= k.trade_date - 60
    ORDER BY k2.trade_date DESC
    LIMIT 1
  ) prev
  WHERE k.trade_date BETWEEN %(start_date)s AND %(end_date)s
) sub
WHERE m.trade_date = sub.trade_date
  AND m.code       = sub.code;
