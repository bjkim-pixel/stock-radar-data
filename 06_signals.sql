-- ============================================================================
-- STOCK RADAR · 신호 엔진 — 추세추종 · 종가베팅 2전략 3단계 스크리닝
-- ============================================================================
-- 기존 단일 v4 전략을 "추세추종"과 "종가베팅" 두 개의 독립 전략으로 나누고,
-- 각 전략을 3단계 깔때기가 아닌 "단계별 독립 조건"으로 스크리닝합니다.
-- 즉 2단계·3단계는 1단계 조건을 포함하지 않고, 그 단계 고유 조건만 봅니다.
-- 화면에는 1·2·3단계를 통과한 종목을 모두 보여주고, 실제 가상매수는 두 전략
-- 모두 "3단계 통과 종목"만 대상입니다(06_portfolio.py가 이어서 처리).
--
--   06_signals.sql  → V4_CAND_{TREND|CLOSEBET}_{1|2|3}  (단계별 통과 종목 전부)
--   06_portfolio.py → V4_BUY_{TREND|CLOSEBET} 등          (3단계 통과 종목만 매수)
--
-- ── 공통 조건 (두 전략 모두, 모든 단계에 적용) ──────────────────────────────
--   · 시가총액 2조원 이상
--   · 무게/주식수 당일 상위 50위 이내 (daily_metrics.weight_rank)
--
-- ── 추세추종 (단계별 독립) ──────────────────────────────────────────────────
--   1단계: 거래량비(전일까지 20일 평균 대비) 115% 이상 AND 종가 고가권(당일 고저
--          범위 내 상위 30% 이내, close_pos_pct ≥ 70)
--   2단계: 주도섹터(업종 RS 5위 이내) AND 거래량비 115% 이상 AND 전고점 근처
--          (near_high 또는 pct_from_high ≥ -10%)
--   3단계: 주도섹터(업종 RS 5위 이내) AND 거래량비 115% 이상 AND 신고가 돌파
--          (상장 이후 전일까지 누적 최고 종가 돌파, 이력 20일 이상) — 가상매수 대상
--
-- ── 종가베팅 (단계별 독립) ──────────────────────────────────────────────────
--   1단계: 종가 고가권(상위 30%) AND 외국인 순매수(+) AND 기관 순매수(+)
--   2단계: 주도섹터 AND 전고점 근처 AND 외국인 순매수(+) AND 기관 순매수(+)
--   3단계: 주도섹터 AND 신고가 돌파 AND 외국인 순매수(+) AND 기관 순매수(+)
--          AND 프로그램 순매수(+) — 가상매수 대상
--
-- 후보 우선순위: pick_score = 무게/주식수 순위 × 0.6 + 시가총액 순위 × 0.4
--                (낮을수록 우선 — score 컬럼에는 높을수록 우선이도록 반전 저장)
--
-- 파라미터
--   %(start_date)s / %(end_date)s  신호 생성 대상 구간
--   %(lookback_s)s                 (미사용 — 러너 호환용)
--
-- ⚠ 이 파일은 05_compute.py를 통해 실행됩니다.
--    psycopg2 이스케이프로, SQL 파일에는 % 를 평소처럼 쓰면 됩니다 (러너가 자동 이스케이프).
--
-- 재실행 안전: unique(trade_date, code, signal_type) 기준 UPSERT.
-- ============================================================================


-- @@STEP: V4_CAND_TREND / V4_CAND_CLOSEBET 생성 (전략별 1·2·3단계 스크리닝)
WITH base AS (
  SELECT m.trade_date, m.code,
         m.vol_ratio20_prev, m.is_new_high_all, m.near_high, m.pct_from_high,
         m.data_span_days, m.weight_rank, m.cap_rank, m.pick_score,
         p.close, p.high, p.low, p.change_pct, p.market_cap,
         CASE WHEN p.high > p.low
              THEN round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1)
         END                                                     AS close_pos_pct,
         s.name, vs.sector, sd.rs_rank,
         f.foreign_net, f.inst_net,
         pg.pgtr_net_amt,
         max(m.weight_rank) OVER (PARTITION BY m.trade_date)     AS day_n
  FROM daily_metrics m
  JOIN daily_price p       ON p.trade_date = m.trade_date AND p.code = m.code
  JOIN stocks s             ON s.code = m.code
  JOIN v_stock_sector vs    ON vs.code = m.code
  LEFT JOIN sector_daily sd ON sd.trade_date = m.trade_date AND sd.sector = vs.sector AND sd.market = 'ALL'
  LEFT JOIN daily_flow f    ON f.trade_date = m.trade_date AND f.code = m.code
  LEFT JOIN daily_program pg ON pg.trade_date = m.trade_date AND pg.code = m.code
  WHERE m.trade_date BETWEEN %(start_date)s AND %(end_date)s
    AND s.security_type = 'STOCK'
    AND p.market_cap >= 2000000000000        -- 공통조건: 시총 2조원 이상
    AND m.weight_rank <= 50                  -- 공통조건: 무게/주식수 당일 top 50
),
scored AS (
  SELECT base.*,
         round(greatest(0, least(100,
           100.0 * (1 - (pick_score - 1) / nullif(day_n - 1, 0))
         )), 2) AS score
  FROM base
)
INSERT INTO signals (trade_date, code, signal_type, grade, score, reason, reason_text)

