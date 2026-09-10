-- ============================================================================
-- STOCK RADAR · ma120 뷰 노출 재발 수정 (64번이 58번의 수정을 되돌린 것 복구)
-- ============================================================================
-- 배경: 2026-09-10, "종목후보" 화면의 정배열(종가>MA5>MA20>MA60>MA120) 필터가
-- 전종목 0건으로 나오는 버그를 SK이노베이션(096770)을 예시로 조사했습니다.
--
-- 원인 확인(운영 Supabase REST로 직접 조회):
--   - daily_metrics.ma120 테이블 컬럼 자체는 정상 계산·저장되고 있었음
--     (예: 096770 2026-09-09 ma120=118260.00 — 05_metrics.sql/compute.yml은
--     문제없이 잘 돌고 있었음)
--   - 그런데 v_sector_stocks 뷰 조회 시 "column v_sector_stocks.ma120 does
--     not exist" 에러 발생 → 프론트가 읽는 뷰 체인에서만 ma120이 누락된 상태
--
-- 근본 원인: 58_fix_ma120_view_chain.sql이 한 번 ma120을 뷰에 노출시켰지만,
-- 그 이후 63_rs5_and_percentile.sql(rs5_vs_mkt/rs20_pctl/rs5_pctl 컬럼 추가)의
-- 뷰 노출 파일인 64_screener_rs5.sql이 58번이 아니라 그 이전 베이스
-- (51_screener_rs.sql 기준)를 복사해서 작성되는 바람에, 58번에서 추가했던
-- ma120이 64번 배포 때 다시 조용히 빠졌습니다(drop cascade + 재생성 방식이라
-- 에러 없이 "정상 배포"된 것처럼 보였음 — 컬럼이 빠진 채로).
--
-- 이 파일은 64_screener_rs5.sql의 최신 정의(rs5_vs_mkt/rs20_pctl/rs5_pctl 유지)에
-- m.ma120 한 줄만 다시 추가해서 재발시킵니다. 2026-09-10 Supabase SQL
-- Editor에서 실행 완료 및 REST API로 v_sector_stocks/v_screener 양쪽에서
-- ma120 정상 노출 확인함.
--
-- ⚠ 주의: 앞으로 v_sector_stocks/v_screener/v_stock_summary를 다시
-- drop-and-recreate할 일이 있으면 반드시 이 파일(67번, 가장 최신)을 기준으로
-- 작성할 것 — 58번이나 64번처럼 더 오래된 파일을 베이스로 복사하면 그 사이에
-- 추가된 컬럼(ma120 포함)이 또 빠질 수 있음.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행 (이미 2026-09-10에 실행 완료 —
-- 이 파일은 실행 기록 보존 + 향후 재실행 대비용).
-- ============================================================================

drop view if exists v_screener cascade;
drop view if exists v_stock_summary cascade;
drop view if exists v_sector_stocks cascade;

create view v_sector_stocks
with (security_invoker = true) as
select p.trade_date, vs.sector, p.code, s.name, s.market,
       p.close, p.change_pct, p.trade_amount, p.volume, p.market_cap,
       p.weight_per_share,
       case when p.market_cap > 0
            then round(p.trade_amount::numeric / p.market_cap * 100, 3) end as amt_cap_pct,
       m.vol_ratio20, m.vol_ratio20_prev, m.amt_ratio20,
       m.is_new_high, m.is_new_high_all, m.near_high, m.pct_from_high,
       m.high_period, m.high_period_date, m.high_label,
       m.ma5, m.ma20, m.ma60, m.ma120, m.ma_aligned,
       m.smart_cum5, m.smart_cum20, m.consec_both_buy, m.consec_both_sell,
       m.nonpersonal_net, m.pick_score,
       -- v4: 개별종목 상대강도 = 종목 20일수익률(%) − 유니버스 평균 20일수익률(%).
       m.rs20_vs_mkt,
       -- 개별RS 5일 버전(원시 %p) — 계산 방식은 rs20_vs_mkt와 동일, 창만 5거래일
       m.rs5_vs_mkt,
       -- 개별RS를 그날 유니버스 내 0~100 백분위로 환산한 값(100=최상위)
       m.rs20_pctl,
       m.rs5_pctl,
       -- 정배열(종가>MA5>MA20>MA60>MA120) 필터가 프론트에서 이 값을 참조함
       case when p.high > p.low
            then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1) end as close_pos_pct
from daily_price p
join stocks s on s.code = p.code and s.security_type = 'STOCK'
join v_stock_sector vs on vs.code = p.code
left join daily_metrics m on m.trade_date = p.trade_date and m.code = p.code
where p.close > 0;

create view v_screener
with (security_invoker = true) as
select v.*,
       f.foreign_net, f.inst_net, f.fin_inv_net, f.inv_trust_net,
       f.pension_net, f.pe_net, f.individual_net,
       -(coalesce(f.individual_net,0) + coalesce(f.foreign_net,0)
           + coalesce(f.inst_net,0))                       as corp_other_net,
       sr.rs_rank                                        as sector_rs_rank,
       sg.signal_type, sg.grade, sg.score, sg.reason_text,
       dp.pgtr_net_amt
from v_sector_stocks v
left join daily_flow    f  on f.trade_date  = v.trade_date and f.code  = v.code
left join v_sector_rank sr on sr.sector     = v.sector
left join signals       sg on sg.trade_date = v.trade_date and sg.code = v.code
                          and sg.signal_type = 'V4_CANDIDATE'
left join daily_program dp on dp.trade_date = v.trade_date and dp.code = v.code;

create view v_stock_summary
with (security_invoker = true) as
with latest as (select max(trade_date) as d from daily_price)
select v.*, sr.rs_rank as sector_rs_rank,
       f.foreign_net, f.inst_net, f.individual_net
from v_sector_stocks v
left join v_sector_rank sr on sr.sector = v.sector
left join daily_flow f on f.trade_date = v.trade_date and f.code = v.code
cross join latest l
where v.trade_date = l.d;

do $$
begin
  grant select on v_sector_stocks, v_screener, v_stock_summary to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
