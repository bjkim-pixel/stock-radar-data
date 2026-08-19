-- ============================================================================
-- STOCK RADAR · 신호 엔진
-- ============================================================================
-- daily_metrics를 읽어 매수 3종 / 매도 3단계 신호를 생성합니다.
--
-- 매수  TREND_START     정배열 진입 (추세 시작)
--       NEW_HIGH_BREAK  신고가 돌파
--       TREND_CONTINUE  추세 지속 (고점권 유지 + 수급 동반)
-- 매도  WATCH_EXIT      1단계 관찰 — 가격은 아직인데 수급이 먼저 꺾임
--       SELL_ALERT      2단계 경고 — 5일 수급 플러스→마이너스 전환
--       SELL_SIGNAL     3단계 매도 — 추세 이탈 + 수급 이탈 동시
--
-- ── 수급 강도는 "그날 시장 대비 백분위"로 판정합니다 ────────────────────────
-- 절대 기준(예: 5일 순매수가 시총의 0.5% 이상)은 대형주/소형주, 활황장/침체장에
-- 따라 의미가 완전히 달라집니다. 그래서 매일 전 종목의 |5일수급/시총| 분포를
-- 구해 상위 20%(p80) 이상만 신호로 인정하고, 상위 5%(p95)를 STRONG_BUY 기준으로
-- 씁니다. 데이터 규모가 바뀌어도 자동으로 보정됩니다.
--
-- 파라미터
--   %(start_date)s / %(end_date)s  신호 생성 대상 구간
--   %(lookback_s)s                 전일 비교용 조회 시작일 = start_date - 20일
--
-- ⚠️ 이 파일은 05_compute.py를 통해 실행됩니다.
--    psycopg2 이스케이프로, SQL 파일에는 % 를 평소처럼 쓰면 됩니다 (러너가 자동 이스케이프).
--
-- 재실행 안전: unique(trade_date, code, signal_type) 기준 UPSERT.
--   notified 플래그는 건드리지 않으므로 텔레그램 중복 발송이 없습니다.
-- ============================================================================


-- @@STEP: signals 생성
INSERT INTO signals (trade_date, code, signal_type, grade, score, reason, reason_text)
WITH params AS (
  SELECT
    -- ── 매수 튜닝값 ────────────────────────────────────────────────────────
    150.0::numeric AS amt_ratio_trend,   -- TREND_START: 거래대금 20일평균 대비(퍼센트)
    200.0::numeric AS amt_ratio_break,   -- NEW_HIGH_BREAK: 거래대금 20일평균 대비(퍼센트)
    60             AS min_span_break,    -- 신고가 신호에 필요한 최소 이력(거래일)
    250            AS full_year_days,    -- 진짜 "52주"로 인정할 이력(거래일)
    3              AS consec_continue,   -- TREND_CONTINUE 최소 연속 동반매수일
    -- ── 매도 튜닝값 ────────────────────────────────────────────────────────
    -10.0::numeric AS peak_zone_pct,     -- 고점권 판정: 최고가 대비 몇 퍼센트 이내
    3              AS consec_sell_min,   -- SELL_SIGNAL 최소 연속 동반매도일
    -- ── 수급 강도 백분위 ───────────────────────────────────────────────────
    0.80::numeric  AS pctile_signal,     -- 신호 인정 최소 강도 (그날 상위 20%)
    0.95::numeric  AS pctile_strong      -- STRONG_BUY 승격 강도 (그날 상위 5%)
),
-- 날짜별 수급 강도 분포 → 자기보정 임계값
thr AS (
  SELECT m.trade_date,
         -- percentile_cont는 double precision을 반환하므로 numeric으로 맞춰줍니다
         percentile_cont((SELECT pctile_signal FROM params))
           WITHIN GROUP (ORDER BY abs(m.smart_cum5_cap_pct))::numeric AS flow_min,
         percentile_cont((SELECT pctile_strong FROM params))
           WITHIN GROUP (ORDER BY abs(m.smart_cum5_cap_pct))::numeric AS flow_strong
  FROM daily_metrics m
  WHERE m.trade_date BETWEEN %(start_date)s AND %(end_date)s
    AND m.smart_cum5_cap_pct IS NOT NULL
  GROUP BY m.trade_date
),
d AS (
  SELECT m.trade_date, m.code,
         m.ma5, m.ma20, m.above_ma20, m.ma_aligned,
         m.amt_ratio20, m.data_span_days,
         m.is_new_high, m.near_high, m.pct_from_high, m.high_label,
         m.smart_cum5, m.smart_cum20, m.smart_cum5_prev,
         m.smart_cum5_cap_pct, m.flow_lead,
         m.consec_both_buy, m.consec_both_sell,
         m.inst_lead_field,
         p.close,
         s.name, s.market,
         md.regime,
         lag(m.above_ma20) OVER (PARTITION BY m.code ORDER BY m.trade_date) AS prev_above_ma20
  FROM daily_metrics m
  JOIN daily_price p ON p.trade_date = m.trade_date AND p.code = m.code
  JOIN stocks s      ON s.code = m.code
  LEFT JOIN market_daily md ON md.trade_date = m.trade_date AND md.market = s.market
  WHERE m.trade_date BETWEEN %(lookback_s)s AND %(end_date)s
),
c AS (
  SELECT d.*, params.*,
         thr.flow_min,
         thr.flow_strong,
         abs(coalesce(d.smart_cum5_cap_pct, 0)) AS flow_abs
  FROM d
  CROSS JOIN params
  JOIN thr ON thr.trade_date = d.trade_date
  WHERE d.trade_date BETWEEN %(start_date)s AND %(end_date)s
)

