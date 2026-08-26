-- ============================================================================
-- STOCK RADAR · v_flow_rank_today — timeout 해결 (최근 260 거래일 제한)
-- ============================================================================
-- 문제: daily_flow 전체(모든 날짜 × 전 종목)에 window function 9개를 돌리면
--       데이터 누적 시 statement timeout(57014) 발생.
--
-- 해결: base CTE를 최근 260 거래일로 제한.
--   • daily_price의 distinct trade_date 기준으로 최신 260개만 사용
--   • 역대순위의 의미가 "최근 약 1년 중 몇 위"로 바뀌지만 실용상 동일
--   • 계산량: 전체→(종목수×260행)으로 고정 상한
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 (34번 SQL 재실행)
-- ============================================================================

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
  '수급주체별 순매수 대금이 최근 260 거래일(약 1년) 중 몇 위인지(rank=1이 최대). 특정 날짜만 보려면 ?trade_date=eq.YYYY-MM-DD 필터 사용.';

do $$
begin
  grant select on v_flow_rank_today to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
