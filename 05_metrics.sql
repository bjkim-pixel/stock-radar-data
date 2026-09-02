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


-- @@STEP: market_daily (거래대금·수급 집계 + 레짐 판정)
-- ----------------------------------------------------------------------------
-- ⚠️ 2026-08-28 수정: index_close/index_change/index_change_pct/index_ma20은
--    더 이상 여기서 계산하지 않습니다.
--
--    과거엔 KOSPI/KOSDAQ 실제 지수가 없어서 보유 종목의 시가총액 가중 평균
--    등락률을 누적곱한 "합성 지수"(기준 1000)를 이 컬럼들에 채웠습니다. 그런데
--    20_collect_market_extra.py가 KIS inquire-daily-indexchartprice로 실제
--    KOSPI/KOSDAQ 종합지수를 매일 수집해 이 컬럼들에 UPSERT하기 시작한 뒤에도
--    이 STEP이 그대로 남아 있어서, daily_collect.yml(16:05) 직후 돌아가는
--    compute.yml(16:15)이 실제 지수 값을 다시 합성 지수로 덮어써버리는
--    사고가 있었습니다 — "오늘은 실제 값인데 그 이전 구간은 죄다 합성값이라
--    차트가 중간에 뚝 끊기고 이상한 값으로 튀는" 증상이 바로 이것입니다.
--    (전체 기간 재계산 때는 그 시점 lookback 기준으로 1000부터 다시 복리
--    계산하니, 실행할 때마다 스케일 자체가 달라져서 더 심하게 어긋납니다.)
--
--    이제 index_close/index_ma20은 20_collect_market_extra.py가 이미
--    저장해둔 실제 값을 그대로 읽기만 하고(레짐 판정용), UPSERT SET 절에도
--    포함하지 않아 이 STEP이 실제 지수 값을 덮어쓸 수 없습니다.
-- ----------------------------------------------------------------------------
INSERT INTO market_daily (
  trade_date, market, total_amount, foreign_net, inst_net, individual_net, regime
)
WITH base AS (
  SELECT p.trade_date,
         s.market,
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
         sum(individual_net) AS individual_net
  FROM base
  GROUP BY trade_date, market
)
SELECT a.trade_date,
       a.market,
       a.total_amount,
       a.foreign_net,
       a.inst_net,
       a.individual_net,
       -- 레짐: (실제) 지수가 MA20 위 + 시장 전체 외국인·기관 순매수 → RISK_ON
       -- index_close/index_ma20은 20_collect_market_extra.py가 채운 실제 값을
       -- 그대로 조회만 합니다(md 서브쿼리) — 아직 미수집(NULL)이면 NEUTRAL.
       CASE
         WHEN md.index_close IS NULL OR md.index_ma20 IS NULL THEN 'NEUTRAL'
         WHEN md.index_close > md.index_ma20
          AND coalesce(a.foreign_net, 0) + coalesce(a.inst_net, 0) > 0 THEN 'RISK_ON'
         WHEN md.index_close > md.index_ma20
           OR coalesce(a.foreign_net, 0) + coalesce(a.inst_net, 0) > 0 THEN 'NEUTRAL'
         ELSE 'RISK_OFF'
       END
FROM agg a
LEFT JOIN market_daily md ON md.trade_date = a.trade_date AND md.market = a.market
WHERE a.trade_date BETWEEN %(start_date)s AND %(end_date)s
ON CONFLICT (trade_date, market) DO UPDATE SET
  total_amount     = EXCLUDED.total_amount,
  foreign_net      = EXCLUDED.foreign_net,
  inst_net         = EXCLUDED.inst_net,
  individual_net   = EXCLUDED.individual_net,
  regime           = EXCLUDED.regime;


