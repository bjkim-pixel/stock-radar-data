-- ============================================================================
-- STOCK RADAR · 신호 엔진 v4 — 매수 후보 스크리닝
-- ============================================================================
-- 백테스트로 검증된 "신고가 추세추종 전략 v4" 규칙을 그대로 이식한 것입니다.
-- (검증구간 2026-04-01~08-14 93거래일 · 자금대비 +48.7% · MDD -7.4% ·
--  승률 40.7% / 손익비 14.6배 · 평균 보유 10.1거래일)
--
-- 이 파일이 하는 일은 "당일 종가 기준 매수 후보 스크리닝"까지입니다.
-- 실제 매수 여부(일 5종목 한도·기보유 제외)와 매도·불타기 판정은 포지션
-- 상태가 필요하므로 06_portfolio.py가 이어서 처리합니다.
--
--   06_signals.sql  → V4_CANDIDATE  (조건 통과 종목 전부)
--   06_portfolio.py → V4_BUY / V4_PYRAMID / V4_SELL / V4_CRASH_SELL
--
-- ── v4 매수 후보 조건 (전부 AND) ────────────────────────────────────────────
--   1. 업종      업종 RS20 순위 5위 이내 (소속 3종목 미만 업종은 랭킹 제외)
--   2. 신고가    당일 종가 > 상장 이후 전일까지 누적 최고 종가 (이력 20일 이상)
--   3. 거래량    전일까지 20일 평균 거래량 대비 200% 이상
--   4. 시가총액  2조원 이상
--   5. 수급      비개인 순매수(외국인+기관+기타법인) > 0
--   6. 등락률    당일 등락률 < 15% (상한가 근접 추격매수 제외)
--
-- 후보 우선순위: pick_score = 무게/주식수 순위 × 0.6 + 시가총액 순위 × 0.4
--                (낮을수록 우선 — score 컬럼에는 높을수록 우선이도록 반전 저장)
--
-- 파라미터
--   %(start_date)s / %(end_date)s  신호 생성 대상 구간
--   %(lookback_s)s                 (v4에서는 미사용 — 러너 호환용)
--
-- ⚠ 이 파일은 05_compute.py를 통해 실행됩니다.
--    psycopg2 이스케이프로, SQL 파일에는 % 를 평소처럼 쓰면 됩니다 (러너가 자동 이스케이프).
--
-- 재실행 안전: unique(trade_date, code, signal_type) 기준 UPSERT.
--   notified 플래그는 건드리지 않으므로 텔레그램 중복 발송이 없습니다.
-- ============================================================================


-- @@STEP: V4_CANDIDATE 생성 (매수 후보 스크리닝)
INSERT INTO signals (trade_date, code, signal_type, grade, score, reason, reason_text)
WITH params AS (
  SELECT
    5                       AS sector_rank_max,  -- 업종 RS 상위 N위 이내
    200.0::numeric          AS vol_ratio_min,    -- 전일까지 20일 평균 거래량 대비(%)
    2000000000000::bigint   AS cap_min,          -- 시가총액 2조원
    15.0::numeric           AS chg_max,          -- 당일 등락률 상한(미만)
    20                      AS min_span          -- 최소 데이터 보유 거래일수
),
c AS (
  SELECT m.trade_date, m.code,
         m.vol_ratio20_prev, m.high_all_prev, m.is_new_high_all,
         m.nonpersonal_net, m.data_span_days,
         m.weight_rank, m.cap_rank, m.pick_score,
         p.close, p.change_pct, p.market_cap, p.weight_per_share,
         s.name, s.market, s.sector_krx,
         sd.rs_rank, sd.rs20,
         -- 당일 순위 산정 대상 종목 수 (score 정규화용)
         max(m.weight_rank) OVER (PARTITION BY m.trade_date) AS day_n
  FROM daily_metrics m
  JOIN daily_price p ON p.trade_date = m.trade_date AND p.code = m.code
  JOIN stocks s      ON s.code = m.code
  LEFT JOIN sector_daily sd
         ON sd.trade_date = m.trade_date
        AND sd.sector     = s.sector_krx
        AND sd.market     = 'ALL'
  WHERE m.trade_date BETWEEN %(start_date)s AND %(end_date)s
    AND s.security_type = 'STOCK'
)
SELECT
  c.trade_date,
  c.code,
  'V4_CANDIDATE',
  'WATCH',            -- 실제 매수 채택 여부는 06_portfolio.py가 V4_BUY로 승격
  -- pick_score(낮을수록 우선)를 0~100(높을수록 우선)으로 반전
  round(greatest(0, least(100,
    100.0 * (1 - (c.pick_score - 1) / nullif(c.day_n - 1, 0))
  )), 2),
  jsonb_build_object(
    'sector',            c.sector_krx,
    'sector_rs_rank',    c.rs_rank,
    'sector_rs20',       round(c.rs20, 6),
    'new_high_all',      true,
    'high_all_prev',     c.high_all_prev,
    'data_span_days',    c.data_span_days,
    'vol_ratio20_prev',  c.vol_ratio20_prev,
    'market_cap',        c.market_cap,
    'nonpersonal_net',   c.nonpersonal_net,
    'change_pct',        c.change_pct,
    'weight_per_share',  c.weight_per_share,
    'weight_rank',       c.weight_rank,
    'cap_rank',          c.cap_rank,
    'pick_score',        c.pick_score,
    'close',             c.close
  ),
  c.name || ' 신고가 돌파 · ' || c.sector_krx || '(RS ' || c.rs_rank || '위)'
         || ' · 거래량 ' || round(c.vol_ratio20_prev) || '%'
         || ' · 시총 ' || round(c.market_cap / 100000000.0) || '억'
         || ' · 비개인 ' || round(c.nonpersonal_net / 100000000.0) || '억'
         || ' · 등락 ' || round(c.change_pct, 1) || '%'
FROM c
CROSS JOIN params
WHERE c.rs_rank IS NOT NULL
  AND c.rs_rank <= params.sector_rank_max          -- 1. 업종 RS 상위 5위
  AND c.is_new_high_all                            -- 2. 상장 이후 누적 신고가
  AND c.data_span_days >= params.min_span          --    이력 20일 이상
  AND c.vol_ratio20_prev >= params.vol_ratio_min   -- 3. 거래량 200% 이상
  AND c.market_cap >= params.cap_min               -- 4. 시총 2조 이상
  AND c.nonpersonal_net > 0                        -- 5. 비개인 순매수 플러스
  AND c.change_pct < params.chg_max                -- 6. 등락률 15% 미만
  AND c.pick_score IS NOT NULL

ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
  grade       = EXCLUDED.grade,
  score       = EXCLUDED.score,
  reason      = EXCLUDED.reason,
  reason_text = EXCLUDED.reason_text;
  -- notified는 일부러 갱신하지 않습니다 (재실행 시 중복 알림 방지)
