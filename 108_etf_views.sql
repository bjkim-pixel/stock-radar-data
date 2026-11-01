-- ETF를 종목후보/종목상세에서 쓰기 위한 뷰 (v_screener / v_stock_chart / v_stock_summary 와 같은 컬럼명 사용)
-- etf_daily(일봉) + etf_master(이름/분야/시총)에서 즉석 계산 — 저장 용량 추가 없음.
-- 수급(외국인/기관 등)은 ETF에 없으므로 컬럼은 null 로 둠.
drop view if exists v_etf_summary cascade;
drop view if exists v_etf_chart cascade;
drop view if exists v_etf_screener cascade;
drop view if exists v_etf_base cascade;

create view v_etf_base with (security_invoker = true) as
with d as (
  select e.code, e.trade_date, e.open, e.high, e.low, e.close, e.volume, e.amount,
         lag(e.close, 1)  over w as c1,
         lag(e.close, 5)  over w as c5,
         lag(e.close, 20) over w as c20,
         avg(e.close) over (w rows between 4 preceding and current row)   as m5,
         avg(e.close) over (w rows between 19 preceding and current row)  as m20,
         avg(e.close) over (w rows between 59 preceding and current row)  as m60,
         avg(e.close) over (w rows between 119 preceding and current row) as m120,
         count(*) over (w rows between 119 preceding and current row)     as n120,
         count(*) over (w rows between 59 preceding and current row)      as n60,
         count(*) over (w rows between 19 preceding and current row)      as n20,
         count(*) over (w rows between 4 preceding and current row)       as n5,
         avg(e.volume) over (w rows between 20 preceding and 1 preceding) as v20prev,
         max(e.close) over (w rows between unbounded preceding and current row) as hi_all,
         max(e.close) over (w rows between 59 preceding and current row)        as hi_60
  from etf_daily e
  window w as (partition by e.code order by e.trade_date)
),
mk as (   -- 주식 유니버스 평균 수익률(개별RS 기준과 동일 개념)
  select trade_date,
         avg(close / nullif(c5, 0) - 1) * 100  as mk5,
         avg(close / nullif(c20, 0) - 1) * 100 as mk20
  from (select trade_date, close,
               lag(close, 5)  over (partition by code order by trade_date) as c5,
               lag(close, 20) over (partition by code order by trade_date) as c20
        from daily_price where trade_date >= date '2025-08-01') x
  group by trade_date
),
r as (
  select d.*, m.name, m.field, m.subfield, m.mcap_eok,
         (d.close / nullif(d.c5, 0)  - 1) * 100 - mk.mk5  as rs5,
         (d.close / nullif(d.c20, 0) - 1) * 100 - mk.mk20 as rs20,
         min(d.trade_date) over (partition by d.code, d.hi_all) as hi_date
  from d join etf_master m on m.code = d.code
  left join mk on mk.trade_date = d.trade_date
  where d.close > 0
)
select r.trade_date, 'ETF ' || coalesce(r.subfield, r.field, '') as sector, r.code, r.name,
       'ETF'::text as market, r.field as etf_field,
       r.close, r.open, r.high, r.low, r.volume,
       round((r.close / nullif(r.c1, 0) - 1) * 100, 2) as change_pct,
       r.amount as trade_amount,
       (r.mcap_eok * 100000000)::numeric as market_cap,
       null::numeric as weight_per_share,
       case when r.mcap_eok > 0 then round(r.amount::numeric / (r.mcap_eok * 100000000) * 100, 3) end as amt_cap_pct,
       round(r.volume / nullif(r.v20prev, 0) * 100, 1) as vol_ratio20_prev,
       (r.close >= r.hi_60 and r.n60 >= 60) as is_new_high,
       (r.close >= r.hi_all and r.n120 >= 20) as is_new_high_all,
       (r.close / nullif(r.hi_all, 0) - 1) * 100 >= -5 as near_high,
       round((r.close / nullif(r.hi_all, 0) - 1) * 100, 2) as pct_from_high,
       r.hi_all as high_period,
       r.hi_date as high_period_date,
       case when r.n5   >= 5   then round(r.m5, 2)   end as ma5,
       case when r.n20  >= 20  then round(r.m20, 2)  end as ma20,
       case when r.n60  >= 60  then round(r.m60, 2)  end as ma60,
       case when r.n120 >= 120 then round(r.m120, 2) end as ma120,
       round(r.rs5::numeric, 2)  as rs5_vs_mkt,
       round(r.rs20::numeric, 2) as rs20_vs_mkt,
       round((percent_rank() over (partition by r.trade_date order by r.rs5)  * 100)::numeric, 0) as rs5_pctl,
       round((percent_rank() over (partition by r.trade_date order by r.rs20) * 100)::numeric, 0) as rs20_pctl,
       case when r.high > r.low then round((r.close - r.low)::numeric / (r.high - r.low) * 100, 1) end as close_pos_pct
from r;

create view v_etf_screener with (security_invoker = true) as
select b.*,
       null::numeric as above_high_supply_eok, null::bigint as consec_both_buy,
       null::numeric as foreign_net, null::numeric as inst_net, null::numeric as nonpersonal_net,
       null::numeric as individual_net, null::int as sector_rs_rank
from v_etf_base b;

create view v_etf_chart with (security_invoker = true) as
select b.code, b.trade_date, b.close, b.open, b.high, b.low, b.volume, b.change_pct,
       b.ma5, b.ma20, b.ma60, b.ma120
from v_etf_base b;

create view v_etf_summary with (security_invoker = true) as
select b.* from v_etf_base b
where b.trade_date = (select max(trade_date) from etf_daily);

do $$ begin
  grant select on v_etf_base, v_etf_screener, v_etf_chart, v_etf_summary to anon, authenticated;
exception when undefined_object then null; end $$;
select count(*) as etf_rows_latest from v_etf_screener where trade_date = (select max(trade_date) from etf_daily);
