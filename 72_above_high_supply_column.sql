-- ============================================================================
-- STOCK RADAR · daily_metrics에 "위쪽 매물대"(현재가 위쪽만 24등분) 컬럼 추가
-- ============================================================================
-- 종목상세의 "매물대 총합계"(-10%~+90% 24구간, 그 중 현재가 위쪽만 합산)와는
-- 정의가 다릅니다. 이번 요청(2026-09-20, 종목후보용)은:
--   · 가격 구간: 현재가 ~ 조회기간(lookback) 내 최고 종가, 그 사이를 24등분
--     (아래쪽은 아예 안 보고, 위쪽 구간에만 24개 해상도를 전부 씀)
--   · 각 구간에 종가가 그 구간에 있었던 날들의 individual_net을 합산
--   · 그 중 구간 합계가 양수(+)인 구간만 다시 합산 = "위쪽 매물대 총합계" (억원)
--   · 현재가가 이미 조회기간 내 최고가(더 위가 없음)면 0
--
-- 종목후보(결과 표)에서만 쓰는 용도라 컬럼명을 분리합니다 — 나중에 종목상세용
-- 정의(above_supply_eok, -10%~+90% 기준)를 추가해도 서로 안 겹칩니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행 (Claude는 DB 쓰기 권한이
--   없어 직접 실행할 수 없습니다).
-- ============================================================================

alter table daily_metrics
  add column if not exists above_high_supply_eok numeric(14, 2);

comment on column daily_metrics.above_high_supply_eok is
  '현재가~조회기간 내 최고 종가 구간을 24등분해서 계산한 개인 누적 순매수 합계(양수 구간만), 단위 억원 — 종목후보 결과 표 전용. 매일 그날(end_date) 값만 계산해 덮어씀(과거 행은 NULL). 05_metrics.sql의 overhead_high CTE 참고.';

-- ── 확인 ──────────────────────────────────────────────────────────────────
select column_name, data_type, numeric_precision, numeric_scale
from information_schema.columns
where table_name = 'daily_metrics'
  and column_name = 'above_high_supply_eok';
