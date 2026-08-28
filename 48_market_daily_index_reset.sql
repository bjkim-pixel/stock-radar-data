-- ============================================================================
-- STOCK RADAR · market_daily 지수 컬럼(KOSPI/KOSDAQ) 잔여 합성값 초기화
-- ============================================================================
-- 배경: 05_metrics.sql의 market_daily STEP이 예전엔 실제 지수가 없어서
-- "시총가중 등락률을 1000부터 복리로 누적곱"한 합성 지수를
-- index_close/index_change/index_change_pct/index_ma20에 채워 넣었습니다.
-- 이후 20_collect_market_extra.py가 KIS 실제 지수를 매일 수집하도록
-- 바뀌었지만, compute.yml이 daily_collect.yml 직후 돌면서 그 STEP이 실제
-- 값을 다시 합성값으로 덮어쓰는 사고가 있었습니다(05_metrics.sql은 이미
-- 수정 완료 — 이제 이 컬럼들을 절대 건드리지 않습니다).
--
-- 문제: KIS Backfill(target=index)을 돌려도 그 실행이 실제로 데이터를
-- 받아온 날짜만 덮어써질 뿐, 과거에 이미 합성값으로 저장돼버린 날짜 중
-- 이번 백필 응답에 포함되지 않은 날짜(요청 범위 밖이거나 KIS 쪽에 그날
-- 데이터가 없는 경우)는 예전 합성값이 그대로 남습니다 — 차트에서 중간에
-- 뚝 끊기고 스케일이 안 맞는 구간으로 계속 보이는 이유입니다.
--
-- 조치: KOSPI/KOSDAQ의 지수 관련 컬럼을 전부 NULL로 비웁니다. 프런트엔드
-- (docs/index.html)는 index_close IS NULL인 행을 차트에서 건너뛰므로,
-- 이 상태에서는 "아직 실제 지수를 수집하지 못한 날짜"가 차트에 아예
-- 나타나지 않습니다(끊기거나 튀는 대신 조용히 빠짐) — 이후 백필로
-- 채워지는 대로 하나씩 정상적으로 나타납니다.
--
-- ⚠ 실행 순서:
--   1) 이 파일을 Supabase SQL Editor에 붙여넣어 실행 (지수 컬럼만 초기화,
--      total_amount/foreign_net/inst_net/individual_net/regime 등 다른
--      컬럼은 그대로 유지됩니다)
--   2) GitHub Actions → KIS Backfill → target: index, start_date: 20250901
--      실행 (실제 KOSPI/KOSDAQ 지수로 전체 기간 재채움)
--   3) (선택) Compute Metrics & Signals를 전체 기간으로 한 번 더 돌리면
--      regime 컬럼이 이번에 새로 채워진 실제 지수를 반영해 갱신됩니다
--      (05_metrics.sql은 이제 index_close를 읽기만 하고 덮어쓰지 않으므로
--      이 단계에서 지수 컬럼이 다시 오염될 걱정은 없습니다)
-- ============================================================================

UPDATE market_daily
SET index_close       = NULL,
    index_change      = NULL,
    index_change_pct  = NULL,
    index_ma20        = NULL,
    index_amount      = NULL
WHERE market IN ('KOSPI', 'KOSDAQ');


-- ── 확인용 쿼리 (그대로 실행해서 결과 확인) ──────────────────────────────────
-- 전부 NULL이 아닌 행수가 0으로 나와야 정상 초기화된 것입니다.
SELECT market, count(*) FILTER (WHERE index_close IS NOT NULL) AS remaining
FROM market_daily
WHERE market IN ('KOSPI', 'KOSDAQ')
GROUP BY market;
