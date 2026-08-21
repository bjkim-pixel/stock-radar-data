-- ============================================================================
-- STOCK RADAR · 수급주체별 "당일 순매수 대금"의 해당 종목 자체 역대 순위
-- ============================================================================
-- 지난 커밋에서 만든 순위는 "오늘 하루, 전체 종목 중 몇 위"(횡단면 순위)였는데,
-- 실제로 원하신 건 다릅니다:
--
--   "8월 20일 금융투자가 삼성전자를 1천억 순매수했다면, 그 1천억이 DB에 있는
--    기간(2025-09-01~현재) 동안 금융투자가 '삼성전자를' 순매수한 날들의
--    금액 분포 중 몇 위인가"
--
-- 즉 같은 (종목, 수급주체) 조합의 역대 매일 순매수 금액을 줄세워서, 오늘이
-- 그중 몇 등인지를 구하는 종단면(시계열) 순위입니다. 종목마다·주체마다 완전히
-- 다른 순위표가 나옵니다.
--
-- daily_flow 전체 기간(2025-09-01~) × 종목별로 rank() 윈도우 함수를 돌려서
-- 미리 계산해두고, 화면에서는 최신 거래일 행만 골라 쓰면 됩니다 — 매번 종목별로
-- 따로 쿼리하지 않아도 되도록 뷰 하나로 처리합니다.
--
-- ⚠ 실행 순서: 32 이후. corp_other_net이 아직 역산값이어도(32만 실행하고
--   04_backfill.py 재백필 전이어도) 동작은 합니다 — 다만 기타법인 순위는
--   재백필 전까지는 역산값 기준이 됩니다.
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
),
ranked as (
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
  from base
)
select r.*
from ranked r
join (select max(trade_date) as d from daily_price) l on r.trade_date = l.d;

comment on view v_flow_rank_today is
  '수급주체별 "당일 순매수 대금"이 같은 종목의 DB 보유 전체 기간(2025-09-01~) 중 몇 위인지. rank=1이 그 종목·그 주체 역대 최대 순매수일. total은 그 종목에 해당 주체 데이터가 있는 거래일 수(NULL 제외)';

do $$
begin
  grant select on v_flow_rank_today to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select code, trade_date, foreign_rank, foreign_total, individual_rank, individual_total
from v_flow_rank_today
order by foreign_rank asc
limit 5;
