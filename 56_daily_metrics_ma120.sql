-- ============================================================================
-- STOCK RADAR · daily_metrics에 MA120(120거래일 이동평균) 추가
-- ============================================================================
-- 배경: 정배열 필터 3종(오늘의 종목 todayAligned / 종목후보 aligned / 전략E
-- e_aligned)의 조건을 "종가 > MA5 > MA20 > MA60 > MA120"으로 통일했는데,
-- daily_metrics 테이블에 ma120 컬럼 자체가 없었습니다(ma5/ma10/ma20/ma60까지만
-- 존재). v_sector_stocks/v_screener도 ma120을 노출하지 않다 보니, 프론트에서
-- r.ma120이 항상 undefined였고 "r.ma120 != null" 체크가 JS 느슨한 비교 규칙상
-- (undefined == null) 항상 false로 평가되어 정배열 조건이 날짜·시간과 무관하게
-- 무조건 0건이 되는 버그가 있었습니다.
--
-- 이 파일은 05_metrics.sql(daily_metrics 계산 STEP에 ma120 산출 추가된 버전)과
-- 함께 적용합니다.
--   1) daily_metrics.ma120 컬럼 추가
--   2) v_sector_stocks에 m.ma120 노출 (create or replace로 기존 컬럼 순서
--      유지 + 끝에 추가 → v_screener/v_stock_summary는 v.*로 상속하므로
--      자동으로 함께 노출되며, 이 파일에서 따로 건드릴 필요 없음)
--
-- ⚠ 실행 순서: 이 SQL을 먼저 실행 → 이후 compute.yml이 재실행되어야
--   실제 ma120 값이 채워집니다(120거래일 이상 이력이 있는 종목만 값이 생기고,
--   그 미만인 신규상장 종목 등은 계속 NULL — 정배열 조건에서 자동 제외됨).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

alter table daily_metrics add column if not exists ma120 numeric(14,2);

comment on column daily_metrics.ma120 is
  '120거래일 이동평균 종가(rolling, 최소 120일 이력 필요). 이력 부족 시 NULL';

create or replace view v_sector_stocks
with (security_invoker = true) as
select p.trade_date, vs.sector, p.code, s.name, s.market,
       p.close, p.change_pct, p.trade_amount, p.volume, p.market_cap,
       p.weight_per_share,
       case when p.market_cap > 0
            then round(p.trade_amount::numeric / p.market_cap * 100, 3) end as amt_cap_pct,
       m.vol_ratio20, m.vol_ratio20_prev, m.amt_ratio20,
       m.is_new_high, m.is_new_high_all, m.near_high, m.pct_from_high,
       m.high_period, m.high_period_date, m.high_label,
       m.ma5, m.ma20, m.ma60, m.ma_aligned,
       m.smart_cum5, m.smart_cum20, m.consec_both_buy, m.consec_both_sell,
       m.nonpersonal_net, m.pick_score,
       -- v4: 개별종목 상대강도 = 종목 20일수익률(%) − 유니버스 평균 20일수익률(%).
       -- 신고가가 아니어도 시장보다 강한(=바닥에서 올라오는) 종목을 잡는 용도.
       m.rs20_vs_mkt,
       case when p.high > p.low
            then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1) end as close_pos_pct,
       -- 정배열(종가>MA5>MA20>MA60>MA120) 필터용. 기존 컬럼 순서를 그대로
       -- 두기 위해 create or replace 규칙상 맨 끝에 추가합니다.
       m.ma120
from daily_price p
join stocks s on s.code = p.code and s.security_type = 'STOCK'
join v_stock_sector vs on vs.code = p.code
left join daily_metrics m on m.trade_date = p.trade_date and m.code = p.code
where p.close > 0;

do $$
begin
  grant select on v_sector_stocks, v_screener, v_stock_summary to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
