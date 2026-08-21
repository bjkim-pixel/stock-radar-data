-- ============================================================================
-- STOCK RADAR · 수급주체에 "개인" · "기타법인" 추가
-- ============================================================================
-- 개인(individual_net)은 이미 오래전부터 수집되어 daily_flow에 저장돼
-- 있습니다 — 이번에 새로 필요한 건 화면 노출뿐입니다.
--
-- 기타법인(corp_other_net)은 예전에 KIS에서 파싱은 했지만 "2026-08 용량
-- 정리" 때 컬럼 자체를 지웠습니다(03_daily_collect.py 주석 참고). 그런데
-- 한국 투자자 구분(개인/외국인/기관계/기타법인)은 넷을 더하면 종목-일자
-- 단위로 항상 정확히 0이 됩니다 — 이 항등식은 이미 이 코드베이스에서
-- nonpersonal_net = -individual_net 로 검증·신뢰되어 쓰이고 있습니다
-- (v_sector_flow, "비개인 = -(개인). 기타법인 컬럼이 없어도 총합이 0이라
-- 성립합니다" 주석 참고).
--
-- 즉 기타법인 = -(개인 + 외국인 + 기관계) 로 100% 정확히 역산되고, 이미
-- daily_flow에 쌓여 있는 전체 기간(2025-09-01~) 데이터로 그 자리에서
-- 계산됩니다. KIS API 재호출·백필 스크립트 전혀 필요 없습니다.
--
-- daily_flow.smart_net과 완전히 같은 패턴(generated always as ... stored)
-- 을 씁니다 — ALTER TABLE 실행 즉시 기존 행 전체가 채워지고, 앞으로
-- 03_daily_collect.py/04_backfill.py가 넣는 모든 신규 행도 자동으로
-- 계산됩니다(코드 수정 불필요).
--
-- 이 파일이 하는 일:
--   1) daily_flow.corp_other_net 컬럼 추가 (generated, 즉시 백필 완료)
--   2) v_market_flow_periods / v_stock_flow_periods (30_flow_periods_1y.sql)
--      에 individual_* · corp_other_* 기간별 합계 컬럼 추가
--   3) v_market_overview (STEP1)에 corp_other_net/corp_other_cum 추가
--      (individual_net/individual_cum은 이미 있음)
--   4) v_sector_flow_daily (STEP2, 28_sector_override.sql)에
--      corp_other_net/corp_other_cum 추가 (individual은 이미 있음)
--   5) v_stock_chart (종목상세)에 corp_other_net/corp_other_cum 추가
--      (individual_net/individual_cum은 이미 있음)
--   6) v_screener를 새 corp_other_net 컬럼을 그대로 쓰도록 재정의
--      (예전엔 뷰 안에서 직접 -(개인+외국인+기관) 을 계산했는데, 이제
--      daily_flow에 실제 컬럼이 생겼으니 그걸 그대로 select)
--
-- ⚠ 실행 순서: 반드시 30_flow_periods_1y.sql 이후에 실행하세요
--   (v_market_flow_periods/v_stock_flow_periods를 drop-recreate 합니다).
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================


-- ── 1) daily_flow.corp_other_net ────────────────────────────────────────────
alter table daily_flow add column if not exists corp_other_net bigint generated always as (
  -(coalesce(individual_net,0) + coalesce(foreign_net,0) + coalesce(inst_net,0))
) stored;

comment on column daily_flow.corp_other_net is
  '기타법인 = -(개인+외국인+기관계). 투자자 구분 4그룹 순매수 총합은 항상 0이므로 저장된 컬럼만으로 정확히 역산됩니다(2026-08 용량정리로 삭제된 원본 컬럼 대체)';


