-- ============================================================================
-- STOCK RADAR · 수급 기간 조회 "1년" → "6개월"로 재통일
-- ============================================================================
-- 배경: 35_flow_periods_6m.sql에서 한 번 1년→6개월로 바꿨었는데, 이후
-- 38/39번(individual·corp_other 컬럼 추가)과 43번(v_stock_flow_periods
-- 되돌림)을 거치면서 어느 순간 두 뷰 모두 다시 "_1y"(250거래일) 기준으로
-- 돌아가 있었습니다. 그런데 화면(web/index.html)의 "수급 동향" 표와 "종목별
-- 수급 랭킹" 기간 선택기는 여전히 "6개월"이라는 라벨/키를 쓰고 있어서,
-- DB에 없는 `_6m` 컬럼을 요청 → 조용히 0으로 표시되는 문제가 있었습니다
-- (사용자가 발견한 "수급 동향 6개월 행이 전부 0" 버그).
--
-- 이번엔 반대 방향으로 통일합니다: 화면(시장 전체 수급 동향 / 종목별 수급
-- 랭킹 / 종목상세 수급표) 전부 "6개월"로 맞추고, DB 뷰도 `_1y`(ago<250) 대신
-- `_6m`(ago<125, 6개월 ≈ 125거래일)으로 재생성합니다. individual/corp_other/
-- program 등 39·42번에서 추가된 컬럼들도 전부 포함해서 6개월판으로 다시
-- 만듭니다 — 로직(합산 방식)은 그대로, 기간 이름과 window만 바뀝니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_stock_flow_periods cascade;
drop view if exists v_market_flow_periods cascade;

-- ── v_market_flow_periods (시장 전체, 단일 행) ──────────────────────────────
create view v_market_flow_periods
with (security_invoker = true) as
with dates as (
  select trade_date, row_number() over (order by trade_date desc) - 1 as ago
  from (select distinct trade_date from daily_price) t
),
f as (
  select fl.*, d.ago
  from daily_flow fl
  join dates d on d.trade_date = fl.trade_date
  where d.ago < 125
)
select
  sum(foreign_net)     filter (where ago<125) as foreign_6m,
  sum(foreign_net)     filter (where ago<60)  as foreign_3m,
  sum(foreign_net)     filter (where ago<40)  as foreign_2m,
  sum(foreign_net)     filter (where ago<20)  as foreign_1m,
  sum(foreign_net)     filter (where ago<10)  as foreign_2w,
  sum(foreign_net)     filter (where ago<5)   as foreign_1w,
  sum(foreign_net)     filter (where ago<1)   as foreign_1d,
  sum(inst_net)        filter (where ago<125) as inst_6m,
  sum(inst_net)        filter (where ago<60)  as inst_3m,
  sum(inst_net)        filter (where ago<40)  as inst_2m,
  sum(inst_net)        filter (where ago<20)  as inst_1m,
  sum(inst_net)        filter (where ago<10)  as inst_2w,
  sum(inst_net)        filter (where ago<5)   as inst_1w,
  sum(inst_net)        filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)     filter (where ago<125) as fin_inv_6m,
  sum(fin_inv_net)     filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)     filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)     filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)     filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)     filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)     filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net)   filter (where ago<125) as inv_trust_6m,
  sum(inv_trust_net)   filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net)   filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net)   filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net)   filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net)   filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net)   filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)     filter (where ago<125) as pension_6m,
  sum(pension_net)     filter (where ago<60)  as pension_3m,
  sum(pension_net)     filter (where ago<40)  as pension_2m,
  sum(pension_net)     filter (where ago<20)  as pension_1m,
  sum(pension_net)     filter (where ago<10)  as pension_2w,
  sum(pension_net)     filter (where ago<5)   as pension_1w,
  sum(pension_net)     filter (where ago<1)   as pension_1d,
  sum(pe_net)          filter (where ago<125) as pe_6m,
  sum(pe_net)          filter (where ago<60)  as pe_3m,
  sum(pe_net)          filter (where ago<40)  as pe_2m,
  sum(pe_net)          filter (where ago<20)  as pe_1m,
  sum(pe_net)          filter (where ago<10)  as pe_2w,
  sum(pe_net)          filter (where ago<5)   as pe_1w,
  sum(pe_net)          filter (where ago<1)   as pe_1d,
  sum(individual_net)  filter (where ago<125) as individual_6m,
  sum(individual_net)  filter (where ago<60)  as individual_3m,
  sum(individual_net)  filter (where ago<40)  as individual_2m,
  sum(individual_net)  filter (where ago<20)  as individual_1m,
  sum(individual_net)  filter (where ago<10)  as individual_2w,
  sum(individual_net)  filter (where ago<5)   as individual_1w,
  sum(individual_net)  filter (where ago<1)   as individual_1d,
  sum(corp_other_net)  filter (where ago<125) as corp_other_6m,
  sum(corp_other_net)  filter (where ago<60)  as corp_other_3m,
  sum(corp_other_net)  filter (where ago<40)  as corp_other_2m,
  sum(corp_other_net)  filter (where ago<20)  as corp_other_1m,
  sum(corp_other_net)  filter (where ago<10)  as corp_other_2w,
  sum(corp_other_net)  filter (where ago<5)   as corp_other_1w,
  sum(corp_other_net)  filter (where ago<1)   as corp_other_1d
from f;

