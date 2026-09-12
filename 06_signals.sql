-- ============================================================================
-- STOCK RADAR · 신호 엔진 — 추세추종 · 종가베팅 · 종가베팅2 3전략 스크리닝
-- ============================================================================
-- 기존 단일 v4 전략을 "추세추종"·"종가베팅"·"종가베팅2"(2026-09-11 신설) 세
-- 개의 독립 전략으로 나누고, 각 전략을 단계별 독립 조건(또는 종가베팅2처럼
-- 누적 2단계)으로 스크리닝합니다. 추세추종·종가베팅은 3단계, 종가베팅2는
-- 2단계 구조입니다 — 화면에는 각 전략의 마지막 단계를 통과한 종목만 실제
-- 가상매수 대상으로 표시합니다(06_portfolio.py가 이어서 처리).
--
--   06_signals.sql  → V4_CAND_TREND_{1|2|3} / V4_CAND_CLOSEBET_{1|2|3} /
--                     V4_CAND_CLOSEBET2_{1|2}             (단계별 통과 종목 전부)
--   06_portfolio.py → V4_BUY_{TREND|CLOSEBET|CLOSEBET2} 등 (마지막 단계 통과 종목만 매수)
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
-- ── 종가베팅2 (2026-09-11 신설 — NXT 마감 괴리 기반, 2단계 구조) ─────────────
-- 정규장 마감 등락률과 NXT(넥스트레이드) 애프터마켓 등락률의 괴리를 보는
-- 전략입니다. NXT에서 정규장보다 더 강하게 상승 중인 종목은 애프터마켓에서도
-- 매수세가 계속 붙고 있다는 뜻으로 보고, 그중 시가총액이 큰(=변동성 대비
-- 안정적인) 종목만 추려 NXT 마감가에 매수합니다.
--   1단계: NXT 등락률이 플러스(0% 초과)인 종목 중 괴리율(gap_pct = NXT 등락률
--          − 정규장 등락률) 상위 10종목 (그날 공통조건 통과 유니버스 중,
--          NXT 시세가 있는 종목 대상)
--   2단계: 1단계 10종목 중 시가총액 상위 3종목 — 가상매수 대상
-- ⚠ 2026-09-12: NXT 등락률이 마이너스인 종목은 괴리율이 커도 1단계에서
--   제외한다. "정규장보다 덜 빠졌을 뿐" NXT 애프터마켓에서 실제로는 여전히
--   하락 중인 종목(예: 정규장 -8% → NXT -4%, 괴리 +4%p)을 "매수세 유입"으로
--   잘못 해석해 사들이는 걸 막기 위함 — 진짜 매수 대상은 NXT에서 실제로
--   플러스(+)로 전환된 종목이어야 한다.
-- 다른 두 전략과 달리 "종가"가 아니라 NXT 마감가(daily_price.nxt_close)에
-- 매수하고, 매도는 종가베팅과 동일하게 익일 정규장 시가 전량 청산입니다
-- (06_portfolio.py process_day_closebet2 참고). NXT 마감 데이터는 정규장
-- 마감 후 20:00 KST 이후에나 확정되므로, 실제 가상매수 확정은 nxt_collect.yml
-- 공식마감 수집(20:10 KST) 직후 compute.yml 실행에서만 이뤄집니다.
-- ⚠ 2026-09-12 정정: 이 문단은 원래 "16:30/18:30 실행 시점엔 nxt_change_pct가
-- 없어 1단계 후보가 비어있다"고 적혀 있었으나, 그 사이 compute.yml에 장중
-- 반복실행(18:05~19:55 KST, --no-portfolio)이 5회 추가되면서 실제로는 그
-- 시간대에도 nxt_collect.yml의 장중 수집값(18:00~19:50 KST)으로 1·2단계
-- 후보가 채워져 화면에 표시됩니다(참고용 — 아직 확정 아님). 다만
-- --no-portfolio라 06_portfolio.py 자체가 그 시점엔 실행되지 않으므로,
-- notified 플래그가 미확정 가격으로 먼저 세팅될 위험은 없습니다 — 확정은
-- 여전히 20:10 KST 공식마감 수집 이후 한 번뿐입니다.
-- ⚠ daily_price.nxt_close/nxt_change_pct는 69_nxt_price_columns.sql(스키마)
--   과 70_nxt_collect.py(수집, nxt_collect.yml 20:10 KST)가 있어야 채워집니다.
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
-- ⚠ 2026-09-12 수정: 예전엔 이 DELETE에 "trade_date >= current_date - 1일"
--    안전장치가 걸려 있어서, 조건 변경 후 "과거 날짜 구간"을 명시적으로
--    재실행(예: start_date=20260901)해도 그 구간의 낡은 후보가 전혀 안
--    지워지는 버그가 있었습니다. 이 안전장치 자체는 필요합니다 —
--    05_compute.py를 인자 없이 실행하면 DB 전체 기간이 기본값이 되는데, 이때
--    과거 확정 이력을 통째로 지우는 사고를 막기 위한 것(전용 커밋 메시지
--    "V4_CAND 신호 소급삭제 방지 — 과거 확정 신호 보존" 참고). 그래서 완전히
--    없애는 대신, 05_compute.py가 "호출자가 날짜를 명시했는지"를
--    %(cand_delete_floor)s 파라미터로 넘겨주도록 바꿨습니다 — 명시적 구간
--    재계산(오늘 이 세션에서 20260911 재실행한 것처럼)은 그 구간을 전부
--    지우고, 인자 없는 기본 전체기간 실행만 계속 "최근 1일"로 보호합니다.
DELETE FROM signals
WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
  AND signal_type LIKE 'V4_CAND_%'
  AND trade_date >= %(cand_delete_floor)s;

