-- ============================================================================
-- STOCK RADAR · v_sector_flow_market: 휴장일(공휴일·주말) 제외, 실제 거래일만
-- ============================================================================
-- 82번 뷰는 "daily_price에 행이 있는 최근 10일"을 썼는데, 휴장일에 수집/계산이
-- 돌면서 생긴 날짜가 섞일 수 있었습니다. 이제 "시장 지수 데이터(index_close)와
-- 지수 거래대금(index_amount)이 실제로 있는 평일"만 거래일로 인정합니다 —
-- market_daily의 지수 값은 KIS 지수 일봉에서 오므로 휴장일엔 생기지 않습니다.
--   · 평일만(isodow 1~5)
--   · KOSPI 지수 종가·거래대금이 있는 날만
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_sector_flow_market;
create view v_sector_flow_market
with (security_invoker = true) as
with recent as (
  select trade_date
  from market_daily
  where market = 'KOSPI'
    and index_close is not null
    and coalesce(index_amount, 0) > 0
    and extract(isodow from trade_date) between 1 and 5
  order by trade_date desc
  limit 10
)
select p.trade_date, s.market, vs.sector,
       count(*)               as stock_count,
       sum(p.trade_amount)    as trade_amount,
       sum(f.foreign_net)     as foreign_net,
       sum(f.inst_net)        as inst_net,
       sum(f.corp_other_net)  as corp_other_net,
       sum(f.individual_net)  as individual_net
from recent r
join daily_price p on p.trade_date = r.trade_date
join stocks s on s.code = p.code
             and s.security_type = 'STOCK'
             and s.market in ('KOSPI', 'KOSDAQ')
join v_stock_sector vs on vs.code = p.code and vs.sector is not null
left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
where p.close > 0
group by p.trade_date, s.market, vs.sector;

comment on view v_sector_flow_market is
  '최근 10 실거래일(평일 + KOSPI 지수 데이터 존재) 시장×업종×일자별 거래대금·주체별 순매수 합계. 수급동향 "업종별 자금흐름" 카드용. 추적 종목 기준.';

do $$
begin
  grant select on v_sector_flow_market to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음';
end $$;

-- ── 확인: 거래일 목록(휴장일이 없어야 함) ─────────────────────────────────
select trade_date, to_char(trade_date,'Dy') as 요일, market, count(*) as 업종수
from v_sector_flow_market
group by trade_date, market
order by trade_date desc, market;
