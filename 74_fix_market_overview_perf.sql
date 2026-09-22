-- ============================================================================
-- STOCK RADAR · v_market_overview 성능 수정 — 날짜 하한 필터 누락 버그
-- ============================================================================
-- 31_flow_subj_individual_corp.sql에서 v_market_overview를 다시 만들 때,
-- 바로 아래 v_sector_flow_daily에는 넣은 `where trade_date >= '2025-09-01'`
-- 필터를 v_market_overview에는 빠뜨렸습니다. 그 결과 daily_price 전체 이력을
-- 매 요청마다 훑어서 누적합(cum) window 함수를 계산하게 됐고, 날짜·종목이
-- 늘어날수록 점점 느려지다가 2026-09-23 statement timeout으로 "시장 매크로"
-- 탭 전체가 500 에러로 죽는 장애가 발생했습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_market_overview cascade;
create view v_market_overview
with (security_invoker = true) as
with d as (
  select p.trade_date,
         sum(p.trade_amount)                         as total_amount,
         sum(coalesce(f.foreign_net, 0))             as foreign_net,
         sum(coalesce(f.inst_net, 0))                as inst_net,
         sum(coalesce(f.individual_net, 0))          as individual_net,
         sum(coalesce(f.corp_other_net, 0))          as corp_other_net,
         count(*)                                    as stock_count
  from daily_price p
  join stocks s        on s.code = p.code and s.security_type = 'STOCK'
  left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
  where p.close > 0
    and p.trade_date >= '2025-09-01'   -- 2026-09-23: 누락됐던 날짜 하한 필터 추가
  group by p.trade_date
)
select trade_date,
       total_amount,
       foreign_net,
       inst_net,
       individual_net,
       corp_other_net,
       stock_count,
       sum(foreign_net)     over w as foreign_cum,
       sum(inst_net)        over w as inst_cum,
       sum(individual_net)  over w as individual_cum,
       sum(corp_other_net)  over w as corp_other_cum,
       avg(total_amount)    over (order by trade_date rows between 19 preceding and current row)
                                  as amt_ma20
from d
window w as (order by trade_date rows unbounded preceding);

do $$
begin
  grant select on v_market_overview to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select count(*) as rows, min(trade_date), max(trade_date) from v_market_overview;
