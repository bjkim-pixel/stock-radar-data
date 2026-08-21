-- ============================================================================
-- STOCK RADAR · 수급 동향 조회기간에 "1년" 추가
-- ============================================================================
-- v_market_flow_periods / v_stock_flow_periods(26_flow_periods_2m.sql)는
-- 최근 60거래일(약 3개월)까지만 집계했습니다. "1년"을 추가하려면 그 창을
-- 250거래일로 늘려야 합니다 — 250은 이 코드베이스에서 이미 "1년" 근사치로
-- 쓰는 값과 동일합니다(daily_metrics.is_new_high_all의 250일 롤링 신고가
-- 판정과 동일 관례).
--
-- daily_flow에 250거래일치 데이터가 실제로 없는 종목이라도 안전합니다 —
-- 아래 f CTE는 daily_flow를 그냥 INNER JOIN하므로, 없는 날짜는 합계에서
-- 자연히 빠질 뿐 에러가 나거나 잘못된 값이 나오지 않습니다.
--
-- ⚠ v_stock_flow_periods를 cascade로 지우면 v_market_flow_periods는 별개
--   뷰라 영향 없지만, 혹시 모를 의존 뷰가 없는지 확인 후 둘 다 재생성합니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_stock_flow_periods cascade;
drop view if exists v_market_flow_periods cascade;

create view v_market_flow_periods
with (security_invoker = true) as
with dates as (
  select trade_date, row_number() over (order by trade_date desc) - 1 as ago
  from (select distinct trade_date from daily_price) t
),
f as (
  select fl.*, d.ago
  from daily_flow fl
  join dates d on d.trade_date = fl.trade_date
  where d.ago < 250
)
select
  sum(foreign_net)   filter (where ago<250) as foreign_1y,
  sum(foreign_net)   filter (where ago<60)  as foreign_3m,
  sum(foreign_net)   filter (where ago<40)  as foreign_2m,
  sum(foreign_net)   filter (where ago<20)  as foreign_1m,
  sum(foreign_net)   filter (where ago<10)  as foreign_2w,
  sum(foreign_net)   filter (where ago<5)   as foreign_1w,
  sum(foreign_net)   filter (where ago<1)   as foreign_1d,
  sum(inst_net)      filter (where ago<250) as inst_1y,
  sum(inst_net)      filter (where ago<60)  as inst_3m,
  sum(inst_net)      filter (where ago<40)  as inst_2m,
  sum(inst_net)      filter (where ago<20)  as inst_1m,
  sum(inst_net)      filter (where ago<10)  as inst_2w,
  sum(inst_net)      filter (where ago<5)   as inst_1w,
  sum(inst_net)      filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)   filter (where ago<250) as fin_inv_1y,
  sum(fin_inv_net)   filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)   filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)   filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)   filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)   filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)   filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net) filter (where ago<250) as inv_trust_1y,
  sum(inv_trust_net) filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net) filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net) filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net) filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net) filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net) filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)   filter (where ago<250) as pension_1y,
  sum(pension_net)   filter (where ago<60)  as pension_3m,
  sum(pension_net)   filter (where ago<40)  as pension_2m,
  sum(pension_net)   filter (where ago<20)  as pension_1m,
  sum(pension_net)   filter (where ago<10)  as pension_2w,
  sum(pension_net)   filter (where ago<5)   as pension_1w,
  sum(pension_net)   filter (where ago<1)   as pension_1d,
  sum(pe_net)        filter (where ago<250) as pe_1y,
  sum(pe_net)        filter (where ago<60)  as pe_3m,
  sum(pe_net)        filter (where ago<40)  as pe_2m,
  sum(pe_net)        filter (where ago<20)  as pe_1m,
  sum(pe_net)        filter (where ago<10)  as pe_2w,
  sum(pe_net)        filter (where ago<5)   as pe_1w,
  sum(pe_net)        filter (where ago<1)   as pe_1d
from f;

create view v_stock_flow_periods
with (security_invoker = true) as
with dates as (
  select trade_date, row_number() over (order by trade_date desc) - 1 as ago
  from (select distinct trade_date from daily_price) t
),
f as (
  select fl.*, d.ago
  from daily_flow fl
  join dates d on d.trade_date = fl.trade_date
  where d.ago < 250
)
select code,
  sum(foreign_net)   filter (where ago<250) as foreign_1y,
  sum(foreign_net)   filter (where ago<60)  as foreign_3m,
  sum(foreign_net)   filter (where ago<40)  as foreign_2m,
  sum(foreign_net)   filter (where ago<20)  as foreign_1m,
  sum(foreign_net)   filter (where ago<10)  as foreign_2w,
  sum(foreign_net)   filter (where ago<5)   as foreign_1w,
  sum(foreign_net)   filter (where ago<1)   as foreign_1d,
  sum(inst_net)      filter (where ago<250) as inst_1y,
  sum(inst_net)      filter (where ago<60)  as inst_3m,
  sum(inst_net)      filter (where ago<40)  as inst_2m,
  sum(inst_net)      filter (where ago<20)  as inst_1m,
  sum(inst_net)      filter (where ago<10)  as inst_2w,
  sum(inst_net)      filter (where ago<5)   as inst_1w,
  sum(inst_net)      filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)   filter (where ago<250) as fin_inv_1y,
  sum(fin_inv_net)   filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)   filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)   filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)   filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)   filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)   filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net) filter (where ago<250) as inv_trust_1y,
  sum(inv_trust_net) filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net) filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net) filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net) filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net) filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net) filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)   filter (where ago<250) as pension_1y,
  sum(pension_net)   filter (where ago<60)  as pension_3m,
  sum(pension_net)   filter (where ago<40)  as pension_2m,
  sum(pension_net)   filter (where ago<20)  as pension_1m,
  sum(pension_net)   filter (where ago<10)  as pension_2w,
  sum(pension_net)   filter (where ago<5)   as pension_1w,
  sum(pension_net)   filter (where ago<1)   as pension_1d,
  sum(pe_net)        filter (where ago<250) as pe_1y,
  sum(pe_net)        filter (where ago<60)  as pe_3m,
  sum(pe_net)        filter (where ago<40)  as pe_2m,
  sum(pe_net)        filter (where ago<20)  as pe_1m,
  sum(pe_net)        filter (where ago<10)  as pe_2w,
  sum(pe_net)        filter (where ago<5)   as pe_1w,
  sum(pe_net)        filter (where ago<1)   as pe_1d
from f
group by code;

do $$
begin
  grant select on v_market_flow_periods, v_stock_flow_periods to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
