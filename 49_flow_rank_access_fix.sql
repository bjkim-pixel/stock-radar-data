-- ============================================================================
-- STOCK RADAR · v_flow_rank_today — security_invoker 제거 (역대순위 복구)
-- ============================================================================
-- 원인: v_flow_rank_today가 security_invoker=true로 정의돼 있어
--   PostgREST(anon 키)로 호출 시 anon 롤이 daily_flow에 대한
--   SELECT 권한이 없어 빈 결과를 반환 → 역대순위가 표시되지 않음.
--   v_screener 등 다른 뷰는 security_invoker 없이 뷰 소유자 권한으로
--   실행하기 때문에 금액은 정상이지만 순위만 사라지는 현상.
--
-- 조치: security_invoker = true 제거 (뷰 소유자 권한으로 실행 → daily_flow 접근 가능)
--       뷰 내용 자체는 40_flow_rank_limit.sql과 동일하게 유지.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_flow_rank_today cascade;

create view v_flow_rank_today as
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
  '수급주체별 순매수 대금이 최근 260 거래일(약 1년) 중 몇 위인지(rank=1이 최대). 특정 날짜만 보려면 ?trade_date=eq.YYYY-MM-DD 필터 사용. security_invoker 제거 — 뷰 소유자 권한으로 daily_flow 접근(49번 수정).';

do $$
begin
  grant select on v_flow_rank_today to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
