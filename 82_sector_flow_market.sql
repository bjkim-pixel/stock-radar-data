-- ============================================================================
-- STOCK RADAR · 업종별 자금흐름 (수급동향 상단 카드용) — v_sector_flow_market
-- ============================================================================
-- 최근 10거래일 · 시장(KOSPI/KOSDAQ) × 업종 × 일자별로
--   거래대금(추적 종목 합) + 4개 주체 순매수(외국인/기관합계/기타법인/개인) 합계.
-- 화면은 이 중 최근 5거래일만 쓰고, 시장 전체 거래대금(코스피/코스닥/전체)은
-- market_daily.index_amount를 따로 조회해 보여줍니다(이 뷰는 추적 종목 기준).
--
-- · 업종은 v_stock_sector(sector_override 반영) — 종목후보 업종 필터와 같은
--   분류라서 업종명을 그대로 종목후보 링크에 쓸 수 있습니다.
-- · 날짜는 뷰 안에서 "최근 10거래일"로 제한 — 전 기간을 매번 집계하지 않도록
--   (Supabase nano 부하 대책: v_market_overview 장애 교훈).
-- · security_invoker=true (Advisor 경고 방지, 78번 RLS 읽기정책과 호환)
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_sector_flow_market;
create view v_sector_flow_market
with (security_invoker = true) as
with recent as (
  select distinct trade_date
  from daily_price
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
  '최근 10거래일 시장×업종×일자별 거래대금·주체별(외국인/기관합계/기타법인/개인) 순매수 합계. 수급동향 상단 "업종별 자금흐름" 카드용. 추적 종목 기준.';

do $$
begin
  grant select on v_sector_flow_market to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select trade_date, market, count(*) as sectors, sum(trade_amount)/1e8 as 거래대금_억
from v_sector_flow_market
group by trade_date, market
order by trade_date desc, market;
