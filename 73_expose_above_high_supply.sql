-- ============================================================================
-- STOCK RADAR · v_sector_stocks/v_screener/v_stock_summary에
-- above_high_supply_eok(종목후보용 위쪽 매물대) 노출
-- ============================================================================
-- 72_above_high_supply_column.sql로 daily_metrics.above_high_supply_eok 컬럼을
-- 먼저 만들어야 합니다(이 파일보다 먼저 실행).
--
-- ⚠ 67_fix_ma120_view_regression.sql의 경고에 따라, 이 파일은 그 정의(가장
-- 최신)를 베이스로 m.above_high_supply_eok 한 줄만 추가한 것입니다. 앞으로 이
-- 세 뷰를 다시 만들 일이 있으면 반드시 "이 파일(73번)"을 기준으로 작성할 것.
--
-- v_screener/v_stock_summary는 "select v.*"로 v_sector_stocks를 그대로
-- 가져오므로, v_sector_stocks에 한 줄만 추가하면 프론트의 select=* 쿼리들이
-- 코드 변경 없이 자동으로 이 컬럼을 받습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행 (Claude는 DB 쓰기 권한이
--   없어 직접 실행할 수 없습니다).
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
       -- 2026-09-20: 종목후보 결과 표 전용 — 현재가~최고가 구간 24등분 개인
       -- 누적 순매수 합계(억원). 종목상세의 above_supply_eok(-10%~+90% 기준,
       -- 아직 미도입)와는 별개 컬럼.
       m.above_high_supply_eok,
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

-- ── 확인 ──────────────────────────────────────────────────────────────────
select code, trade_date, above_high_supply_eok
from v_screener
where trade_date = (select max(trade_date) from v_screener)
order by above_high_supply_eok desc nulls last
limit 5;
