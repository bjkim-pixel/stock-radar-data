-- 종목별 "역대 기록일" 뷰 (전체 이력 기준)
--  v_wt_record  : 무게/주식수 1위일(전체 최대) · 2위일(1위일 '이후' 날짜 중 최대 — 종목상세 규칙과 동일)
--  v_flow_record: 주체별 일 순매수 금액이 컸던 1·2위일(전체 이력, 양수만)
create or replace view v_wt_record as
with r as (
  select code, trade_date, weight_per_share as w, close, change_pct, trade_amount, volume
  from daily_price where weight_per_share > 0),
t1 as (select distinct on (code) code, trade_date as d1, w, close, change_pct, trade_amount, volume
       from r order by code, w desc),
t2 as (select distinct on (r.code) r.code, r.trade_date, r.w, r.close, r.change_pct, r.trade_amount, r.volume
       from r join t1 on r.code = t1.code and r.trade_date > t1.d1 order by r.code, r.w desc)
select code, 1 as rk, d1 as trade_date, w, close, change_pct, trade_amount, volume from t1
union all
select code, 2, trade_date, w, close, change_pct, trade_amount, volume from t2;

create or replace view v_flow_record as
select * from (
  select v.subj, f.code, f.trade_date, v.net,
         row_number() over (partition by v.subj, f.code order by v.net desc) as rk
  from daily_flow f
  cross join lateral (values ('foreign', f.foreign_net), ('inst', f.inst_net), ('combo', f.smart_net),
       ('fin_inv', f.fin_inv_net), ('inv_trust', f.inv_trust_net), ('pension', f.pension_net), ('pe', f.pe_net)) v(subj, net)
  where v.net > 0) x
where rk <= 2;
grant select on v_wt_record, v_flow_record to anon, authenticated;