-- ── 1. TREND_START · 정배열 진입 ─────────────────────────────────────────────
SELECT trade_date, code, 'TREND_START',
  CASE WHEN flow_abs >= flow_strong
        AND consec_both_buy >= 2
        AND coalesce(regime, 'NEUTRAL') <> 'RISK_OFF'   -- RISK_OFF엔 STRONG_BUY 미부여
       THEN 'STRONG_BUY' ELSE 'BUY' END,
  round(least(100,
      30
    + least(25, greatest(0, (amt_ratio20 - 100) / 8))
    + least(30, flow_abs / nullif(flow_strong, 0) * 30)   -- 상위 5% 도달 시 만점
    + least(15, greatest(0, 15 + coalesce(pct_from_high, -15)))
  ), 2),
  jsonb_build_object(
    'ma_aligned',         ma_aligned,
    'ma20_breakout',      true,
    'amt_ratio20',        amt_ratio20,
    'smart_cum5',         smart_cum5,
    'smart_cum5_cap_pct', smart_cum5_cap_pct,
    'flow_pctile_pass',   true,
    'consec_both_buy',    consec_both_buy,
    'flow_lead',          flow_lead,
    'regime',             coalesce(regime, 'NEUTRAL')
  ),
  name || ' 정배열 진입 · 거래대금 ' || round(amt_ratio20) || '%'
       || ' · 5일 스마트머니 ' || round(smart_cum5 / 100000000.0) || '억'
FROM c
WHERE ma_aligned
  AND above_ma20
  AND coalesce(prev_above_ma20, false) = false      -- 어제는 MA20 아래 → 오늘 돌파
  AND amt_ratio20 >= amt_ratio_trend
  AND smart_cum5 > 0
  AND flow_abs >= flow_min

UNION ALL

-- ── 2. NEW_HIGH_BREAK · 신고가 돌파 ──────────────────────────────────────────
SELECT trade_date, code, 'NEW_HIGH_BREAK',
  CASE WHEN data_span_days >= full_year_days
        AND flow_abs >= flow_strong
        AND coalesce(regime, 'NEUTRAL') <> 'RISK_OFF'
       THEN 'STRONG_BUY' ELSE 'BUY' END,
  round(least(100,
      35
    + least(30, greatest(0, (amt_ratio20 - 100) / 10))
    + least(25, flow_abs / nullif(flow_strong, 0) * 25)
    + least(10, data_span_days / 25.0)
  ), 2),
  jsonb_build_object(
    'is_new_high',        true,
    'high_label',         high_label,
    'data_span_days',     data_span_days,
    'amt_ratio20',        amt_ratio20,
    'smart_cum5',         smart_cum5,
    'smart_cum5_cap_pct', smart_cum5_cap_pct,
    'flow_pctile_pass',   true,
    'flow_lead',          flow_lead,
    'regime',             coalesce(regime, 'NEUTRAL')
  ),
  name || ' ' || high_label || ' 돌파 · 거래대금 ' || round(amt_ratio20) || '%'
       || ' · 5일 스마트머니 ' || round(smart_cum5 / 100000000.0) || '억'
FROM c
WHERE is_new_high
  AND data_span_days >= min_span_break
  AND amt_ratio20 >= amt_ratio_break
  AND smart_cum5 > 0
  AND flow_abs >= flow_min

UNION ALL

-- ── 3. TREND_CONTINUE · 추세 지속 ───────────────────────────────────────────
SELECT trade_date, code, 'TREND_CONTINUE',
  CASE WHEN amt_ratio20 >= 100 THEN 'BUY' ELSE 'WATCH' END,
  round(least(100,
      25
    + least(20, greatest(0, (amt_ratio20 - 80) / 10))
    + least(30, flow_abs / nullif(flow_strong, 0) * 30)
    + least(25, consec_both_buy * 5)
  ), 2),
  jsonb_build_object(
    'ma_aligned',      ma_aligned,
    'near_high',       near_high,
    'pct_from_high',   pct_from_high,
    'smart_cum5',      smart_cum5,
    'smart_cum20',     smart_cum20,
    'consec_both_buy', consec_both_buy,
    'inst_lead_field', inst_lead_field,
    'flow_lead',       flow_lead,
    'regime',          coalesce(regime, 'NEUTRAL')
  ),
  name || ' 추세 지속 · 고점 대비 ' || round(pct_from_high, 1) || '%'
       || ' · 동반매수 ' || consec_both_buy || '일 연속'