-- ── 2) v_market_flow_periods / v_stock_flow_periods : individual/corp_other 기간별 합계 ──
drop view if exists v_stock_flow_periods cascade;
drop view if exists v_market_flow_periods cascade;

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
  where d.ago < 250
)
select
  sum(foreign_net)     filter (where ago<250) as foreign_1y,
  sum(foreign_net)     filter (where ago<60)  as foreign_3m,
  sum(foreign_net)     filter (where ago<40)  as foreign_2m,
  sum(foreign_net)     filter (where ago<20)  as foreign_1m,
  sum(foreign_net)     filter (where ago<10)  as foreign_2w,
  sum(foreign_net)     filter (where ago<5)   as foreign_1w,
  sum(foreign_net)     filter (where ago<1)   as foreign_1d,
  sum(inst_net)        filter (where ago<250) as inst_1y,
  sum(inst_net)        filter (where ago<60)  as inst_3m,
  sum(inst_net)        filter (where ago<40)  as inst_2m,
  sum(inst_net)        filter (where ago<20)  as inst_1m,
  sum(inst_net)        filter (where ago<10)  as inst_2w,
  sum(inst_net)        filter (where ago<5)   as inst_1w,
  sum(inst_net)        filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)     filter (where ago<250) as fin_inv_1y,
  sum(fin_inv_net)     filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)     filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)     filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)     filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)     filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)     filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net)   filter (where ago<250) as inv_trust_1y,
  sum(inv_trust_net)   filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net)   filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net)   filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net)   filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net)   filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net)   filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)     filter (where ago<250) as pension_1y,
  sum(pension_net)     filter (where ago<60)  as pension_3m,
  sum(pension_net)     filter (where ago<40)  as pension_2m,
  sum(pension_net)     filter (where ago<20)  as pension_1m,
  sum(pension_net)     filter (where ago<10)  as pension_2w,
  sum(pension_net)     filter (where ago<5)   as pension_1w,
  sum(pension_net)     filter (where ago<1)   as pension_1d,
  sum(pe_net)          filter (where ago<250) as pe_1y,
  sum(pe_net)          filter (where ago<60)  as pe_3m,
  sum(pe_net)          filter (where ago<40)  as pe_2m,
  sum(pe_net)          filter (where ago<20)  as pe_1m,
  sum(pe_net)          filter (where ago<10)  as pe_2w,
  sum(pe_net)          filter (where ago<5)   as pe_1w,
  sum(pe_net)          filter (where ago<1)   as pe_1d,
  sum(individual_net)  filter (where ago<250) as individual_1y,
  sum(individual_net)  filter (where ago<60)  as individual_3m,
  sum(individual_net)  filter (where ago<40)  as individual_2m,
  sum(individual_net)  filter (where ago<20)  as individual_1m,
  sum(individual_net)  filter (where ago<10)  as individual_2w,
  sum(individual_net)  filter (where ago<5)   as individual_1w,
  sum(individual_net)  filter (where ago<1)   as individual_1d,
  sum(corp_other_net)  filter (where ago<250) as corp_other_1y,
  sum(corp_other_net)  filter (where ago<60)  as corp_other_3m,
  sum(corp_other_net)  filter (where ago<40)  as corp_other_2m,
  sum(corp_other_net)  filter (where ago<20)  as corp_other_1m,
  sum(corp_other_net)  filter (where ago<10)  as corp_other_2w,
  sum(corp_other_net)  filter (where ago<5)   as corp_other_1w,
  sum(corp_other_net)  filter (where ago<1)   as corp_other_1d
