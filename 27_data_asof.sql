-- ============================================================================
-- STOCK RADAR · 상단에 "몇시몇분 기준 데이터"인지 표시
-- ============================================================================
-- daily_price/daily_flow는 trade_date(날짜)만 있고 실제로 몇 시에 적재됐는지는
-- 저장하지 않았습니다. collected_at 컬럼을 추가하고, 03_daily_collect.py의
-- UPSERT가 매 실행마다(장중 --partial 스냅샷이든, 장마감 확정 수집이든) 그
-- 시각으로 갱신하도록 이미 코드를 고쳐뒀습니다(이 SQL과 함께 배포).
--
-- v_data_status는 최신 거래일 기준 "가장 최근에 갱신된 시각"과 "그 날짜 데이터가
-- 아직 장중 잠정치를 포함하고 있는지(is_partial)"를 한 행으로 돌려줍니다 —
-- 사이트 상단 칩에 "기준 16:05 · 확정" / "기준 14:00 · 잠정" 처럼 표시하는 용도.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

alter table daily_price add column if not exists collected_at timestamptz;
alter table daily_flow  add column if not exists collected_at timestamptz;

comment on column daily_price.collected_at is '이 행이 마지막으로 upsert된 시각(KST 아님, UTC) — 장중 --partial 스냅샷마다, 장마감 확정 수집마다 갱신됨';
comment on column daily_flow.collected_at  is '이 행이 마지막으로 upsert된 시각(UTC) — daily_price.collected_at과 동일한 용도';

drop view if exists v_data_status cascade;
create view v_data_status
with (security_invoker = true) as
select trade_date,
       max(collected_at) as as_of,
       bool_or(coalesce(is_partial, false)) as is_partial,
       count(*) as stock_count
from daily_price
where trade_date = (select max(trade_date) from daily_price)
group by trade_date;

do $$
begin
  grant select on v_data_status to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