FROM c
WHERE ma_aligned
  AND near_high
  AND smart_cum5  > 0
  AND smart_cum20 > 0
  AND consec_both_buy >= consec_continue
  AND flow_abs >= flow_min

UNION ALL

-- ── 4. WATCH_EXIT · 1단계 관찰 (가격보다 수급이 먼저 꺾임) ───────────────────
-- 아직 추세 안(MA20 위)이고 20일 수급도 플러스인데, 5일 수급만 마이너스로
-- 돌아선 상태 = 고점에서 스마트머니가 조용히 빠지기 시작하는 구간.
SELECT trade_date, code, 'WATCH_EXIT', 'WATCH',
  round(least(100,
      30
    + least(35, flow_abs / nullif(flow_strong, 0) * 35)
    + CASE WHEN flow_lead = 'DIVERGE' THEN 20 ELSE 0 END
    + least(15, greatest(0, 15 + coalesce(pct_from_high, -15)))
  ), 2),
  jsonb_build_object(
    'peak_zone',          true,
    'pct_from_high',      pct_from_high,
    'flow_lead',          flow_lead,
    'smart_cum5',         smart_cum5,
    'smart_cum20',        smart_cum20,
    'smart_cum5_cap_pct', smart_cum5_cap_pct,
    'flow_pctile_pass',   true
  ),
  name || ' 고점권 수급 이상 · ' ||
  CASE WHEN flow_lead = 'DIVERGE' THEN '외국인·기관 방향 엇갈림'
       ELSE '5일 스마트머니 순매도 전환' END ||
  ' · 고점 대비 ' || round(pct_from_high, 1) || '%'
FROM c
WHERE (near_high OR pct_from_high >= peak_zone_pct)
  AND coalesce(above_ma20, false)                   -- 가격은 아직 추세 안
  AND smart_cum20 > 0                               -- 20일은 여전히 순매수
  AND (smart_cum5 < 0 OR flow_lead = 'DIVERGE')     -- 그런데 최근 5일이 꺾임
  AND flow_abs >= flow_min

UNION ALL

-- ── 5. SELL_ALERT · 2단계 경고 (5일 수급 플러스→마이너스 전환) ──────────────
SELECT trade_date, code, 'SELL_ALERT', 'CAUTION',
  round(least(100,
      45
    + least(35, flow_abs / nullif(flow_strong, 0) * 35)
    + least(20, greatest(0, (ma5 - close)::numeric / nullif(ma5, 0) * 400))
  ), 2),
  jsonb_build_object(
    'smart_cum5',         smart_cum5,
    'smart_cum5_prev',    smart_cum5_prev,
    'flow_reversal',      true,
    'close_below_ma5',    true,
    'smart_cum5_cap_pct', smart_cum5_cap_pct,
    'flow_pctile_pass',   true
  ),
  name || ' 수급 이탈 전환 · 5일 스마트머니 '
       || round(smart_cum5_prev / 100000000.0) || '억 → '
       || round(smart_cum5      / 100000000.0) || '억 · MA5 이탈'
FROM c
WHERE smart_cum5 < 0
  AND coalesce(smart_cum5_prev, 0) > 0              -- 플러스 → 마이너스 전환
  AND coalesce(above_ma20, false)                   -- 아직 추세 안 = 조기 경고
  AND ma5 IS NOT NULL
  AND close < ma5
  AND flow_abs >= flow_min

UNION ALL

-- ── 6. SELL_SIGNAL · 3단계 매도 (추세 이탈 + 수급 이탈) ─────────────────────
-- MA20을 깨고 내려온 "그날" 또는 동반매도가 연속될 때만.
-- (MA20 아래에 머무는 내내 매일 신호가 나오면 알림이 무의미해집니다)
SELECT trade_date, code, 'SELL_SIGNAL', 'SELL',
  round(least(100,
      50
    + least(30, flow_abs / nullif(flow_strong, 0) * 30)
    + least(20, consec_both_sell * 7)
  ), 2),
  jsonb_build_object(
    'above_ma20',         false,
    'ma20_breakdown',     coalesce(prev_above_ma20, false),
    'smart_cum5',         smart_cum5,
    'smart_cum5_cap_pct', smart_cum5_cap_pct,
    'consec_both_sell',   consec_both_sell,
    'flow_lead',          flow_lead,
    'regime',             coalesce(regime, 'NEUTRAL')
  ),
  name || ' 추세 이탈 · MA20 하회 · 동반매도 ' || consec_both_sell || '일'
       || ' · 5일 스마트머니 ' || round(smart_cum5 / 100000000.0) || '억'
FROM c
WHERE above_ma20 = false
  AND smart_cum5 < 0
  AND flow_abs >= flow_min
  AND (coalesce(prev_above_ma20, false) = true      -- MA20 이탈 당일
       OR consec_both_sell >= consec_sell_min)      -- 또는 동반매도 연속

ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
  grade       = EXCLUDED.grade,
  score       = EXCLUDED.score,
  reason      = EXCLUDED.reason,
  reason_text = EXCLUDED.reason_text;
  -- notified는 일부러 갱신하지 않습니다 (재실행 시 중복 알림 방지)
