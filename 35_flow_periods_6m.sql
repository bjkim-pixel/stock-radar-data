-- ============================================================================
-- STOCK RADAR · 수급 동향 조회기간 "1년" → "6개월" 변경
-- ============================================================================
-- v_market_flow_periods / v_stock_flow_periods의 _1y 컬럼을 _6m으로 교체합니다.
-- 6개월 ≈ 125 거래일 (기존 1년 ≈ 250 거래일 절반).
-- 윈도우 CTE의 where 조건도 ago < 250 → ago < 125 로 단축합니다.
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
  where d.ago < 125
)
select
  sum(foreign_net)   filter (where ago<125) as foreign_6m,
  sum(foreign_net)   filter (where ago<60)  as foreign_3m,
  sum(foreign_net)   filter (where ago<40)  as foreign_2m,
  sum(foreign_net)   filter (where ago<20)  as foreign_1m,
  sum(foreign_net)   filter (where ago<10)  as foreign_2w,
  sum(foreign_net)   filter (where ago<5)   as foreign_1w,
  sum(foreign_net)   filter (where ago<1)   as foreign_1d,
  sum(inst_net)      filter (where ago<125) as inst_6m,
  sum(inst_net)      filter (where ago<60)  as inst_3m,
  sum(inst_net)      filter (where ago<40)  as inst_2m,
  sum(inst_net)      filter (where ago<20)  as inst_1m,
  sum(inst_net)      filter (where ago<10)  as inst_2w,
  sum(inst_net)      filter (where ago<5)   as inst_1w,
  sum(inst_net)      filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)   filter (where ago<125) as fin_inv_6m,
  sum(fin_inv_net)   filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)   filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)   filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)   filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)   filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)   filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net) filter (where ago<125) as inv_trust_6m,
  sum(inv_trust_net) filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net) filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net) filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net) filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net) filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net) filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)   filter (where ago<125) as pension_6m,
  sum(pension_net)   filter (where ago<60)  as pension_3m,
  sum(pension_net)   filter (where ago<40)  as pension_2m,
  sum(pension_net)   filter (where ago<20)  as pension_1m,
  sum(pension_net)   filter (where ago<10)  as pension_2w,
  sum(pension_net)   filter (where ago<5)   as pension_1w,
  sum(pension_net)   filter (where ago<1)   as pension_1d,
  sum(pe_net)        filter (where ago<125) as pe_6m,
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
  where d.ago < 125
)
select code,
  sum(foreign_net)   filter (where ago<125) as foreign_6m,
  sum(foreign_net)   filter (where ago<60)  as foreign_3m,
  sum(foreign_net)   filter (where ago<40)  as foreign_2m,
  sum(foreign_net)   filter (where ago<20)  as foreign_1m,
  sum(foreign_net)   filter (where ago<10)  as foreign_2w,
  sum(foreign_net)   filter (where ago<5)   as foreign_1w,
  sum(foreign_net)   filter (where ago<1)   as foreign_1d,
  sum(inst_net)      filter (where ago<125) as inst_6m,
  sum(inst_net)      filter (where ago<60)  as inst_3m,
  sum(inst_net)      filter (where ago<40)  as inst_2m,
  sum(inst_net)      filter (where ago<20)  as inst_1m,
  sum(inst_net)      filter (where ago<10)  as inst_2w,
  sum(inst_net)      filter (where ago<5)   as inst_1w,
  sum(inst_net)      filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)   filter (where ago<125) as fin_inv_6m,
  sum(fin_inv_net)   filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)   filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)   filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)   filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)   filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)   filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net) filter (where ago<125) as inv_trust_6m,
  sum(inv_trust_net) filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net) filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net) filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net) filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net) filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net) filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)   filter (where ago<125) as pension_6m,
  sum(pension_net)   filter (where ago<60)  as pension_3m,
  sum(pension_net)   filter (where ago<40)  as pension_2m,
  sum(pension_net)   filter (where ago<20)  as pension_1m,
  sum(pension_net)   filter (where ago<10)  as pension_2w,
  sum(pension_net)   filter (where ago<5)   as pension_1w,
  sum(pension_net)   filter (where ago<1)   as pension_1d,
  sum(pe_net)        filter (where ago<125) as pe_6m,
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
