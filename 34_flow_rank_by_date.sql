-- ============================================================================
-- STOCK RADAR · v_flow_rank_today를 "최신일 고정"에서 "날짜 지정 조회"로 변경
-- ============================================================================
-- 33_flow_rank_history.sql의 v_flow_rank_today는 뷰 안에서
--   join (select max(trade_date) from daily_price) ...
-- 로 항상 최신 거래일 행만 내려주도록 고정했습니다. 수급 동향(오늘 화면)만
-- 쓸 땐 괜찮았는데, 종목 후보 스크리너는 #fDate로 과거 거래일을 골라 조회할
-- 수 있어서 그 경우 순위 데이터가 안 나옵니다.
--
-- 그래서 뷰에서 날짜 고정을 빼고 전체 기간(code, trade_date)별 순위를 그대로
-- 노출합니다 — 화면에서 필요한 날짜만 ?trade_date=eq.YYYY-MM-DD로 걸러서
-- 쓰면 됩니다(v_screener 등 다른 뷰와 동일한 패턴). rank() 계산 자체는
-- 종목별 전체 기간을 훑어야 하므로 비용은 33과 동일합니다 — 날짜를 뷰
-- 안에서 거르나 밖에서 거르나 계산량은 같고, 어느 날짜를 볼지만 유연해집니다.
--
-- ⚠ 실행 순서: 33 이후
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_flow_rank_today cascade;
create view v_flow_rank_today
with (security_invoker = true) as
with base as (
  select code, trade_date,
         foreign_net, inst_net, fin_inv_net, inv_trust_net,
         pension_net, pe_net, individual_net, corp_other_net,
         coalesce(foreign_net,0) + coalesce(inst_net,0) as combo_net
  from daily_flow
)
select code, trade_date,
  rank() over (partition by code order by foreign_net     desc nulls last) as foreign_rank,
  rank() over (partition by code order by inst_net        desc nulls last) as inst_rank,
  rank() over (partition by code order by fin_inv_net      desc nulls last) as fin_inv_rank,
  rank() over (partition by code order by inv_trust_net    desc nulls last) as inv_trust_rank,
  rank() over (partition by code order by pension_net      desc nulls last) as pension_rank,
  rank() over (partition by code order by pe_net           desc nulls last) as pe_rank,
  rank() over (partition by code order by individual_net   desc nulls last) as individual_rank,
  rank() over (partition by code order by corp_other_net   desc nulls last) as corp_other_rank,
  rank() over (partition by code order by combo_net        desc nulls last) as combo_rank,
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
  '수급주체별 순매수 대금이 같은 종목의 DB 보유 전체 기간(2025-09-01~) 중 몇 위인지(rank=1이 역대 최대). 특정 날짜만 보려면 ?trade_date=eq.YYYY-MM-DD로 필터링(다른 웹 조회용 뷰와 동일 패턴). total은 그 종목에 해당 주체 데이터가 있는 거래일 수(NULL 제외)';

do $$
begin
  grant select on v_flow_rank_today to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
-- 최신 거래일만 골라서 33과 동일한 결과가 나오는지
select code, trade_date, foreign_rank, foreign_total, individual_rank, individual_total
from v_flow_rank_today
where trade_date = (select max(trade_date) from daily_price)
order by foreign_rank asc
limit 5;
