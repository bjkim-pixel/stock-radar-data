-- ============================================================================
-- STOCK RADAR · 프로그램 순매수 (1) 잔존 단위 버그 복구 + (2) 누적 컬럼 추가
-- ============================================================================
-- (1) 복구
-- 03_daily_collect.py의 프로그램매매 단위 버그(×FLOW_UNIT 과다 곱셈)는
-- 2026-08-26 커밋으로 고쳤지만, 그 전에 저장된 행 중 일부(예: 효성중공업)는
-- 이후 재수집 시도에서 API 호출이 실패해 덮어써지지 못하고 예전 버그값이
-- 그대로 남아있습니다. 예: 효성중공업 순매수가 +24,161,600억(2.4×10^15원)로
-- 표시 — 실제 하루 프로그램 순매수가 이 정도로 크면 코스피 전체 시가총액을
-- 넘어서므로 명백히 예전 버그(100만 배 과다)의 흔적입니다.
--
-- 정상 범위라면 아무리 큰 종목·급등락일이라도 하루 프로그램 순매수 절대값이
-- 10만억원(1e13원)을 넘을 수 없습니다(코스피 전체 하루 거래대금보다 큼).
-- 이 임계값을 넘는 행만 골라 ÷1,000,000 해서 원래 값으로 되돌립니다.
--
-- (2) v_stock_chart에 pgtr_cum(프로그램 순매수 누적, 상장 이후 전체 기간)
-- 추가 — 화면에서 다른 수급주체별 누적 순매수 차트와 동일한 포맷(리베이스
-- 누적 라인차트)으로 표시하기 위함입니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

-- ── 1. 잔존 버그값 복구 ────────────────────────────────────────────────────
do $$
declare
  n integer;
begin
  update daily_program
  set pgtr_buy_amt  = pgtr_buy_amt  / 1000000,
      pgtr_sell_amt = pgtr_sell_amt / 1000000,
      pgtr_net_amt  = pgtr_net_amt  / 1000000
  where abs(coalesce(pgtr_net_amt,0))  > 100000::bigint * 100000000
     or abs(coalesce(pgtr_buy_amt,0))  > 100000::bigint * 100000000
     or abs(coalesce(pgtr_sell_amt,0)) > 100000::bigint * 100000000;
  get diagnostics n = row_count;
  raise notice '프로그램매매 단위 버그 복구: %행', n;
end $$;

-- 확인 — 위 UPDATE 후 이상치가 남아있지 않아야 합니다
select trade_date, code, pgtr_buy_amt, pgtr_sell_amt, pgtr_net_amt
from daily_program
where abs(coalesce(pgtr_net_amt,0))  > 100000::bigint * 100000000
   or abs(coalesce(pgtr_buy_amt,0))  > 100000::bigint * 100000000
   or abs(coalesce(pgtr_sell_amt,0)) > 100000::bigint * 100000000
order by abs(pgtr_net_amt) desc
limit 20;

-- ── 2. v_stock_chart 재빌드 — pgtr_cum 추가 ─────────────────────────────────
drop view if exists v_stock_chart cascade;

create view v_stock_chart
with (security_invoker = true) as
select p.code, p.trade_date, p.close, p.high, p.low, p.volume, p.trade_amount,
       p.change_pct, p.market_cap,
       p.weight_per_share,
       -- 이동평균 직접 계산 (daily_metrics는 2026-01-01 이후만 보관)
       case when count(*) over w5   >= 5   then round(avg(p.close) over w5,   2) end as ma5,
       case when count(*) over w10  >= 10  then round(avg(p.close) over w10,  2) end as ma10,
       case when count(*) over w20  >= 20  then round(avg(p.close) over w20,  2) end as ma20,
       case when count(*) over w60  >= 60  then round(avg(p.close) over w60,  2) end as ma60,
       case when count(*) over w120 >= 120 then round(avg(p.close) over w120, 2) end as ma120,
       -- 주체별 누적 순매수 (상장 이후 전 기간 누적)
       sum(coalesce(f.foreign_net,0))    over w as foreign_cum,
       sum(coalesce(f.inst_net,0))       over w as inst_cum,
       sum(coalesce(f.individual_net,0)) over w as individual_cum,
       sum(coalesce(f.fin_inv_net,0))    over w as fin_inv_cum,
       sum(coalesce(f.inv_trust_net,0))  over w as inv_trust_cum,
       sum(coalesce(f.pension_net,0))    over w as pension_cum,
       sum(coalesce(f.pe_net,0))         over w as pe_cum,
       sum(coalesce(f.corp_other_net,0)) over w as corp_other_cum,
       -- 프로그램 순매수 누적 (상장 이후 전 기간 누적 — 다른 주체별 누적과 동일 포맷)
       sum(coalesce(dp.pgtr_net_amt,0))  over w as pgtr_cum,
       coalesce(f.foreign_net,0)    as foreign_net,
       coalesce(f.inst_net,0)       as inst_net,
       coalesce(f.individual_net,0) as individual_net,
       -- 프로그램 순매수 (일별)
       dp.pgtr_net_amt
from daily_price p
left join daily_flow    f  on f.trade_date  = p.trade_date and f.code  = p.code
left join daily_program dp on dp.trade_date = p.trade_date and dp.code = p.code
join stocks s on s.code = p.code and s.security_type = 'STOCK'
where p.close > 0
window
  w    as (partition by p.code order by p.trade_date rows unbounded preceding),
  w5   as (partition by p.code order by p.trade_date rows between   4 preceding and current row),
  w10  as (partition by p.code order by p.trade_date rows between   9 preceding and current row),
  w20  as (partition by p.code order by p.trade_date rows between  19 preceding and current row),
  w60  as (partition by p.code order by p.trade_date rows between  59 preceding and current row),
  w120 as (partition by p.code order by p.trade_date rows between 119 preceding and current row);

do $$
begin
  grant select on v_stock_chart to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