-- ── 추세추종 1단계 ──────────────────────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_TREND_1', 'WATCH', score,
  jsonb_build_object('strategy','TREND','stage',1,'sector',sector,
    'vol_ratio20_prev',vol_ratio20_prev,'close_pos_pct',close_pos_pct,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 추세추종 1단계 · 거래량비 ' || round(vol_ratio20_prev) || '%'
       || ' · 종가위치 상위 ' || round(100 - close_pos_pct) || '%'
FROM scored
WHERE vol_ratio20_prev >= 115 AND close_pos_pct >= 70

UNION ALL
-- ── 추세추종 2단계 ──────────────────────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_TREND_2', 'WATCH', score,
  jsonb_build_object('strategy','TREND','stage',2,'sector',sector,'sector_rs_rank',rs_rank,
    'vol_ratio20_prev',vol_ratio20_prev,'pct_from_high',pct_from_high,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 추세추종 2단계 · ' || sector || '(RS ' || rs_rank || '위)'
       || ' · 거래량비 ' || round(vol_ratio20_prev) || '%'
       || ' · 전고점 ' || round(pct_from_high, 1) || '%'
FROM scored
WHERE rs_rank IS NOT NULL AND rs_rank <= 5
  AND vol_ratio20_prev >= 115
  AND (near_high OR pct_from_high >= -10)

UNION ALL
-- ── 추세추종 3단계 (가상매수 대상) ──────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_TREND_3', 'WATCH', score,
  jsonb_build_object('strategy','TREND','stage',3,'sector',sector,'sector_rs_rank',rs_rank,
    'vol_ratio20_prev',vol_ratio20_prev,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 추세추종 3단계(매수) · ' || sector || '(RS ' || rs_rank || '위)'
       || ' · 거래량비 ' || round(vol_ratio20_prev) || '%'
       || ' · 신고가돌파'
FROM scored
WHERE rs_rank IS NOT NULL AND rs_rank <= 5
  AND vol_ratio20_prev >= 115
  AND is_new_high_all
  AND data_span_days >= 20

UNION ALL
-- ── 종가베팅 1단계 ──────────────────────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_CLOSEBET_1', 'WATCH', score,
  jsonb_build_object('strategy','CLOSEBET','stage',1,'close_pos_pct',close_pos_pct,
    'foreign_net',foreign_net,'inst_net',inst_net,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 종가베팅 1단계 · 종가위치 상위 ' || round(100 - close_pos_pct) || '%'
       || ' · 외국인+기관 순매수'
FROM scored
WHERE close_pos_pct >= 70 AND coalesce(foreign_net,0) > 0 AND coalesce(inst_net,0) > 0

UNION ALL
-- ── 종가베팅 2단계 ──────────────────────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_CLOSEBET_2', 'WATCH', score,
  jsonb_build_object('strategy','CLOSEBET','stage',2,'sector',sector,'sector_rs_rank',rs_rank,
    'pct_from_high',pct_from_high,'foreign_net',foreign_net,'inst_net',inst_net,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 종가베팅 2단계 · ' || sector || '(RS ' || rs_rank || '위)'
       || ' · 전고점 ' || round(pct_from_high, 1) || '%'
       || ' · 외국인+기관 순매수'
FROM scored
WHERE rs_rank IS NOT NULL AND rs_rank <= 5
  AND (near_high OR pct_from_high >= -10)
  AND coalesce(foreign_net,0) > 0 AND coalesce(inst_net,0) > 0

UNION ALL
-- ── 종가베팅 3단계 (가상매수 대상) ──────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_CLOSEBET_3', 'WATCH', score,
  jsonb_build_object('strategy','CLOSEBET','stage',3,'sector',sector,'sector_rs_rank',rs_rank,
    'foreign_net',foreign_net,'inst_net',inst_net,'pgtr_net_amt',pgtr_net_amt,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 종가베팅 3단계(매수) · ' || sector || '(RS ' || rs_rank || '위)'
       || ' · 신고가돌파 · 외국인+기관+프로그램 순매수'
FROM scored
WHERE rs_rank IS NOT NULL AND rs_rank <= 5
  AND is_new_high_all
  AND data_span_days >= 20
  AND coalesce(foreign_net,0) > 0 AND coalesce(inst_net,0) > 0 AND coalesce(pgtr_net_amt,0) > 0

ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
  grade       = EXCLUDED.grade,
  score       = EXCLUDED.score,
  reason      = EXCLUDED.reason,
  reason_text = EXCLUDED.reason_text;
  -- notified는 일부러 갱신하지 않습니다 (재실행 시 중복 알림 방지)
