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

-- 속도: 뷰는 조회 때마다 3초대라, 결과를 표로 저장해 두고 장마감 수집 뒤 갱신(refresh_record_days)
create table if not exists record_wt (
  code text not null, rk smallint not null, trade_date date, w numeric, close bigint, change_pct numeric, trade_amount bigint, volume bigint,
  primary key (code, rk));
create table if not exists record_flow (
  subj text not null, code text not null, rk smallint not null, trade_date date, net bigint,
  primary key (subj, code, rk));
create index if not exists idx_record_wt_d on record_wt (trade_date);
create index if not exists idx_record_flow_d on record_flow (subj, trade_date);
alter table record_wt enable row level security; alter table record_flow enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='record_wt' and policyname='public read') then create policy "public read" on record_wt for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename='record_flow' and policyname='public read') then create policy "public read" on record_flow for select using (true); end if;
end $$;
grant select on record_wt, record_flow to anon, authenticated;
create or replace function refresh_record_days() returns void language plpgsql as $f$
begin
  delete from record_wt;   insert into record_wt select code, rk, trade_date, w, close, change_pct, trade_amount, volume from v_wt_record;
  delete from record_flow; insert into record_flow select subj, code, rk, trade_date, net from v_flow_record;
end $f$;
select refresh_record_days();
