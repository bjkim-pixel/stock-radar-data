-- ============================================================================
-- STOCK RADAR · SECURITY DEFINER 뷰 4개 수정
-- ============================================================================
-- Advisor 경고: v_program_trade_recent, v_us_market_latest, v_flow_rank_today,
-- v_signals_latest가 security_invoker 없이(=뷰 소유자 권한으로 실행) 정의돼
-- 있었습니다. v_flow_rank_today는 예전에(49_flow_rank_access_fix.sql) anon이
-- daily_flow에 SELECT가 없어서 일부러 이렇게 만들었던 건데, 78번 마이그레이션
-- 으로 모든 테이블에 anon용 RLS 읽기 정책이 생겨서 이제 security_invoker=true
-- 로 켜도 그 문제가 재발하지 않습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

-- ── v_flow_rank_today ───────────────────────────────────────────────────────
drop view if exists v_flow_rank_today cascade;
create view v_flow_rank_today
with (security_invoker = true) as
with recent_dates as (
  select trade_date
  from (
    select distinct trade_date
    from daily_price
    order by trade_date desc
    limit 260
  ) t
),
base as (
  select fl.code, fl.trade_date,
         fl.foreign_net, fl.inst_net, fl.fin_inv_net, fl.inv_trust_net,
         fl.pension_net, fl.pe_net, fl.individual_net, fl.corp_other_net,
         coalesce(fl.foreign_net,0) + coalesce(fl.inst_net,0) as combo_net
  from daily_flow fl
  join recent_dates rd on rd.trade_date = fl.trade_date
)
select code, trade_date,
  rank() over (partition by code order by foreign_net     desc nulls last) as foreign_rank,
  rank() over (partition by code order by inst_net        desc nulls last) as inst_rank,
  rank() over (partition by code order by fin_inv_net     desc nulls last) as fin_inv_rank,
  rank() over (partition by code order by inv_trust_net   desc nulls last) as inv_trust_rank,
  rank() over (partition by code order by pension_net     desc nulls last) as pension_rank,
  rank() over (partition by code order by pe_net          desc nulls last) as pe_rank,
  rank() over (partition by code order by individual_net  desc nulls last) as individual_rank,
  rank() over (partition by code order by corp_other_net  desc nulls last) as corp_other_rank,
  rank() over (partition by code order by combo_net       desc nulls last) as combo_rank,
  count(foreign_net)     over (partition by code) as foreign_total,
  count(inst_net)        over (partition by code) as inst_total,
  count(fin_inv_net)     over (partition by code) as fin_inv_total,
  count(inv_trust_net)   over (partition by code) as inv_trust_total,
  count(pension_net)     over (partition by code) as pension_total,
  count(pe_net)          over (partition by code) as pe_total,
  count(individual_net)  over (partition by code) as individual_total,
  count(corp_other_net)  over (partition by code) as corp_other_total,
  count(combo_net)       over (partition by code) as combo_total
from base;

comment on view v_flow_rank_today is
  '수급주체별 순매수 대금이 최근 260 거래일(약 1년) 중 몇 위인지(rank=1이 최대). 특정 날짜만 보려면 ?trade_date=eq.YYYY-MM-DD 필터 사용. 2026-09-26: 78번으로 daily_flow에 anon RLS 읽기정책이 생겨 security_invoker=true 복구.';

grant select on v_flow_rank_today to anon, authenticated;

-- ── v_us_market_latest ──────────────────────────────────────────────────────
drop view if exists v_us_market_latest cascade;
create view v_us_market_latest
with (security_invoker = true) as
with latest as (
  select max(trade_date) as dt from us_market_daily
)
select u.symbol, u.close, u.change_pct, u.trade_date
from us_market_daily u
cross join latest l
where u.trade_date = l.dt;

grant select on v_us_market_latest to anon, authenticated;

-- ── v_program_trade_recent ──────────────────────────────────────────────────
drop view if exists v_program_trade_recent cascade;
create view v_program_trade_recent
with (security_invoker = true) as
with agg as (
  select trade_date,
    sum(arb_net_amount)    as arb_net_amount,
    sum(nonarb_net_amount) as nonarb_net_amount
  from program_trade_daily
  group by trade_date
),
ranked as (
  select *, row_number() over (order by trade_date desc) as rn from agg
)
select trade_date, arb_net_amount, nonarb_net_amount
from ranked
where rn <= 12
order by trade_date asc;

grant select on v_program_trade_recent to anon, authenticated;

-- ── v_signals_latest ─────────────────────────────────────────────────────────
drop view if exists v_signals_latest cascade;
create view v_signals_latest
with (security_invoker = true) as
select
  sg.id, sg.trade_date, sg.code, s.name, s.market, s.sector_krx,
  sg.signal_type, sg.grade, sg.score, sg.reason_text, sg.reason,
  p.close, p.change_pct, p.trade_amount, p.market_cap,
  f.foreign_net, f.inst_net,
  m.amt_ratio20, m.high_label, m.smart_cum5, m.smart_cum5_cap_pct, m.flow_lead
from signals sg
join      stocks        s on s.code = sg.code
left join daily_price   p on p.trade_date = sg.trade_date and p.code = sg.code
left join daily_flow    f on f.trade_date = sg.trade_date and f.code = sg.code
left join daily_metrics m on m.trade_date = sg.trade_date and m.code = sg.code;

grant select on v_signals_latest to anon, authenticated;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select viewname,
       (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname=v.viewname
          and c.reloptions is not null
          and 'security_invoker=true' = any(c.reloptions)) as has_security_invoker
from pg_views v
where schemaname='public'
  and viewname in ('v_flow_rank_today','v_us_market_latest',
                    'v_program_trade_recent','v_signals_latest');