-- @@STEP: V4_CAND_TREND / V4_CAND_CLOSEBET 생성 (전략별 1·2·3단계 스크리닝)
WITH base AS (
  SELECT m.trade_date, m.code,
         m.vol_ratio20_prev, m.is_new_high_all, m.near_high, m.pct_from_high,
         m.data_span_days, m.weight_rank, m.cap_rank, m.pick_score,
         m.ma5, m.ma10, m.ma20, m.ma60, m.rs20_vs_mkt,
         p.close, p.high, p.low, p.change_pct, p.market_cap, p.trade_amount,
         p.nxt_close, p.nxt_change_pct,
         -- 2026-09-12 수정: high=low(상한가 종일 고정 등 당일 변동폭 0)이면
         -- 이전엔 NULL 처리돼 "종가위치 상위 X%" 조건에서 항상 탈락했습니다.
         -- 상한가 락은 가장 강한 상승 신호인데 오히려 배제되는 게 맞지 않으므로,
         -- 변동폭이 0인 날은 종가위치를 100(최고점)으로 간주합니다.
         CASE WHEN p.high > p.low
              THEN round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1)
              WHEN p.high = p.low AND p.high > 0 THEN 100
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
         -- ⚠ 2026-09-12: rank()는 동점이면 같은 순위를 여러 행에 매겨서 "상위
         -- 40위 이내" 같은 캡이 동점 시 40개보다 더 많이 통과할 수 있었습니다
         -- (pick_score가 weight_rank/cap_rank 조합이라 동점이 드물지 않음).
         -- row_number()+code 타이브레이크로 캡이 정확히 지켜지도록 수정.
         row_number() OVER (PARTITION BY trade_date ORDER BY pick_score ASC, code ASC) AS pick_rank_trend,
         -- 2026-09-12: 개별RS(rs20_vs_mkt) 원값(%p)만 보면 그날 어느 수준인지 판단이
         -- 안 되므로, 그날 공통조건 통과 유니버스(base, 시총·거래대금 조건 통과분
         -- 전체) 안에서 순위와 전체 종목수를 매겨 "N위 / 전체 M종목" 형태로
         -- 추세추종 3단계에 표시.
         -- ⚠ 알려진 불일치(2026-09-12 리뷰, 의도적으로 값 자체는 그대로 둠):
         -- 이 순위의 모집단은 base(시총·거래대금 필터 통과분)이지만, 정작
         -- rs20_vs_mkt 값 자체(그리고 아래 stage3의 ">0" 합격선)는
         -- 05_metrics.sql에서 daily_metrics 전체(훨씬 넓은, 필터 이전 모집단)
         -- 평균 대비로 계산됩니다. 즉 "3위/전체 40종목"처럼 보여도, 합격/불합격을
         -- 가른 기준선은 이 40종목이 아니라 그보다 훨씬 큰 모집단 평균입니다.
         -- rs20_vs_mkt는 다른 화면(종목상세 등)에서도 범용으로 쓰는 컬럼이라
         -- 여기서 재정의하면 실거래 매수 결정 자체가 바뀌므로(백테스트로
         -- 검증된 현재 기준을 건드리게 됨), 표시 목적의 순위만 두고 값은
         -- 손대지 않았습니다. 두 모집단을 일치시키려면 05_metrics.sql에 원시
         -- ret20 컬럼을 추가로 노출해 여기서 base-scoped 평균을 다시 계산해야
         -- 하는데, 이는 전략 자체의 기준을 바꾸는 결정이라 사용자 확인 후
         -- 별도로 진행하는 게 안전합니다.
         rank() OVER (PARTITION BY trade_date ORDER BY rs20_vs_mkt DESC NULLS LAST) AS rs20_rank,
         count(rs20_vs_mkt) OVER (PARTITION BY trade_date) AS rs20_universe_n
  FROM base
),
-- ── 종가베팅2 전용 풀 (2026-09-11 신설) ────────────────────────────────────
-- NXT 시세가 있는 종목만 대상으로 괴리율(gap_pct)을 계산하고, 그날 괴리율
-- 상위 10위(gap_rank)까지만 남깁니다 — 이게 1단계 통과 종목 전체입니다.
-- ⚠ 2026-09-12: nxt_close > 0 조건 추가. KIS API는 해당 종목이 그날 NXT에서
--   실제 체결이 전혀 없었을 때도 에러 없이 rt_cd='0'(성공) + 전 필드 0인
--   "빈 응답"을 돌려준다(70_nxt_collect.py --debug로 직접 확인, 대덕전자
--   353200 등). nxt_change_pct만으로는 이 빈 응답(0.00%)과 "정말 NXT에서
--   등락률이 0%로 마감"인 진짜 데이터를 구분할 수 없으므로, NXT 마감가가
--   0원(=체결 없음의 신호)인 종목은 애초에 괴리율 계산 대상에서 제외한다.
-- ⚠ 2026-09-12: nxt_change_pct > 0 조건 추가. 괴리율(gap_pct)이 커도 NXT
--   등락률 자체가 마이너스면 "정규장보다 덜 빠진 것"일 뿐 실제 매수세가
--   붙은 게 아니므로 제외 — 1단계는 NXT에서 실제로 플러스(+) 전환된
--   종목만 대상으로 한다.
-- ⚠ 2026-09-12: gap_rank/cap_rank_top10 둘 다 "상위 N개만" 캡으로 쓰이므로
-- (아래 gap_rank<=10, cap_rank_top10<=3), rank() 대신 row_number()+code
-- 타이브레이크를 써서 동점 시 N개보다 더 많이 통과하는 걸 방지합니다.
closebet2_pool AS (
  SELECT scored.*,
         (nxt_change_pct - change_pct) AS gap_pct,
         row_number() OVER (PARTITION BY trade_date ORDER BY (nxt_change_pct - change_pct) DESC, code ASC) AS gap_rank
  FROM scored
  WHERE nxt_change_pct IS NOT NULL
    AND nxt_close IS NOT NULL AND nxt_close > 0
    AND nxt_change_pct > 0
),
-- 1단계(gap_rank<=10) 통과 종목 안에서만 시가총액 순위를 다시 매깁니다 —
-- 전체 유니버스 기준 시총 순위가 아니라 "그 10종목 중" 순위여야 하므로
-- closebet2_pool 전체가 아니라 gap_rank<=10으로 좁힌 뒤 별도로 랭크를 매김.
closebet2_stage1 AS (
  SELECT *,
         row_number() OVER (PARTITION BY trade_date ORDER BY market_cap DESC, code ASC) AS cap_rank_top10
  FROM closebet2_pool
  WHERE gap_rank <= 10
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
    'rs20_vs_mkt',rs20_vs_mkt,'rs20_rank',rs20_rank,'rs20_universe_n',rs20_universe_n,
    'vol_ratio20_prev',vol_ratio20_prev,'close_pos_pct',close_pos_pct,'change_pct',change_pct,
    'pct_from_high',pct_from_high,'pick_rank_trend',pick_rank_trend,
    'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  -- 2026-09-12: 개별RS 원값(%p)만 보면 그날 어느 수준인지 판단이 안 돼서, 그날
  -- 공통조건 유니버스 안에서의 순위(rs20_rank/전체 rs20_universe_n)로 표시.
  -- 원값(%p)도 괄호로 같이 남겨 둠.
  name || ' 추세추종 3단계(매수) · 개별RS ' || rs20_rank || '위/전체 ' || rs20_universe_n || '종목'
       || '(원값 ' || round(rs20_vs_mkt, 1) || '%p)'
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

UNION ALL
-- ── 종가베팅2 1단계 (NXT 괴리율 상위 10) ─────────────────────────────────────
SELECT trade_date, code, 'V4_CAND_CLOSEBET2_1', 'WATCH', score,
  jsonb_build_object('strategy','CLOSEBET2','stage',1,
    'change_pct',change_pct,'nxt_change_pct',nxt_change_pct,'gap_pct',gap_pct,'gap_rank',gap_rank,
    'nxt_close',nxt_close,'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 종가베팅2 1단계 · 정규장 ' || round(change_pct, 1) || '% → NXT '
       || round(nxt_change_pct, 1) || '% (괴리 ' || round(gap_pct, 1) || '%p, 상위' || gap_rank || '위)'
FROM closebet2_stage1

UNION ALL
-- ── 종가베팅2 2단계 (1단계 10종목 중 시가총액 상위 3, 가상매수 대상) ────────
SELECT trade_date, code, 'V4_CAND_CLOSEBET2_2', 'WATCH', score,
  jsonb_build_object('strategy','CLOSEBET2','stage',2,
    'change_pct',change_pct,'nxt_change_pct',nxt_change_pct,'gap_pct',gap_pct,'gap_rank',gap_rank,
    'cap_rank_top10',cap_rank_top10,
    'nxt_close',nxt_close,'market_cap',market_cap,'weight_rank',weight_rank,'pick_score',pick_score,'close',close),
  name || ' 종가베팅2 2단계(매수) · 정규장 ' || round(change_pct, 1) || '% → NXT '
       || round(nxt_change_pct, 1) || '% (괴리 ' || round(gap_pct, 1) || '%p)'
       || ' · 시가총액 상위' || cap_rank_top10 || '위(10종목 중)'
       || ' · NXT 마감가 ' || nxt_close || '원 매수'
FROM closebet2_stage1
WHERE cap_rank_top10 <= 3

ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
  grade       = EXCLUDED.grade,
  score       = EXCLUDED.score,
  reason      = EXCLUDED.reason,
  reason_text = EXCLUDED.reason_text;
  -- notified는 일부러 갱신하지 않습니다 (재실행 시 중복 알림 방지)