from f;

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
  where d.ago < 250
)
select code,
  sum(foreign_net)     filter (where ago<250) as foreign_1y,
  sum(foreign_net)     filter (where ago<60)  as foreign_3m,
  sum(foreign_net)     filter (where ago<40)  as foreign_2m,
  sum(foreign_net)     filter (where ago<20)  as foreign_1m,
  sum(foreign_net)     filter (where ago<10)  as foreign_2w,
  sum(foreign_net)     filter (where ago<5)   as foreign_1w,
  sum(foreign_net)     filter (where ago<1)   as foreign_1d,
  sum(inst_net)        filter (where ago<250) as inst_1y,
  sum(inst_net)        filter (where ago<60)  as inst_3m,
  sum(inst_net)        filter (where ago<40)  as inst_2m,
  sum(inst_net)        filter (where ago<20)  as inst_1m,
  sum(inst_net)        filter (where ago<10)  as inst_2w,
  sum(inst_net)        filter (where ago<5)   as inst_1w,
  sum(inst_net)        filter (where ago<1)   as inst_1d,
  sum(fin_inv_net)     filter (where ago<250) as fin_inv_1y,
  sum(fin_inv_net)     filter (where ago<60)  as fin_inv_3m,
  sum(fin_inv_net)     filter (where ago<40)  as fin_inv_2m,
  sum(fin_inv_net)     filter (where ago<20)  as fin_inv_1m,
  sum(fin_inv_net)     filter (where ago<10)  as fin_inv_2w,
  sum(fin_inv_net)     filter (where ago<5)   as fin_inv_1w,
  sum(fin_inv_net)     filter (where ago<1)   as fin_inv_1d,
  sum(inv_trust_net)   filter (where ago<250) as inv_trust_1y,
  sum(inv_trust_net)   filter (where ago<60)  as inv_trust_3m,
  sum(inv_trust_net)   filter (where ago<40)  as inv_trust_2m,
  sum(inv_trust_net)   filter (where ago<20)  as inv_trust_1m,
  sum(inv_trust_net)   filter (where ago<10)  as inv_trust_2w,
  sum(inv_trust_net)   filter (where ago<5)   as inv_trust_1w,
  sum(inv_trust_net)   filter (where ago<1)   as inv_trust_1d,
  sum(pension_net)     filter (where ago<250) as pension_1y,
  sum(pension_net)     filter (where ago<60)  as pension_3m,
  sum(pension_net)     filter (where ago<40)  as pension_2m,
  sum(pension_net)     filter (where ago<20)  as pension_1m,
  sum(pension_net)     filter (where ago<10)  as pension_2w,
  sum(pension_net)     filter (where ago<5)   as pension_1w,
  sum(pension_net)     filter (where ago<1)   as pension_1d,
  sum(pe_net)          filter (where ago<250) as pe_1y,
  sum(pe_net)          filter (where ago<60)  as pe_3m,
  sum(pe_net)          filter (where ago<40)  as pe_2m,
  sum(pe_net)          filter (where ago<20)  as pe_1m,
  sum(pe_net)          filter (where ago<10)  as pe_2w,
  sum(pe_net)          filter (where ago<5)   as pe_1w,
  sum(pe_net)          filter (where ago<1)   as pe_1d,
  sum(individual_net)  filter (where ago<250) as individual_1y,
  sum(individual_net)  filter (where ago<60)  as individual_3m,
  sum(individual_net)  filter (where ago<40)  as individual_2m,
  sum(individual_net)  filter (where ago<20)  as individual_1m,
  sum(individual_net)  filter (where ago<10)  as individual_2w,
  sum(individual_net)  filter (where ago<5)   as individual_1w,
  sum(individual_net)  filter (where ago<1)   as individual_1d,
  sum(corp_other_net)  filter (where ago<250) as corp_other_1y,
  sum(corp_other_net)  filter (where ago<60)  as corp_other_3m,
  sum(corp_other_net)  filter (where ago<40)  as corp_other_2m,
  sum(corp_other_net)  filter (where ago<20)  as corp_other_1m,
  sum(corp_other_net)  filter (where ago<10)  as corp_other_2w,
  sum(corp_other_net)  filter (where ago<5)   as corp_other_1w,
  sum(corp_other_net)  filter (where ago<1)   as corp_other_1d
from f
group by code;


-- ── 3) v_market_overview (STEP1) : corp_other_net/corp_other_cum 추가 ───────
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
  group by p.trade_date
)
select trade_date,
       total_amount,
       foreign_net,
       inst_net,
       individual_net,
       corp_other_net,
       stock_count,
       -- 누적 순매수: 선 차트로 "돈이 계속 들어오는가"를 보는 값
       sum(foreign_net)     over w as foreign_cum,
       sum(inst_net)        over w as inst_cum,
       sum(individual_net)  over w as individual_cum,
       sum(corp_other_net)  over w as corp_other_cum,
       avg(total_amount)    over (order by trade_date rows between 19 preceding and current row)
                                  as amt_ma20
from d
window w as (order by trade_date rows unbounded preceding);


-- ── 4) v_sector_flow_daily (STEP2) : corp_other_net/corp_other_cum 추가 ─────
drop view if exists v_sector_flow_daily cascade;
create view v_sector_flow_daily
with (security_invoker = true) as
with d as (
  select vs.sector, fl.trade_date,
         sum(fl.foreign_net)     as foreign_net,
         sum(fl.inst_net)        as inst_net,
         sum(fl.fin_inv_net)     as fin_inv_net,
         sum(fl.inv_trust_net)   as inv_trust_net,
         sum(fl.pension_net)     as pension_net,
         sum(fl.pe_net)          as pe_net,
         sum(fl.individual_net)  as individual_net,
         sum(fl.corp_other_net)  as corp_other_net
  from daily_flow fl
  join stocks s on s.code = fl.code and s.security_type = 'STOCK'
  join v_stock_sector vs on vs.code = fl.code and vs.sector is not null
  where fl.trade_date >= '2025-09-01'
  group by vs.sector, fl.trade_date
)
select sector, trade_date, foreign_net, inst_net, fin_inv_net, inv_trust_net,
       pension_net, pe_net, individual_net, corp_other_net,
       sum(foreign_net)     over w as foreign_cum,
       sum(inst_net)        over w as inst_cum,
       sum(fin_inv_net)     over w as fin_inv_cum,
       sum(inv_trust_net)   over w as inv_trust_cum,
       sum(pension_net)     over w as pension_cum,
       sum(pe_net)          over w as pe_cum,
       sum(individual_net)  over w as individual_cum,
       sum(corp_other_net)  over w as corp_other_cum
