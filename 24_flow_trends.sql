-- ============================================================================
-- STOCK RADAR · 수급 동향 탭 신규 뷰
-- ============================================================================
-- v_market_flow_periods : 시장 전체 수급주체별 순매수 거래대금(3개월/1개월/2주/1주/오늘) 1행
-- v_stock_flow_periods  : 종목별 수급주체별 순매수 거래대금(위와 동일 5개 기간) 합계
-- v_stock_flow_ranked   : v_stock_flow_periods + 종목명/업종/종가/등락률/시총 (Top10 랭킹용)
--
-- "ago"는 거래일 기준 역순 순번(0=최신 거래일)이라 달력일이 아니라 실제 거래일
-- 수로 3개월(60)/1개월(20)/2주(10)/1주(5)/오늘(1)을 정확히 자릅니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_stock_flow_ranked cascade;
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
  where d.ago < 60
)
select
  sum(foreign_net)   filter (where ago<60) as foreign_3m,
  sum(foreign_net)   filter (where ago<20) as foreign_1m,
  sum(foreign_net)   filter (where ago<10) as foreign_2w,
  sum(foreign_net)   filter (where ago<5)  as foreign_1w,
  sum(foreign_net)   filter (where ago<1)  as foreign_1d,
  sum(inst_net)      filter (where ago<60) as inst_3m,
  sum(inst_net)      filter (where ago<20) as inst_1m,
  sum(inst_net)      filter (where ago<10) as inst_2w,
  sum(inst_net)      filter (where ago<5)  as inst_1w,
  sum(inst_net)      filter (where ago<1)  as inst_1d,
  sum(fin_inv_net)   filter (where ago<60) as fin_inv_3m,
  sum(fin_inv_net)   filter (where ago<20) as fin_inv_1m,
  sum(fin_inv_net)   filter (where ago<10) as fin_inv_2w,
  sum(fin_inv_net)   filter (where ago<5)  as fin_inv_1w,
  sum(fin_inv_net)   filter (where ago<1)  as fin_inv_1d,
  sum(inv_trust_net) filter (where ago<60) as inv_trust_3m,
  sum(inv_trust_net) filter (where ago<20) as inv_trust_1m,
  sum(inv_trust_net) filter (where ago<10) as inv_trust_2w,
  sum(inv_trust_net) filter (where ago<5)  as inv_trust_1w,
  sum(inv_trust_net) filter (where ago<1)  as inv_trust_1d,
  sum(pension_net)   filter (where ago<60) as pension_3m,
  sum(pension_net)   filter (where ago<20) as pension_1m,
  sum(pension_net)   filter (where ago<10) as pension_2w,
  sum(pension_net)   filter (where ago<5)  as pension_1w,
  sum(pension_net)   filter (where ago<1)  as pension_1d,
  sum(pe_net)        filter (where ago<60) as pe_3m,
  sum(pe_net)        filter (where ago<20) as pe_1m,
  sum(pe_net)        filter (where ago<10) as pe_2w,
  sum(pe_net)        filter (where ago<5)  as pe_1w,
  sum(pe_net)        filter (where ago<1)  as pe_1d
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
  where d.ago < 60
)
select code,
  sum(foreign_net)   filter (where ago<60) as foreign_3m,
  sum(foreign_net)   filter (where ago<20) as foreign_1m,
  sum(foreign_net)   filter (where ago<10) as foreign_2w,
  sum(foreign_net)   filter (where ago<5)  as foreign_1w,
  sum(foreign_net)   filter (where ago<1)  as foreign_1d,
  sum(inst_net)      filter (where ago<60) as inst_3m,
  sum(inst_net)      filter (where ago<20) as inst_1m,
  sum(inst_net)      filter (where ago<10) as inst_2w,
  sum(inst_net)      filter (where ago<5)  as inst_1w,
  sum(inst_net)      filter (where ago<1)  as inst_1d,
  sum(fin_inv_net)   filter (where ago<60) as fin_inv_3m,
  sum(fin_inv_net)   filter (where ago<20) as fin_inv_1m,
  sum(fin_inv_net)   filter (where ago<10) as fin_inv_2w,
  sum(fin_inv_net)   filter (where ago<5)  as fin_inv_1w,
  sum(fin_inv_net)   filter (where ago<1)  as fin_inv_1d,
  sum(inv_trust_net) filter (where ago<60) as inv_trust_3m,
  sum(inv_trust_net) filter (where ago<20) as inv_trust_1m,
  sum(inv_trust_net) filter (where ago<10) as inv_trust_2w,
  sum(inv_trust_net) filter (where ago<5)  as inv_trust_1w,
  sum(inv_trust_net) filter (where ago<1)  as inv_trust_1d,
  sum(pension_net)   filter (where ago<60) as pension_3m,
  sum(pension_net)   filter (where ago<20) as pension_1m,
  sum(pension_net)   filter (where ago<10) as pension_2w,
  sum(pension_net)   filter (where ago<5)  as pension_1w,
  sum(pension_net)   filter (where ago<1)  as pension_1d,
  sum(pe_net)        filter (where ago<60) as pe_3m,
  sum(pe_net)        filter (where ago<20) as pe_1m,
  sum(pe_net)        filter (where ago<10) as pe_2w,
  sum(pe_net)        filter (where ago<5)  as pe_1w,
  sum(pe_net)        filter (where ago<1)  as pe_1d
from f
group by code;

create view v_stock_flow_ranked
with (security_invoker = true) as
with latest as (select max(trade_date) as d from daily_price)
select fp.*, s.name, s.sector_krx as sector, p.close, p.change_pct, p.market_cap
from v_stock_flow_periods fp
join daily_price p on p.code = fp.code
join stocks s on s.code = fp.code and s.security_type = 'STOCK'
cross join latest l
where p.trade_date = l.d and p.close > 0 and p.market_cap > 0;

do $$
begin
  grant select on v_market_flow_periods, v_stock_flow_periods, v_stock_flow_ranked to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
