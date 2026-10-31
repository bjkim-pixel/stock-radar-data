-- ============================================================================
-- v_kospi_flow_daily : KOSPI 개별 종목(STOCK) 합산 "지수를 한 종목처럼" 보기 위한 일별 집계
--   수급주체별 순매수 합계 + 시가총액·거래량·거래대금 합계 (오늘의 종목 > KOSPI 카드가 사용)
-- 여러 번 실행해도 안전.
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
       sum(p.market_cap)     as market_cap,
       sum(p.volume)         as volume,
       sum(p.trade_amount)   as trade_amount,
       count(*)              as n_stocks
from daily_flow f
join stocks s on s.code = f.code
join daily_price p on p.trade_date = f.trade_date and p.code = f.code
where s.market = 'KOSPI' and s.security_type = 'STOCK'
group by f.trade_date
order by f.trade_date;
grant select on v_kospi_flow_daily to anon, authenticated;
