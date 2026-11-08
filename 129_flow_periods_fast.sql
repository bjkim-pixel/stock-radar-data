-- 129_flow_periods_fast.sql — v_stock_flow_periods 속도 개선(2026-11-08). 결과 컬럼·값은 59_flow_periods_6m_reunify.sql과 동일.
-- 바뀐 점: ① 거래일 목록을 인덱스 건너뛰기로 구함 ② daily_flow/daily_program을 날짜 범위로 먼저 거름.
-- 적용은 129_flow_periods_fast.py가 "기존 뷰와 결과가 완전히 같은지" 확인한 뒤에만 함.
create or replace view v_stock_flow_periods
with (security_invoker = true) as
with recursive ds(d) as (   -- 거래일 목록: daily_price 전체(10만+행)를 훑는 distinct 대신 인덱스로 날짜만 건너뛰며 조회(결과 동일)
  select max(trade_date) from daily_price
  union all
  select (select max(x.trade_date) from daily_price x where x.trade_date < ds.d) from ds where ds.d is not null
),
dates as (
  select d as trade_date, row_number() over (order by d desc) - 1 as ago
  from ds where d is not null
),
cut as (select min(trade_date) as d0 from dates where ago < 125),
f as (
  select fl.*, d.ago
  from daily_flow fl
  join dates d on d.trade_date = fl.trade_date
  where d.ago < 125 and fl.trade_date >= (select d0 from cut)   -- 날짜 범위로 먼저 걸러 125번 반복 조회를 한 번의 범위 조회로
),
dp as (
  select p.*, d.ago
  from daily_program p
  join dates d on d.trade_date = p.trade_date
  where d.ago < 125 and p.trade_date >= (select d0 from cut)
),
pg as (
  select code,
    sum(pgtr_net_amt) filter (where ago<125) as program_6m,
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
    sum(foreign_net)     filter (where ago<125) as foreign_6m,
    sum(foreign_net)     filter (where ago<60)  as foreign_3m,
    sum(foreign_net)     filter (where ago<40)  as foreign_2m,
    sum(foreign_net)     filter (where ago<20)  as foreign_1m,
    sum(foreign_net)     filter (where ago<10)  as foreign_2w,
    sum(foreign_net)     filter (where ago<5)   as foreign_1w,
    sum(foreign_net)     filter (where ago<1)   as foreign_1d,
    sum(inst_net)        filter (where ago<125) as inst_6m,
    sum(inst_net)        filter (where ago<60)  as inst_3m,
    sum(inst_net)        filter (where ago<40)  as inst_2m,
    sum(inst_net)        filter (where ago<20)  as inst_1m,
    sum(inst_net)        filter (where ago<10)  as inst_2w,
    sum(inst_net)        filter (where ago<5)   as inst_1w,
    sum(inst_net)        filter (where ago<1)   as inst_1d,
    sum(fin_inv_net)     filter (where ago<125) as fin_inv_6m,
    sum(fin_inv_net)     filter (where ago<60)  as fin_inv_3m,
    sum(fin_inv_net)     filter (where ago<40)  as fin_inv_2m,
    sum(fin_inv_net)     filter (where ago<20)  as fin_inv_1m,
    sum(fin_inv_net)     filter (where ago<10)  as fin_inv_2w,
    sum(fin_inv_net)     filter (where ago<5)   as fin_inv_1w,
    sum(fin_inv_net)     filter (where ago<1)   as fin_inv_1d,
    sum(inv_trust_net)   filter (where ago<125) as inv_trust_6m,
    sum(inv_trust_net)   filter (where ago<60)  as inv_trust_3m,
    sum(inv_trust_net)   filter (where ago<40)  as inv_trust_2m,
    sum(inv_trust_net)   filter (where ago<20)  as inv_trust_1m,
    sum(inv_trust_net)   filter (where ago<10)  as inv_trust_2w,
    sum(inv_trust_net)   filter (where ago<5)   as inv_trust_1w,
    sum(inv_trust_net)   filter (where ago<1)   as inv_trust_1d,
    sum(pension_net)     filter (where ago<125) as pension_6m,
    sum(pension_net)     filter (where ago<60)  as pension_3m,
    sum(pension_net)     filter (where ago<40)  as pension_2m,
    sum(pension_net)     filter (where ago<20)  as pension_1m,
    sum(pension_net)     filter (where ago<10)  as pension_2w,
    sum(pension_net)     filter (where ago<5)   as pension_1w,
    sum(pension_net)     filter (where ago<1)   as pension_1d,
    sum(pe_net)          filter (where ago<125) as pe_6m,
    sum(pe_net)          filter (where ago<60)  as pe_3m,
    sum(pe_net)          filter (where ago<40)  as pe_2m,
    sum(pe_net)          filter (where ago<20)  as pe_1m,
    sum(pe_net)          filter (where ago<10)  as pe_2w,
    sum(pe_net)          filter (where ago<5)   as pe_1w,
    sum(pe_net)          filter (where ago<1)   as pe_1d,
    sum(individual_net)  filter (where ago<125) as individual_6m,
    sum(individual_net)  filter (where ago<60)  as individual_3m,
    sum(individual_net)  filter (where ago<40)  as individual_2m,
    sum(individual_net)  filter (where ago<20)  as individual_1m,
    sum(individual_net)  filter (where ago<10)  as individual_2w,
    sum(individual_net)  filter (where ago<5)   as individual_1w,
    sum(individual_net)  filter (where ago<1)   as individual_1d,
    sum(corp_other_net)  filter (where ago<125) as corp_other_6m,
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
       pg.program_6m, pg.program_3m, pg.program_2m, pg.program_1m,
       pg.program_2w, pg.program_1w, pg.program_1d
from base
left join pg on pg.code = base.code;
