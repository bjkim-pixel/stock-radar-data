-- ============================================================================
-- v_kospi_flow_daily : KOSPI 개별 종목(STOCK) 수급주체별 일별 순매수 합계 (최근 260거래일)
-- 오늘의 종목 > KOSPI 카드(스마트머니·주체별 순매수 표)가 사용. 여러 번 실행해도 안전.
-- ============================================================================
drop view if exists v_kospi_flow_daily cascade;
create view v_kospi_flow_daily
with (security_invoker = true) as
select f.trade_date,
       sum(f.foreign_net)    as foreign_net,
       sum(f.inst_net)       as inst_net,
       sum(f.fin_inv_net)    as fin_inv_net,
       sum(f.inv_trust_net)  as inv_trust_net,
       sum(f.pension_net)    as pension_net,
       sum(f.pe_net)         as pe_net,
       sum(f.corp_other_net) as corp_other_net,
       sum(f.individual_net) as individual_net,
       count(*)              as n_stocks
from daily_flow f
join stocks s on s.code = f.code
where s.market = 'KOSPI' and s.security_type = 'STOCK'
  and f.trade_date >= (select min(d) from (select distinct trade_date as d from daily_flow order by 1 desc limit 260) t)
group by f.trade_date
order by f.trade_date;
grant select on v_kospi_flow_daily to anon, authenticated;
