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
--   · 시가총액 1조원 이상
--   · 일거래대금 500억원 이상
--   · (2026-09-10 변경) 무게/주식수 상위 N위 캡 제거 — 어차피 전략마다 3단계
--     조건으로 걸러지므로, 사전에 상위 50위로 좁힐 필요 없이 관리 중인 유니버스
--     전체(시총·거래대금 조건 통과분)를 대상으로 삼습니다.
--
-- ── 2026-09-10 단계 조건 완화 (배경: 최근 15거래일 실측 결과 추세추종 2→3단계
--    통과가 193→26→18건, 종가베팅은 116→6→0건으로 3단계가 사실상 막혀있었음.
--    병목 조건을 실측 데이터로 특정해 완화함 — 아래 각 단계 주석 참고) ─────
--
-- ── 2026-09-11 추세추종 1·2단계 재강화 (배경: 09-10 완화 + 공통 캡 제거의
--    부작용으로 대상 유니버스가 하루 68~100종목까지 늘었고, 특히 1단계
--    (종가위치≥70% AND 등락률<12%)는 상승장에서 필터력이 약해 실측
--    2026-09-11 유니버스 68종목 중 37건(54%)이 1단계를 통과함 — "너무 많은
--    종목이 1·2단계에 들어온다"는 사용자 피드백과 일치. 종가베팅은 실측상
--    여전히 타이트해 손대지 않음. 아래처럼 1단계만 강화하고 2단계는 부분
--    복원, 3단계 조건식 자체는 그대로 유지: ────────────────────────────────
--    실측(2026-09-08~11, 1→2→3단계 순, 개선 전 → 개선 후):
--      09-08(유니버스 71): 0→0→0  ⇒  0→0→0
--      09-09(유니버스 76): 25→2→2 ⇒ 15→1→1
--      09-10(유니버스100): 33→0→0 ⇒  8→0→0
--      09-11(유니버스 68): 37→8→7 ⇒  9→4→4
--    1단계 통과 건수가 평균 60%가량 줄었고, 1단계가 조여지면서 2·3단계도
--    함께 연동되어 줄어듦(TREND는 단계가 이름상 "독립조건"이어도 실제로는
--    누적식으로 작성되어 있어 상위 단계 강화가 하위 단계에 그대로 전파됨 —
--    이는 3단계(가상매수) 조건식을 손대지 않았어도 발생하는 자연스러운 결과).
--   · 종가위치 컷 상위 30%→상위 15%로 강화(close_pos_pct 70→85)
--   · 등락률 상한 12% 미만은 유지하되 하한 1%를 추가(0%대 보합 종목이 종가
--     위치만으로 통과하는 것을 방지)
--   · 1단계에 한해 pick_score 상위 40위 캡을 재도입(TREND 전용 — CLOSEBET과
--     공통 유니버스에는 영향 없음). 09-10에 제거한 공통 무게순위 캡과 달리,
--     이번엔 3단계까지 이어지는 병목이 아니라 1단계 자체의 관대함을 보완하는
--     목적이라 TREND 전략에만, pick_score 기준으로 좁게 재도입함.
--   · 2단계 전고점 근접 조건을 -20%→-15%로 부분 복원(09-10 완화 폭의 절반)
--
-- ── 추세추종 (2026-08-29 제로베이스 재설계 — 백테스트 A~G 실험 결과 반영) ───
-- 업종(섹터) RS 대신 개별종목 상대강도(rs20_vs_mkt = 종목 20일수익률 - 유니버스
-- 평균 20일수익률)를 사용합니다. 업종 RS는 GS·현대해상처럼 업종은 잠잠해도
-- 개별 종목이 강한 경우를 놓쳤는데, 개별RS로 바꾸자 이 종목들을 포착하면서
-- 성과가 뚜렷하게 개선됨을 백테스트로 확인했습니다(rs20_vs_mkt는 05_metrics.sql
-- 이 매일 전 종목 일괄 계산 → daily_metrics.rs20_vs_mkt).
--   1단계: 종가 고가권(당일 고저 범위 내 상위 15% 이내, close_pos_pct ≥ 85
--          · 2026-09-11 상위30%→상위15%로 강화) AND 등락률 1%~12% 미만
--          (2026-09-11 하한 1% 추가 — 보합권 거짓 돌파 방지)
--          AND pick_score 상위 40위 이내(2026-09-11 TREND 1단계 전용 재도입)
--   2단계: 1단계 조건 전부 AND 전고점 근처(near_high 또는 pct_from_high ≥ -15%
--          · 2026-09-10 -10%→-20% 완화 후 2026-09-11 -20%→-15%로 부분 복원)
--          AND MA 정배열(5일 > 10일 > 20일 > 60일 이동평균)
--   3단계: 2단계 조건 전부 AND 거래량비(전일까지 20일 평균 대비) 250% 미만
--          (2026-09-10 180%→250% 완화 — 2→3단계 탈락 8건 중 5건이 이 조건에서
--          걸렸고, 250%로 올리면 전부 구제됨을 실측으로 확인. 2026-09-11
--          재검토 결과 3단계는 병목 원인이 아니어서 그대로 유지)
--          (거래량 폭발 종목 배제 — "소멸형" 시그니처 차단)
--          AND 개별종목 상대강도(rs20_vs_mkt) > 0 (시장 대비 초과수익 종목만
--          — 이 조건은 병목 기여도가 낮아 그대로 유지)
--          — 가상매수 대상
--
-- ── 종가베팅 (단계별 독립) ──────────────────────────────────────────────────
--   1단계: 종가 고가권(상위 30%) AND 외국인 순매수(+) AND 기관 순매수(+)
--   2단계: 주도섹터(업종 RS 8위 이내, 2026-09-10 5위→8위 완화) AND 전고점 근처
--          (near_high 또는 pct_from_high ≥ -20%, 2026-09-10 -10%→-20% 완화)
--          AND 외국인 순매수(+) AND 기관 순매수(+)
--          (1→2단계 탈락 111건 중 전고점 단독실패 52건·RS단독실패 11건·둘다실패
--          48건이었고, 실측상 RS 8위 완화가 6건, 전고점 -20% 완화가 5건 구제)
--   3단계: 주도섹터(업종 RS 8위 이내) AND 전고점 근처(pct_from_high ≥ -5%,
--          2026-09-10 "당일 52주 신고가 경신" 요건 → "전고점 -5% 이내 근접"으로
--          대체 — 원래 조건으로는 최근 15거래일간 2→3단계 통과가 0건이었고
--          탈락 6건 전부가 이 신고가 요건 단독 실패였음, 데이터이력·프로그램
--          순매수는 전혀 병목이 아니었음. -5%로 바꾸면 6건 중 4건 구제)
--          AND 데이터 이력 20일 이상
--          AND 외국인 순매수(+) AND 기관 순매수(+)
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


-- @@STEP: 기존 후보 신호(V4_CAND_*) 삭제 — 재계산 구간 한정
-- ⚠ 버그 수정: 아래 INSERT는 ON CONFLICT DO UPDATE라서 "이번엔 조건을 더 이상
--    만족 못 하는" 과거 후보 행을 절대 지우지 않습니다. 조건을 더 엄격하게
--    바꿔도(예: 등락률 필터 추가) 예전 느슨한 조건일 때 만들어진 V4_CAND_* 행이
--    테이블에 그대로 남아있어서 06_portfolio.py가 여전히 그 종목을 사들이는
--    문제가 있었습니다. 매번 재계산 구간의 후보를 통째로 지우고 새로 채웁.
DELETE FROM signals
WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
  AND signal_type LIKE 'V4_CAND_%'
  AND trade_date >= current_date - interval '1 day';

-- @@STEP: V4_CAND_TREND / V4_CAND_CLOSEBET 생성 (전략별 1·2·3단계 스크리닝)
WITH base AS (
  SELECT m.trade_date, m.code,
         m.vol_ratio20_prev, m.is_new_high_all, m.near_high, m.pct_from_high,
         m.data_span_days, m.weight_rank, m.cap_rank, m.pick_score,
         m.ma5, m.ma10, m.ma20, m.ma60, m.rs20_vs_mkt,
         p.close, p.high, p.low, p.change_pct, p.market_cap, p.trade_amount,
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
    AND p.market_cap >= 1000000000000        -- 공통조건: 시총 1조원 이상
    AND p.trade_amount >= 50000000000        -- 공통조건: 일거래대금 500억원 이상
    -- 2026-09-10: 무게/주식수 top 50 캡 제거 (관리 유니버스 전체 대상, 위 주석 참고)
),
scored AS (
  SELECT base.*,
         round(greatest(0, least(100,
           100.0 * (1 - (pick_score - 1) / nullif(day_n - 1, 0))
         )), 2) AS score,
         -- 2026-09-11: 추세추종 1단계 전용 재도입 캡(TREND에만 사용, CLOSEBET·
         -- 공통 유니버스에는 영향 없음) — pick_score 낮을수록 우선이므로 오름차순
         rank() OVER (PARTITION BY trade_date ORDER BY pick_score ASC) AS pick_rank_trend
  FROM base
)
INSERT INTO signals (trade_date, code, signal_type, grade, score, reason, reason_text)

-- ── 추세추종 1단계 ──────────────────────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_TREND_1', 'WATCH', score,
  jsonb_build_object('strategy','TREND','stage',1,
    'close_pos_pct',close_pos_pct,
    'change_pct',change_pct,'pick_rank_trend',pick_rank_trend,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 추세추종 1단계 · 종가위치 상위 ' || round(100 - close_pos_pct) || '%'
       || ' · 등락률 ' || round(change_pct, 1) || '%'
       || ' · pick순위 ' || pick_rank_trend || '위'
FROM scored
WHERE close_pos_pct >= 85 AND change_pct >= 1 AND change_pct < 12   -- 2026-09-11: 70→85, 하한 1% 추가
  AND pick_rank_trend <= 40                                        -- 2026-09-11: TREND 1단계 전용 캡 재도입

UNION ALL
-- ── 추세추종 2단계 ──────────────────────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_TREND_2', 'WATCH', score,
  jsonb_build_object('strategy','TREND','stage',2,
    'close_pos_pct',close_pos_pct,'change_pct',change_pct,
    'pct_from_high',pct_from_high,'near_high',near_high,'pick_rank_trend',pick_rank_trend,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 추세추종 2단계 · 정배열(5>10>20>60일)'
       || ' · 전고점 ' || round(pct_from_high, 1) || '%'
       || ' · 종가위치 상위 ' || round(100 - close_pos_pct) || '%'
       || ' · 등락률 ' || round(change_pct, 1) || '%'
FROM scored
WHERE close_pos_pct >= 85 AND change_pct >= 1 AND change_pct < 12   -- 2026-09-11: 70→85, 하한 1% 추가
  AND pick_rank_trend <= 40                                        -- 2026-09-11: TREND 1단계 전용 캡 재도입
  AND (near_high OR pct_from_high >= -15)   -- 2026-09-10 -10→-20 완화 후 2026-09-11 -20→-15 부분 복원
  AND ma5 > ma10 AND ma10 > ma20 AND ma20 > ma60

UNION ALL
-- ── 추세추종 3단계 (가상매수 대상) ──────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_TREND_3', 'WATCH', score,
  jsonb_build_object('strategy','TREND','stage',3,
    'rs20_vs_mkt',rs20_vs_mkt,
    'vol_ratio20_prev',vol_ratio20_prev,'close_pos_pct',close_pos_pct,'change_pct',change_pct,
    'pct_from_high',pct_from_high,'pick_rank_trend',pick_rank_trend,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 추세추종 3단계(매수) · 개별RS ' || round(rs20_vs_mkt, 1) || '%p'
       || ' · 거래량비 ' || round(vol_ratio20_prev) || '%'
       || ' · 정배열'
       || ' · 종가위치 상위 ' || round(100 - close_pos_pct) || '%'
       || ' · 등락률 ' || round(change_pct, 1) || '%'
FROM scored
WHERE close_pos_pct >= 85 AND change_pct >= 1 AND change_pct < 12   -- 2026-09-11: 70→85, 하한 1% 추가
  AND pick_rank_trend <= 40                                        -- 2026-09-11: TREND 1단계 전용 캡 재도입
  AND (near_high OR pct_from_high >= -15)   -- 2026-09-10 -10→-20 완화 후 2026-09-11 -20→-15 부분 복원
  AND ma5 > ma10 AND ma10 > ma20 AND ma20 > ma60
  AND vol_ratio20_prev < 250                -- 2026-09-10: 180%→250% 완화 (유지)
  AND rs20_vs_mkt IS NOT NULL AND rs20_vs_mkt > 0

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
WHERE rs_rank IS NOT NULL AND rs_rank <= 8       -- 2026-09-10: 5위→8위 완화
  AND (near_high OR pct_from_high >= -20)        -- 2026-09-10: -10%→-20% 완화
  AND coalesce(foreign_net,0) > 0 AND coalesce(inst_net,0) > 0

UNION ALL
-- ── 종가베팅 3단계 (가상매수 대상) ──────────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_CLOSEBET_3', 'WATCH', score,
  jsonb_build_object('strategy','CLOSEBET','stage',3,'sector',sector,'sector_rs_rank',rs_rank,
    'pct_from_high',pct_from_high,
    'foreign_net',foreign_net,'inst_net',inst_net,'pgtr_net_amt',pgtr_net_amt,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 종가베팅 3단계(매수) · ' || sector || '(RS ' || rs_rank || '위)'
       || ' · 전고점 ' || round(pct_from_high, 1) || '% 근접 · 외국인+기관+프로그램 순매수'
FROM scored
WHERE rs_rank IS NOT NULL AND rs_rank <= 8       -- 2026-09-10: 5위→8위 완화
  -- 2026-09-10: "당일 52주 신고가 경신"(is_new_high_all) → "전고점 -5% 이내 근접"
  -- 으로 완화. 원래 조건은 최근 15거래일 2→3단계 통과 0건의 유일한 원인이었음.
  AND pct_from_high >= -5
  AND data_span_days >= 20
  AND coalesce(foreign_net,0) > 0 AND coalesce(inst_net,0) > 0 AND coalesce(pgtr_net_amt,0) > 0

ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
  grade       = EXCLUDED.grade,
  score       = EXCLUDED.score,
  reason      = EXCLUDED.reason,
  reason_text = EXCLUDED.reason_text;
  -- notified는 일부러 갱신하지 않습니다 (재실행 시 중복 알림 방지)