-- @@STEP: sector_daily (업종별 집계 + 업종 RS20/RS5 순위)
-- ----------------------------------------------------------------------------
-- v4 매수조건 1번: "업종 RS 상위 5위 이내".
--   업종RS20 = 업종 소속 종목 등락률 평균의 20거래일 누적수익률(rolling, 최소 15일)
--   업종RS5  = 같은 방식의 5거래일 누적수익률(rolling, 최소 4일) — 빠른 순환매
--             장세에서 RS20 하나만으로는 이미 꺾인 섹터가 며칠간 계속 주도로
--             잡히는 지연이 있어(과거 랠리분이 20일 창에 남아있음) 보조 지표로
--             추가. rs5_top5_streak(5위 이내 연속일)까지 같이 계산해두면
--             "RS5 상위 2일 연속(신흥 주도)" / "RS20은 상위인데 RS5 이탈
--             (이탈 조짐)" 배지를 화면에서 바로 구성할 수 있음(55_sector_rs5.sql
--             의 v_sector_rank에서 계산).
--   소속 종목 3개 미만 업종은 랭킹에서 제외
-- 20일 창을 채우려면 start_date 이전 데이터가 필요하므로 lookback부터 집계하고
-- 저장만 start_date~end_date로 제한합니다.
-- ----------------------------------------------------------------------------
INSERT INTO sector_daily (
  trade_date, sector, market, avg_change_pct,
  total_amount, foreign_net, inst_net, smart_net, stock_count,
  rs20, rs_rank, rs5, rs5_rank, rs5_top5_streak
)
WITH base AS (
  -- sector는 v_stock_sector(= sector_override가 있으면 그 값, 없으면 sector_krx)
  -- 기준입니다. sector_krx 원본은 백테스트 재현성을 위해 그대로 두되, 업종 RS
  -- 랭킹은 화면에 노출되는 보정된 업종으로 그룹핑되어야 STEP2/STEP3/스크리너의
  -- sector 표시값과 일치합니다(28_sector_override.sql 참고).
  SELECT p.trade_date,
         vs.sector                                          AS sector,
         avg(p.change_pct)                                  AS avg_change_pct,
         sum(p.trade_amount)                                AS total_amount,
         sum(f.foreign_net)                                 AS foreign_net,
         sum(f.inst_net)                                    AS inst_net,
         sum(coalesce(f.foreign_net, 0) + coalesce(f.inst_net, 0)) AS smart_net,
         count(*)                                           AS stock_count
  FROM daily_price p
  JOIN stocks s      ON s.code = p.code
  JOIN v_stock_sector vs ON vs.code = p.code
  LEFT JOIN daily_flow f ON f.trade_date = p.trade_date AND f.code = p.code
  WHERE s.security_type = 'STOCK'
    AND vs.sector IS NOT NULL
    AND p.trade_date BETWEEN %(lookback)s AND %(end_date)s
    AND p.close > 0
  GROUP BY p.trade_date, vs.sector
),
rs AS (
  SELECT base.*,
         -- N일 누적수익률 = Π(1 + r) - 1 = exp(Σ ln(1 + r)) - 1
         exp(sum(ln(greatest(1 + avg_change_pct / 100.0, 0.01))) OVER w20) - 1 AS rs20_raw,
         count(*) OVER w20 AS c20,
         exp(sum(ln(greatest(1 + avg_change_pct / 100.0, 0.01))) OVER w5) - 1  AS rs5_raw,
         count(*) OVER w5 AS c5
  FROM base
  WINDOW w20 AS (PARTITION BY sector ORDER BY trade_date
                 ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
         w5  AS (PARTITION BY sector ORDER BY trade_date
                 ROWS BETWEEN 4 PRECEDING AND CURRENT ROW)
),
elig AS (
  -- RS20: 최소 15일, RS5: 최소 4일 + 둘 다 소속 3종목 이상인 업종만 랭킹 대상
  SELECT rs.*,
         CASE WHEN c20 >= 15 AND stock_count >= 3 THEN rs20_raw END AS rs20_eligible,
         CASE WHEN c5  >= 4  AND stock_count >= 3 THEN rs5_raw  END AS rs5_eligible
  FROM rs
),
ranked AS (
  SELECT elig.*,
         CASE WHEN rs20_eligible IS NOT NULL
              THEN rank() OVER (PARTITION BY trade_date
                                ORDER BY rs20_eligible DESC NULLS LAST) END AS rs_rank,
         CASE WHEN rs5_eligible IS NOT NULL
              THEN rank() OVER (PARTITION BY trade_date
                                ORDER BY rs5_eligible DESC NULLS LAST) END AS rs5_rank
  FROM elig
),
flg AS (
  SELECT ranked.*,
         CASE WHEN rs5_rank IS NOT NULL AND rs5_rank <= 5 THEN 1 ELSE 0 END AS is_rs5_top5
  FROM ranked
),
grp AS (
  -- 연속일 계산용 그룹 번호 (RS5 5위 이내가 끊길 때마다 +1 → gaps & islands,
  -- daily_metrics.consec_both_buy/sell과 동일한 패턴)
  SELECT flg.*,
         sum(1 - is_rs5_top5) OVER (PARTITION BY sector ORDER BY trade_date
                                    ROWS UNBOUNDED PRECEDING) AS g_top5
  FROM flg
),
streak AS (
  SELECT grp.*,
         CASE WHEN is_rs5_top5 = 1
              THEN sum(is_rs5_top5) OVER (PARTITION BY sector, g_top5
                                          ORDER BY trade_date ROWS UNBOUNDED PRECEDING)
              ELSE 0 END AS rs5_top5_streak
  FROM grp
)
SELECT trade_date,
       sector,
       'ALL',
       round(avg_change_pct::numeric, 4),
       total_amount,
       foreign_net,
       inst_net,
       smart_net,
       stock_count,
       round(rs20_eligible::numeric, 6),
       rs_rank,
       round(rs5_eligible::numeric, 6),
       rs5_rank,
       rs5_top5_streak
FROM streak
WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
ON CONFLICT (trade_date, sector, market) DO UPDATE SET
  avg_change_pct  = EXCLUDED.avg_change_pct,
  total_amount    = EXCLUDED.total_amount,
  foreign_net     = EXCLUDED.foreign_net,
  inst_net        = EXCLUDED.inst_net,
  smart_net       = EXCLUDED.smart_net,
  stock_count     = EXCLUDED.stock_count,
  rs20            = EXCLUDED.rs20,
  rs_rank         = EXCLUDED.rs_rank,
  rs5             = EXCLUDED.rs5,
  rs5_rank        = EXCLUDED.rs5_rank,
  rs5_top5_streak = EXCLUDED.rs5_top5_streak;


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
  vol_avg20_prev, vol_ratio20_prev, high_all_prev, is_new_high_all,
  nonpersonal_net, weight_rank, cap_rank, pick_score,
  rs20_vs_mkt,
  computed_at
)
WITH src AS (
  SELECT p.trade_date, p.code, p.close, p.volume, p.trade_amount,
         p.market_cap, p.change_pct, p.weight_per_share,
         coalesce(f.individual_net, 0) AS individual_net,
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
         -- v4: 개별종목 상대강도(RS)용 — 20거래일 전 종가 (LAG는 프레임 무관)
         lag(close, 20) OVER (PARTITION BY code ORDER BY trade_date) AS close_20d_ago,
         -- 이동평균 (유효성 검사용 건수 동반)
         avg(close) OVER w5  AS a5,  count(*) OVER w5  AS c5,
         avg(close) OVER w10 AS a10, count(*) OVER w10 AS c10,
         avg(close) OVER w20 AS a20, count(*) OVER w20 AS c20,
         avg(close) OVER w60 AS a60, count(*) OVER w60 AS c60,
         -- 거래대금 · 거래량
         avg(trade_amount) OVER w20 AS amt_avg20,
         avg(volume)       OVER w20 AS vol_avg20,
         sum(trade_amount) OVER w90 AS quarter_amt,
         -- v4: "전일까지" 20일 평균 거래량 (당일 제외) + 상장 이후 전일까지 최고 종가
         avg(volume) OVER w20p  AS vol_avg20_prev,
         count(*)    OVER w20p  AS c20p,
         max(close)  OVER wprev AS high_all_prev,
         count(*)    OVER wprev AS cprev,
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
    wall AS (PARTITION BY code ORDER BY trade_date ROWS UNBOUNDED PRECEDING),
    -- v4용: 당일을 제외한 창들
    w20p AS (PARTITION BY code ORDER BY trade_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING),
    wprev AS (PARTITION BY code ORDER BY trade_date
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
),
fin AS (
  SELECT w.*,
         -- 직전 5일 누적 (가속/감속 판정용): 5행 전의 5일 누적값
         lag(s5, 5) OVER (PARTITION BY code ORDER BY trade_date) AS s5_prev,
         -- v4: 종목 20일 수익률. 20거래일 이력 없으면(신규상장 등) NULL.
         CASE WHEN close_20d_ago > 0
              THEN (close::numeric / close_20d_ago - 1) * 100 END AS ret20
  FROM w
),
rk AS (
  -- v4 후보 우선순위용 당일 횡단면 순위 (유니버스 전체 기준)
  SELECT fin.*,
         rank() OVER (PARTITION BY trade_date
                      ORDER BY weight_per_share DESC NULLS LAST) AS weight_rank,
         rank() OVER (PARTITION BY trade_date
                      ORDER BY market_cap DESC NULLS LAST)       AS cap_rank,
         -- v4: 그날 유니버스(daily_metrics 전종목) 평균 20일 수익률 — 개별RS의 기준선
         avg(ret20) OVER (PARTITION BY trade_date)                AS mkt_ret20
  FROM fin
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

  -- ── v4 지표 ────────────────────────────────────────────────────────────
  CASE WHEN c20p >= 20 THEN round(vol_avg20_prev)::bigint END             AS vol_avg20_prev,
  CASE WHEN c20p >= 20 AND vol_avg20_prev > 0
       THEN round(volume / vol_avg20_prev * 100, 2) END                   AS vol_ratio20_prev,
  high_all_prev,
  -- 상장 이후 전일까지 누적 최고 종가 돌파. 이력 20일 미만이면 판정 보류(NULL).
  CASE WHEN cprev >= 20 THEN close > high_all_prev END                    AS is_new_high_all,
  -- 비개인 순매수 = -(개인). 투자자 주체 순매수 총합이 0이므로
  -- 외국인+기관+기타법인과 같은 값입니다(기타법인 컬럼은 용량 정리 때 삭제됨).
  -individual_net                                                         AS nonpersonal_net,
  weight_rank,
  cap_rank,
  round(weight_rank * 0.6 + cap_rank * 0.4, 2)                            AS pick_score,
  -- v4: 개별종목 상대강도 = 종목 20일수익률 - 그날 유니버스 평균 20일수익률
  CASE WHEN ret20 IS NOT NULL THEN round((ret20 - mkt_ret20)::numeric, 2) END AS rs20_vs_mkt,
  now()
FROM rk
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
  vol_avg20_prev      = EXCLUDED.vol_avg20_prev,
  vol_ratio20_prev    = EXCLUDED.vol_ratio20_prev,
  high_all_prev       = EXCLUDED.high_all_prev,
  is_new_high_all     = EXCLUDED.is_new_high_all,
  nonpersonal_net     = EXCLUDED.nonpersonal_net,
  weight_rank         = EXCLUDED.weight_rank,
  cap_rank            = EXCLUDED.cap_rank,
  pick_score          = EXCLUDED.pick_score,
  rs20_vs_mkt         = EXCLUDED.rs20_vs_mkt,
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
