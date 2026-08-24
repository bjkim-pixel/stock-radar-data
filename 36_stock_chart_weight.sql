-- ============================================================================
-- STOCK RADAR · v_stock_chart에 weight_per_share 컬럼 추가
-- ============================================================================
-- 종목 상세 차트에 "무게/주식수" 막대 그래프를 표시하려면
-- v_stock_chart 뷰에 weight_per_share 컬럼이 있어야 합니다.
-- daily_price 테이블에는 이미 있는 컬럼 (등락률 × 거래량 / 상장주식수)이며
-- 뷰 SELECT 목록에서만 빠졌습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_stock_chart cascade;

create view v_stock_chart
with (security_invoker = true) as
select p.code, p.trade_date, p.close, p.high, p.low, p.volume, p.trade_amount,
       p.change_pct, p.market_cap,
       p.weight_per_share,
       -- 이동평균은 daily_metrics를 쓰지 않고 여기서 직접 계산합니다.
       -- daily_metrics는 용량 때문에 2026-01-01 이후만 보관하므로, 그대로 쓰면
       -- 차트 앞부분의 이평선이 통째로 비어 보입니다.
       case when count(*) over w5   >= 5   then round(avg(p.close) over w5,   2) end as ma5,
       case when count(*) over w10  >= 10  then round(avg(p.close) over w10,  2) end as ma10,
       case when count(*) over w20  >= 20  then round(avg(p.close) over w20,  2) end as ma20,
       case when count(*) over w60  >= 60  then round(avg(p.close) over w60,  2) end as ma60,
       case when count(*) over w120 >= 120 then round(avg(p.close) over w120, 2) end as ma120,
       -- 주체별 누적 순매수 (상장 이후 전 기간 누적)
       sum(coalesce(f.foreign_net,0))    over w as foreign_cum,
       sum(coalesce(f.inst_net,0))       over w as inst_cum,
       sum(coalesce(f.individual_net,0)) over w as individual_cum,
       sum(coalesce(f.fin_inv_net,0))    over w as fin_inv_cum,
       sum(coalesce(f.inv_trust_net,0))  over w as inv_trust_cum,
       sum(coalesce(f.pension_net,0))    over w as pension_cum,
       sum(coalesce(f.pe_net,0))         over w as pe_cum,
       sum(coalesce(f.corp_other_net,0)) over w as corp_other_cum,
       coalesce(f.foreign_net,0)    as foreign_net,
       coalesce(f.inst_net,0)       as inst_net,
       coalesce(f.individual_net,0) as individual_net
from daily_price p
left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
join stocks s on s.code = p.code and s.security_type = 'STOCK'
where p.close > 0
window
  w    as (partition by p.code order by p.trade_date rows unbounded preceding),
  w5   as (partition by p.code order by p.trade_date rows between   4 preceding and current row),
  w10  as (partition by p.code order by p.trade_date rows between   9 preceding and current row),
  w20  as (partition by p.code order by p.trade_date rows between  19 preceding and current row),
  w60  as (partition by p.code order by p.trade_date rows between  59 preceding and current row),
  w120 as (partition by p.code order by p.trade_date rows between 119 preceding and current row);

do $$
begin
  grant select on v_stock_chart to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
