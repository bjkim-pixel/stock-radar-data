-- 종목후보 수급주체 "역대순위" 고속화: v_flow_rank_today 뷰는 날짜 필터를 윈도우 계산 앞에 적용하지 못해
-- REST 호출이 ~2.7초(anon 타임아웃 근처)라 가끔 실패→순위 괄호가 사라짐. 같은 값을 "요청 날짜 행만" 계산하는 함수로 제공.
-- 의미는 뷰와 동일: 최근 260거래일(daily_price 기준) 중 그 종목·주체의 순매수 대금 순위(1=최대, null은 맨 뒤), total=null 아닌 일수.
create or replace function flow_rank_on(d date)
returns table(code text, trade_date date,
  foreign_rank bigint, inst_rank bigint, fin_inv_rank bigint, inv_trust_rank bigint, pension_rank bigint, pe_rank bigint,
  individual_rank bigint, corp_other_rank bigint, combo_rank bigint,
  foreign_total bigint, inst_total bigint, fin_inv_total bigint, inv_trust_total bigint, pension_total bigint, pe_total bigint,
  individual_total bigint, corp_other_total bigint, combo_total bigint)
language sql stable security invoker set search_path = public as $$
  with rd as (select distinct dp.trade_date from daily_price dp order by dp.trade_date desc limit 260),
  h as (select fl.code, fl.foreign_net,
         fl.inst_net,
         fl.fin_inv_net,
         fl.inv_trust_net,
         fl.pension_net,
         fl.pe_net,
         fl.individual_net,
         fl.corp_other_net,
               coalesce(fl.foreign_net,0) + coalesce(fl.inst_net,0) as combo_net
        from daily_flow fl join rd on rd.trade_date = fl.trade_date),
  t as (select fl.code, fl.trade_date, fl.foreign_net,
         fl.inst_net,
         fl.fin_inv_net,
         fl.inv_trust_net,
         fl.pension_net,
         fl.pe_net,
         fl.individual_net,
         fl.corp_other_net,
               coalesce(fl.foreign_net,0) + coalesce(fl.inst_net,0) as combo_net
        from daily_flow fl where fl.trade_date = d)
  select t.code, t.trade_date,
       1 + case when t.foreign_net is null then count(h.foreign_net) else count(*) filter (where h.foreign_net > t.foreign_net) end as foreign_rank,
       1 + case when t.inst_net is null then count(h.inst_net) else count(*) filter (where h.inst_net > t.inst_net) end as inst_rank,
       1 + case when t.fin_inv_net is null then count(h.fin_inv_net) else count(*) filter (where h.fin_inv_net > t.fin_inv_net) end as fin_inv_rank,
       1 + case when t.inv_trust_net is null then count(h.inv_trust_net) else count(*) filter (where h.inv_trust_net > t.inv_trust_net) end as inv_trust_rank,
       1 + case when t.pension_net is null then count(h.pension_net) else count(*) filter (where h.pension_net > t.pension_net) end as pension_rank,
       1 + case when t.pe_net is null then count(h.pe_net) else count(*) filter (where h.pe_net > t.pe_net) end as pe_rank,
       1 + case when t.individual_net is null then count(h.individual_net) else count(*) filter (where h.individual_net > t.individual_net) end as individual_rank,
       1 + case when t.corp_other_net is null then count(h.corp_other_net) else count(*) filter (where h.corp_other_net > t.corp_other_net) end as corp_other_rank,
       1 + case when t.combo_net is null then count(h.combo_net) else count(*) filter (where h.combo_net > t.combo_net) end as combo_rank,
       count(h.foreign_net) as foreign_total,
       count(h.inst_net) as inst_total,
       count(h.fin_inv_net) as fin_inv_total,
       count(h.inv_trust_net) as inv_trust_total,
       count(h.pension_net) as pension_total,
       count(h.pe_net) as pe_total,
       count(h.individual_net) as individual_total,
       count(h.corp_other_net) as corp_other_total,
       count(h.combo_net) as combo_total
  from t join h on h.code = t.code
  group by t.code, t.trade_date, t.foreign_net, t.inst_net, t.fin_inv_net, t.inv_trust_net, t.pension_net, t.pe_net, t.individual_net, t.corp_other_net, t.combo_net
$$;
grant execute on function flow_rank_on(date) to anon, authenticated;