from d
window w as (partition by sector order by trade_date rows unbounded preceding);


-- ── 5) v_stock_chart (종목상세) : corp_other_net/corp_other_cum 추가 ────────
drop view if exists v_stock_chart cascade;
create view v_stock_chart
with (security_invoker = true) as
select p.code, p.trade_date, p.close, p.high, p.low, p.volume, p.trade_amount,
       p.change_pct, p.market_cap,
       case when count(*) over w5   >= 5   then round(avg(p.close) over w5,   2) end as ma5,
       case when count(*) over w10  >= 10  then round(avg(p.close) over w10,  2) end as ma10,
       case when count(*) over w20  >= 20  then round(avg(p.close) over w20,  2) end as ma20,
       case when count(*) over w60  >= 60  then round(avg(p.close) over w60,  2) end as ma60,
       case when count(*) over w120 >= 120 then round(avg(p.close) over w120, 2) end as ma120,
       -- 주체별 누적 순매수 (상장 이후 전 기간 누적)
       sum(coalesce(f.foreign_net,0))     over w as foreign_cum,
       sum(coalesce(f.inst_net,0))        over w as inst_cum,
       sum(coalesce(f.individual_net,0))  over w as individual_cum,
       sum(coalesce(f.corp_other_net,0))  over w as corp_other_cum,
       sum(coalesce(f.fin_inv_net,0))     over w as fin_inv_cum,
       sum(coalesce(f.inv_trust_net,0))   over w as inv_trust_cum,
       sum(coalesce(f.pension_net,0))     over w as pension_cum,
       sum(coalesce(f.pe_net,0))          over w as pe_cum,
       coalesce(f.foreign_net,0)     as foreign_net,
       coalesce(f.inst_net,0)        as inst_net,
       coalesce(f.individual_net,0)  as individual_net,
       coalesce(f.corp_other_net,0)  as corp_other_net
from daily_price p
left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
join stocks s on s.code = p.code and s.security_type = 'STOCK'
where p.close > 0
window
  w    as (partition by p.code order by p.trade_date rows unbounded preceding),
  w5   as (partition by p.code order by p.trade_date rows between   4 preceding and current row),
  w10  as (partition by p.code order by p.trade_date rows between   9 preceding and current row),
  w20  as (partition by p.code order by p.trade_date rows between  19 preceding and current row),
  w60  as (partition by p.code order by p.trade_date rows between  59 preceding and current row),
  w120 as (partition by p.code order by p.trade_date rows between 119 preceding and current row);


-- ── 6) v_screener : corp_other_net을 daily_flow의 실제 컬럼으로 교체 ────────
-- (예전엔 뷰 안에서 -(개인+외국인+기관)을 매번 계산했는데, 이제 daily_flow에
--  실제 generated 컬럼이 생겼으니 그냥 select 합니다 — 결과는 동일합니다)
drop view if exists v_screener cascade;
create view v_screener
with (security_invoker = true) as
select v.*,
       f.foreign_net, f.inst_net, f.fin_inv_net, f.inv_trust_net,
       f.pension_net, f.pe_net, f.individual_net, f.corp_other_net,
       sr.rs_rank                                        as sector_rs_rank,
       sg.signal_type, sg.grade, sg.score, sg.reason_text
from v_sector_stocks v
left join daily_flow f  on f.trade_date = v.trade_date and f.code = v.code
left join v_sector_rank sr on sr.sector = v.sector
left join signals sg    on sg.trade_date = v.trade_date and sg.code = v.code
                       and sg.signal_type = 'V4_CANDIDATE';


-- ── anon(브라우저) 읽기 권한 재부여 (drop cascade로 지워졌으므로) ───────────
do $$
begin
  grant select on v_market_flow_periods, v_stock_flow_periods,
                  v_market_overview, v_sector_flow_daily, v_stock_chart,
                  v_screener
    to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
-- 1) 기타법인 역산이 정확한지: 4그룹 합이 항상 0이어야 합니다.
select count(*) as mismatch
from daily_flow
where coalesce(individual_net,0)+coalesce(foreign_net,0)+coalesce(inst_net,0)+coalesce(corp_other_net,0) <> 0;
-- 2) 요청한 백필 구간(2025-09-01~2026-08-21)에 실제로 값이 채워졌는지.
select min(trade_date), max(trade_date), count(*) as rows_with_corp_other
from daily_flow
where trade_date between '2025-09-01' and '2026-08-21' and corp_other_net is not null;
