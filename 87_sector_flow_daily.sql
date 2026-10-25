-- ============================================================================
-- STOCK RADAR · sector_flow_daily: 시장×업종×일자별 거래대금·주체별 순매수 합계 (2026-06-01~)
-- ============================================================================
-- 수급동향 "자금 이동 타임라인"을 최근 10일이 아니라 2026-06-01부터 길게 보여주기 위한 사전 집계 테이블.
-- 정의는 v_sector_flow_market(83번)과 같습니다: 평일 + KOSPI 지수 거래대금이 있는 실거래일, 추적 STOCK 종목, 업종 있는 종목.
-- 화면은 이 테이블만 읽으므로 daily_price 전체를 매번 집계하지 않습니다(용량: 약 1.5MB, 읽기 부하 작음).
-- 87_sector_flow_daily.py 가 최초엔 2026-06-01부터 전부, 이후엔 최근 20일만 다시 계산(수급 지연 보정)합니다.
-- ============================================================================

create table if not exists sector_flow_daily (
  trade_date     date    not null,
  market         text    not null,
  sector         text    not null,
  stock_count    integer,
  trade_amount   bigint,
  foreign_net    bigint,
  inst_net       bigint,
  corp_other_net bigint,
  individual_net bigint,
  primary key (trade_date, market, sector)
);

create or replace function refresh_sector_flow_daily(p_from date, p_to date) returns integer
language plpgsql as $fn$
declare n integer;
begin
  delete from sector_flow_daily where trade_date between p_from and p_to;
  insert into sector_flow_daily
  with days as (
    select trade_date from market_daily
    where market = 'KOSPI' and index_close is not null and coalesce(index_amount, 0) > 0
      and extract(isodow from trade_date) between 1 and 5
      and trade_date between p_from and p_to)
  select p.trade_date, s.market, vs.sector,
         count(*)::int,
         sum(p.trade_amount)::bigint,
         sum(f.foreign_net)::bigint,
         sum(f.inst_net)::bigint,
         sum(f.corp_other_net)::bigint,
         sum(f.individual_net)::bigint
  from days r
  join daily_price p on p.trade_date = r.trade_date
  join stocks s on s.code = p.code and s.security_type = 'STOCK' and s.market in ('KOSPI','KOSDAQ')
  join v_stock_sector vs on vs.code = p.code and vs.sector is not null
  left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
  where p.close > 0
  group by p.trade_date, s.market, vs.sector;
  get diagnostics n = row_count;
  return n;
end $fn$;

alter table public.sector_flow_daily enable row level security;
drop policy if exists "public read" on public.sector_flow_daily;
create policy "public read" on public.sector_flow_daily for select using (true);
revoke insert, update, delete, truncate, trigger, references on public.sector_flow_daily from anon, authenticated;
grant select on public.sector_flow_daily to anon, authenticated;
revoke execute on function refresh_sector_flow_daily(date, date) from public, anon, authenticated;
