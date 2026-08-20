-- ============================================================================
-- STOCK RADAR · 시장 전체 거래대금(실데이터) 스키마
-- ============================================================================
-- "시장 거래대금" 카드가 지금까지는 유니버스 300종목 합계(v_market_overview.
-- total_amount)로 대체 표시되고 있었습니다. KOSPI/KOSDAQ 지수를 받아오는
-- inquire-daily-indexchartprice 응답의 output2 행에는 지수 종가(bstp_nmix_prpr)
-- 뿐 아니라 그날 시장 전체 누적거래대금(acml_tr_pbmn)도 같이 들어있어서,
-- 이미 하고 있는 지수 수집/백필에 필드 하나만 더 읽으면 KOSPI+KOSDAQ 합산
-- 실제 시장 전체 거래대금을 얻을 수 있습니다 (API 호출 추가 없음).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

-- 1) market_daily에 컬럼 추가 (기존 total_amount는 300종목 합계 용도로 그대로 둡니다 —
--    다른 곳(05_metrics.sql 등)에서 계속 쓰므로 건드리지 않습니다)
alter table market_daily add column if not exists index_amount bigint;
comment on column market_daily.index_amount is 'KIS inquire-daily-indexchartprice의 acml_tr_pbmn(원 단위) — 해당 시장(KOSPI|KOSDAQ) 전체 누적거래대금';

-- 2) KOSPI+KOSDAQ 합산 = 시장 전체 실거래대금 뷰
drop view if exists v_market_amount_real cascade;
create view v_market_amount_real
with (security_invoker = true) as
with d as (
  select trade_date, sum(index_amount) as total_amount, count(*) as market_count
  from market_daily
  where market in ('KOSPI', 'KOSDAQ') and index_amount is not null
  group by trade_date
  having count(*) = 2   -- 두 시장 모두 값이 있는 날짜만 (한쪽만 있으면 왜곡되므로 제외)
)
select trade_date,
       total_amount,
       avg(total_amount) over (order by trade_date rows between 19 preceding and current row) as amt_ma20
from d
order by trade_date;

do $$
begin
  grant select on v_market_amount_real to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