-- ── v_stock_flow_periods (종목별, code당 1행) ───────────────────────────────
create view v_stock_flow_periods
with (security_invoker = true) as
with dates as (
  select trade_date, row_number() over (order by trade_date desc) - 1 as ago
  from (select distinct trade_date from daily_price) t
),
f as (
  select fl.*, d.ago
  from daily_flow fl
  join dates d on d.trade_date = fl.trade_date
  where d.ago < 125
),
dp as (
  select p.*, d.ago
  from daily_program p
  join dates d on d.trade_date = p.trade_date
  where d.ago < 125
),
pg as (
  select code,
    sum(pgtr_net_amt) filter (where ago<125) as program_6m,
    sum(pgtr_net_amt) filter (where ago<60)  as program_3m,
    sum(pgtr_net_amt) filter (where ago<40)  as program_2m,
    sum(pgtr_net_amt) filter (where ago<20)  as program_1m,
    sum(pgtr_net_amt) filter (where ago<10)  as program_2w,
    sum(pgtr_net_amt) filter (where ago<5)   as program_1w,
    sum(pgtr_net_amt) filter (where ago<1)   as program_1d
  from dp
  group by code
),
base as (
  select code,
    sum(foreign_net)     filter (where ago<125) as foreign_6m,
    sum(foreign_net)     filter (where ago<60)  as foreign_3m,
    sum(foreign_net)     filter (where ago<40)  as foreign_2m,
    sum(foreign_net)     filter (where ago<20)  as foreign_1m,
    sum(foreign_net)     filter (where ago<10)  as foreign_2w,
    sum(foreign_net)     filter (where ago<5)   as foreign_1w,
    sum(foreign_net)     filter (where ago<1)   as foreign_1d,
    sum(inst_net)        filter (where ago<125) as inst_6m,
    sum(inst_net)        filter (where ago<60)  as inst_3m,
    sum(inst_net)        filter (where ago<40)  as inst_2m,
    sum(inst_net)        filter (where ago<20)  as inst_1m,
    sum(inst_net)        filter (where ago<10)  as inst_2w,
    sum(inst_net)        filter (where ago<5)   as inst_1w,
    sum(inst_net)        filter (where ago<1)   as inst_1d,
    sum(fin_inv_net)     filter (where ago<125) as fin_inv_6m,
    sum(fin_inv_net)     filter (where ago<60)  as fin_inv_3m,
    sum(fin_inv_net)     filter (where ago<40)  as fin_inv_2m,
    sum(fin_inv_net)     filter (where ago<20)  as fin_inv_1m,
    sum(fin_inv_net)     filter (where ago<10)  as fin_inv_2w,
    sum(fin_inv_net)     filter (where ago<5)   as fin_inv_1w,
    sum(fin_inv_net)     filter (where ago<1)   as fin_inv_1d,
    sum(inv_trust_net)   filter (where ago<125) as inv_trust_6m,
    sum(inv_trust_net)   filter (where ago<60)  as inv_trust_3m,
    sum(inv_trust_net)   filter (where ago<40)  as inv_trust_2m,
    sum(inv_trust_net)   filter (where ago<20)  as inv_trust_1m,
    sum(inv_trust_net)   filter (where ago<10)  as inv_trust_2w,
    sum(inv_trust_net)   filter (where ago<5)   as inv_trust_1w,
    sum(inv_trust_net)   filter (where ago<1)   as inv_trust_1d,
    sum(pension_net)     filter (where ago<125) as pension_6m,
    sum(pension_net)     filter (where ago<60)  as pension_3m,
    sum(pension_net)     filter (where ago<40)  as pension_2m,
    sum(pension_net)     filter (where ago<20)  as pension_1m,
    sum(pension_net)     filter (where ago<10)  as pension_2w,
    sum(pension_net)     filter (where ago<5)   as pension_1w,
    sum(pension_net)     filter (where ago<1)   as pension_1d,
    sum(pe_net)          filter (where ago<125) as pe_6m,
    sum(pe_net)          filter (where ago<60)  as pe_3m,
    sum(pe_net)          filter (where ago<40)  as pe_2m,
    sum(pe_net)          filter (where ago<20)  as pe_1m,
    sum(pe_net)          filter (where ago<10)  as pe_2w,
    sum(pe_net)          filter (where ago<5)   as pe_1w,
    sum(pe_net)          filter (where ago<1)   as pe_1d,
    sum(individual_net)  filter (where ago<125) as individual_6m,
    sum(individual_net)  filter (where ago<60)  as individual_3m,
    sum(individual_net)  filter (where ago<40)  as individual_2m,
    sum(individual_net)  filter (where ago<20)  as individual_1m,
    sum(individual_net)  filter (where ago<10)  as individual_2w,
    sum(individual_net)  filter (where ago<5)   as individual_1w,
    sum(individual_net)  filter (where ago<1)   as individual_1d,
    sum(corp_other_net)  filter (where ago<125) as corp_other_6m,
    sum(corp_other_net)  filter (where ago<60)  as corp_other_3m,
    sum(corp_other_net)  filter (where ago<40)  as corp_other_2m,
    sum(corp_other_net)  filter (where ago<20)  as corp_other_1m,
    sum(corp_other_net)  filter (where ago<10)  as corp_other_2w,
    sum(corp_other_net)  filter (where ago<5)   as corp_other_1w,
    sum(corp_other_net)  filter (where ago<1)   as corp_other_1d
  from f
  group by code
)
select base.*,
       pg.program_6m, pg.program_3m, pg.program_2m, pg.program_1m,
       pg.program_2w, pg.program_1w, pg.program_1d
from base
left join pg on pg.code = base.code;

-- ── anon(브라우저) 읽기 권한 재부여 ──────────────────────────────────────────
do $$
begin
  grant select on v_market_flow_periods, v_stock_flow_periods to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
