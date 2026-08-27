-- ============================================================================
-- STOCK RADAR · v_stock_flow_periods — _6m → _1y 롤백 (43번 취소)
-- ============================================================================
-- 43_stock_flow_periods_6m.sql을 적용했다면 이 파일로 되돌립니다.
-- 42번 SQL과 동일한 뷰 정의 (_1y, ago<250) 를 재생성합니다.
--
-- ⚠ 43번 SQL을 Supabase에 적용하지 않았다면 이 파일은 실행 불필요.
-- ============================================================================

drop view if exists v_stock_flow_periods cascade;

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
),
dp as (
  select p.*, d.ago
  from daily_program p
  join dates d on d.trade_date = p.trade_date
  where d.ago < 250
),
pg as (
  select code,
    sum(pgtr_net_amt) filter (where ago<250) as program_1y,
    sum(pgtr_net_amt) filter (where ago<60)  as program_3m,
    sum(pgtr_net_amt) filter (where ago<40)  as program_2m,
    sum(pgtr_net_amt) filter (where ago<20)  as program_1m,
    sum(pgtr_net_amt) filter (where ago<10)  as program_2w,
    sum(pgtr_net_amt) filter (where ago<5)   as program_1w,
    sum(pgtr_net_amt) filter (where ago<1)   as program_1d
  from dp
  group by code
),
base as (
  select code,
    sum(foreign_net)     filter (where ago<250) as foreign_1y,
    sum(foreign_net)     filter (where ago<60)  as foreign_3m,
    sum(foreign_net)     filter (where ago<40)  as foreign_2m,
    sum(foreign_net)     filter (where ago<20)  as foreign_1m,
    sum(foreign_net)     filter (where ago<10)  as foreign_2w,
    sum(foreign_net)     filter (where ago<5)   as foreign_1w,
    sum(foreign_net)     filter (where ago<1)   as foreign_1d,
    sum(inst_net)        filter (where ago<250) as inst_1y,
    sum(inst_net)        filter (where ago<60)  as inst_3m,
    sum(inst_net)        filter (where ago<40)  as inst_2m,
    sum(inst_net)        filter (where ago<20)  as inst_1m,
    sum(inst_net)        filter (where ago<10)  as inst_2w,
    sum(inst_net)        filter (where ago<5)   as inst_1w,
    sum(inst_net)        filter (where ago<1)   as inst_1d,
    sum(fin_inv_net)     filter (where ago<250) as fin_inv_1y,
    sum(fin_inv_net)     filter (where ago<60)  as fin_inv_3m,
    sum(fin_inv_net)     filter (where ago<40)  as fin_inv_2m,
    sum(fin_inv_net)     filter (where ago<20)  as fin_inv_1m,
    sum(fin_inv_net)     filter (where ago<10)  as fin_inv_2w,
    sum(fin_inv_net)     filter (where ago<5)   as fin_inv_1w,
    sum(fin_inv_net)     filter (where ago<1)   as fin_inv_1d,
    sum(inv_trust_net)   filter (where ago<250) as inv_trust_1y,
    sum(inv_trust_net)   filter (where ago<60)  as inv_trust_3m,
    sum(inv_trust_net)   filter (where ago<40)  as inv_trust_2m,
    sum(inv_trust_net)   filter (where ago<20)  as inv_trust_1m,
    sum(inv_trust_net)   filter (where ago<10)  as inv_trust_2w,
    sum(inv_trust_net)   filter (where ago<5)   as inv_trust_1w,
    sum(inv_trust_net)   filter (where ago<1)   as inv_trust_1d,
    sum(pension_net)     filter (where ago<250) as pension_1y,
    sum(pension_net)     filter (where ago<60)  as pension_3m,
    sum(pension_net)     filter (where ago<40)  as pension_2m,
    sum(pension_net)     filter (where ago<20)  as pension_1m,
    sum(pension_net)     filter (where ago<10)  as pension_2w,
    sum(pension_net)     filter (where ago<5)   as pension_1w,
    sum(pension_net)     filter (where ago<1)   as pension_1d,
    sum(pe_net)          filter (where ago<250) as pe_1y,
    sum(pe_net)          filter (where ago<60)  as pe_3m,
    sum(pe_net)          filter (where ago<40)  as pe_2m,
    sum(pe_net)          filter (where ago<20)  as pe_1m,
    sum(pe_net)          filter (where ago<10)  as pe_2w,
    sum(pe_net)          filter (where ago<5)   as pe_1w,
    sum(pe_net)          filter (where ago<1)   as pe_1d,
    sum(individual_net)  filter (where ago<250) as individual_1y,
    sum(individual_net)  filter (where ago<60)  as individual_3m,
    sum(individual_net)  filter (where ago<40)  as individual_2m,
    sum(individual_net)  filter (where ago<20)  as individual_1m,
    sum(individual_net)  filter (where ago<10)  as individual_2w,
    sum(individual_net)  filter (where ago<5)   as individual_1w,
    sum(individual_net)  filter (where ago<1)   as individual_1d,
    sum(corp_other_net)  filter (where ago<250) as corp_other_1y,
    sum(corp_other_net)  filter (where ago<60)  as corp_other_3m,
    sum(corp_other_net)  filter (where ago<40)  as corp_other_2m,
    sum(corp_other_net)  filter (where ago<20)  as corp_other_1m,
    sum(corp_other_net)  filter (where ago<10)  as corp_other_2w,
    sum(corp_other_net)  filter (where ago<5)   as corp_other_1w,
    sum(corp_other_net)  filter (where ago<1)   as corp_other_1d
  from f
  group by code
)
select base.*,
       pg.program_1y, pg.program_3m, pg.program_2m, pg.program_1m,
       pg.program_2w, pg.program_1w, pg.program_1d
from base
left join pg on pg.code = base.code;


-- ── anon(브라우저) 읽기 권한 재부여 ──────────────────────────────────────────
do $$
begin
  grant select on v_stock_flow_periods to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select * from v_stock_flow_periods limit 3;
