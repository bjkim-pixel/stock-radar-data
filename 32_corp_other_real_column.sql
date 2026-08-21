-- ============================================================================
-- STOCK RADAR · corp_other_net(기타법인)을 "역산값"에서 "KIS 실측값"으로 전환
-- ============================================================================
-- 배경: 31_flow_subj_individual_corp.sql에서는 corp_other_net을
--   generated always as (-(개인+외국인등록+기관계)) stored
-- 로 만들었습니다. 투자자 순매수 총합이 0이라는 항등식 자체는 맞지만,
-- 이 코드베이스는 "외국인" 컬럼에 등록분(frgn_reg_ntby_pbmn)만 쓰고
-- 미등록분은 어디에도 저장하지 않습니다(04_backfill.py 주석: KRX '외국인'과
-- 시계열을 맞추려고 의도적으로 등록분만 사용). 즉 역산식으로 만들면
-- "진짜 기타법인" 대신 "기타법인 + 외국인(미등록)"이 섞여서 나옵니다 —
-- 매일 수집하는 API 응답에 진짜 기타법인 필드(etc_corp_ntby_tr_pbmn)가
-- 이미 들어있는데 굳이 오차 있는 역산값을 쓸 이유가 없습니다.
--
-- 그래서 이번엔 03_daily_collect.py / 04_backfill.py가 그 실제 필드를
-- 파싱·저장하도록 고쳤고(이 파일과 같이 전달), corp_other_net은
-- daily_flow의 다른 *_net 컬럼들과 동일하게 "그냥 저장되는 값"이어야
-- 합니다. 이 파일은 (31을 이미 실행했다면) generated 컬럼을 일반 컬럼으로
-- 전환하고, (아직 안 했다면) 처음부터 일반 컬럼으로 추가합니다. 실행
-- 순서와 무관하게 안전합니다.
--
-- ⚠ 이 파일 실행 후 반드시 04_backfill.py를 2025-09-01~2026-08-21
--   범위로 다시 돌려야 corp_other_net이 실제 KIS 값으로 채워집니다
--   (그 전까지는 31에서 만든 역산값이 남아있거나, 31을 안 돌렸다면
--   전부 NULL입니다 — 화면엔 "–"로 표시될 뿐 에러는 없습니다).
--   개인(individual_net)은 원래부터 실제 API 값이라 이 파일과 무관하게
--   이미 정확합니다.
--
-- ⚠ 실행 순서: 30 → 31(이미 돌렸다면) → 이 파일 → 04_backfill.py 재실행
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'daily_flow'
      and column_name = 'corp_other_net' and is_generated = 'ALWAYS'
  ) then
    -- 31에서 만든 generated 컬럼 → 일반 컬럼으로 전환(기존 역산값은 일단
    -- 그대로 남지만, 04_backfill.py 재실행 시 실제값으로 전부 덮어써집니다)
    execute 'alter table daily_flow alter column corp_other_net drop expression';
    raise notice 'corp_other_net: generated → 일반 컬럼으로 전환 완료';
  elsif not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'daily_flow'
      and column_name = 'corp_other_net'
  ) then
    execute 'alter table daily_flow add column corp_other_net bigint';
    raise notice 'corp_other_net: 신규 일반 컬럼 추가 완료';
  else
    raise notice 'corp_other_net: 이미 일반 컬럼 — 변경 없음';
  end if;
end $$;

comment on column daily_flow.corp_other_net is
  '기타법인. KIS investor-trade-by-stock-daily 응답의 etc_corp_ntby_tr_pbmn 필드를 그대로 저장(03_daily_collect.py/04_backfill.py). 역산값 아님';

-- v_market_flow_periods / v_stock_flow_periods / v_market_overview /
-- v_sector_flow_daily / v_stock_chart / v_screener는 전부 daily_flow.
-- corp_other_net을 "컬럼명으로만" 참조하므로(generated든 일반이든 SQL
-- 상에서 구분 없음) 31에서 만든 뷰 정의를 다시 만들 필요가 없습니다.

-- ── 확인 ──────────────────────────────────────────────────────────────────
-- 1) 이제 일반 컬럼인지 (generated_always가 아니어야 정상)
select column_name, is_generated, generation_expression
from information_schema.columns
where table_name = 'daily_flow' and column_name = 'corp_other_net';

-- 2) 04_backfill.py를 다시 돌리기 전 채워진 행 수(31 실행 여부에 따라
--    0이거나, 31의 역산값이 남아 있을 수 있습니다 — 재백필 후 다시 확인하세요)
select count(*) filter (where corp_other_net is not null) as filled,
       count(*) as total
from daily_flow;
