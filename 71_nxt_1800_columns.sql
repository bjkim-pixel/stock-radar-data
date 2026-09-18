-- ============================================================================
-- STOCK RADAR · daily_price에 "NXT 18시 스냅샷" 컬럼 추가 (종가베팅2 기준 변경)
-- ============================================================================
-- 배경: 종가베팅2는 원래 NXT 20:00 공식 마감가에 매수하는 전략이었습니다
-- (69_nxt_price_columns.sql의 nxt_close/nxt_change_pct). 그런데 이 값은
-- 정의상 20:00 KST 전엔 존재하지 않아서, 결과가 항상 20:10경에나 확정됐고
-- 사용자가 실제 매매(NXT 장 마감 20:00 전)에 쓸 수 없었습니다(2026-09-18
-- 사용자 피드백).
--
-- 그래서 종가베팅2의 매수 기준가를 "NXT 20시 확정 마감가"에서 "NXT 18시
-- 스냅샷가"로 바꿉니다 — 18시경(nxt_collect.yml 그날 첫 실행) NXT 시세를
-- 한 번만 저장하고, 이후 같은 날 재실행(18:30~20:10)에도 절대 덮어쓰지
-- 않습니다(70_nxt_collect.py가 IS NULL일 때만 SET하도록 수정됨 — UPSERT의
-- COALESCE(daily_price.nxt_price_1800, EXCLUDED.nxt_price_1800) 참고).
--
-- 과거 데이터(2026-09-18 이전)는 이 컬럼이 없어 전부 NULL입니다 —
-- 06_signals.sql의 base CTE가 COALESCE(nxt_price_1800, nxt_close)로 옛
-- nxt_close(20시 확정값)에 자동 폴백하므로, 과거 종가베팅2 거래 이력·성과
-- 통계는 이 마이그레이션으로 바뀌지 않습니다. 오늘(2026-09-18)부터 새로
-- 쌓이는 날짜만 18시 스냅샷 기준으로 계산됩니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행 (Claude는 DB 쓰기 권한이
--   없어 직접 실행할 수 없습니다 — 이 파일을 실행해주셔야 종가베팅2가 18시
--   기준으로 동작합니다). 69_nxt_price_columns.sql이 이미 실행돼 있어야
--   합니다(nxt_close/nxt_change_pct 폴백 대상 컬럼이 먼저 있어야 함).
-- ============================================================================

alter table daily_price
  add column if not exists nxt_price_1800      bigint,
  add column if not exists nxt_change_pct_1800 numeric(10,4);

comment on column daily_price.nxt_price_1800 is
  '그날 첫 NXT 수집(nxt_collect.yml 18:12 KST 실행)에서 딱 한 번만 저장되는 스냅샷 — 같은 날 이후 재실행에도 절대 덮어쓰지 않음(70_nxt_collect.py). 종가베팅2가 2026-09-18부터 이 값을 매수가로 씀. 이 컬럼이 NULL인 과거 행(2026-09-18 이전)은 06_signals.sql이 기존 nxt_close(20시 확정 마감가)로 자동 폴백 — 과거 이력 보존.';
comment on column daily_price.nxt_change_pct_1800 is
  'nxt_price_1800과 세트 — 18시 스냅샷 시점의 NXT 등락률. 용도·폴백 규칙은 nxt_price_1800 주석 참고.';

-- ── 확인 ──────────────────────────────────────────────────────────────────
select column_name, data_type
from information_schema.columns
where table_name = 'daily_price'
  and column_name in ('nxt_close', 'nxt_change_pct', 'nxt_price_1800', 'nxt_change_pct_1800');
