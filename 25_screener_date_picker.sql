-- ============================================================================
-- STOCK RADAR · 종목 후보(스크리너) 기준일 선택 지원
-- ============================================================================
-- v_sector_stocks가 "최신 거래일만" 필터링돼 있어서 화면에서 날짜를 골라도
-- 항상 최신 거래일 데이터만 나왔습니다. 이 필터를 제거해 모든 과거 거래일을
-- 조회할 수 있게 하고, 프론트엔드는 항상 trade_date=eq.YYYY-MM-DD 를 붙여
-- 원하는 날짜 1개만 가져오도록 바꿨습니다(날짜 없이 select=*만 부르는 곳은
-- 없는지 web/index.html의 STEP3/STEP4/스크리너 세 호출 모두 trade_date 필터를
-- 붙이도록 함께 수정했습니다).
--
-- v_sector_rank(업종 RS)는 여전히 "최신 거래일 1행"만 유지합니다 — 과거
-- 날짜를 조회해도 업종 RS는 최신 값을 그대로 보여줍니다(의도된 단순화).
--
-- ⚠ v_sector_stocks를 cascade로 지우면 v_screener도 같이 지워지므로 이 파일
--   안에서 v_screener까지 함께 재생성합니다(23_sector_metrics_fix.sql의
--   최신 정의와 동일).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_screener cascade;
drop view if exists v_sector_stocks cascade;

create view v_sector_stocks
with (security_invoker = true) as
select p.trade_date, s.sector_krx as sector, p.code, s.name, s.market,
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
       case when p.high > p.low
            then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1) end as close_pos_pct
from daily_price p
join stocks s on s.code = p.code and s.security_type = 'STOCK'
left join daily_metrics m on m.trade_date = p.trade_date and m.code = p.code
where p.close > 0;

create view v_screener
with (security_invoker = true) as
select v.*,
       f.foreign_net, f.inst_net, f.fin_inv_net, f.inv_trust_net,
       f.pension_net, f.pe_net, f.individual_net,
       -- 기타법인 = -(개인+외국인+기관). 순매수 총합이 0이라 역산됩니다.
       -(coalesce(f.individual_net,0) + coalesce(f.foreign_net,0)
         + coalesce(f.inst_net,0))                       as corp_other_net,
       sr.rs_rank                                        as sector_rs_rank,
       sg.signal_type, sg.grade, sg.score, sg.reason_text
from v_sector_stocks v
left join daily_flow f  on f.trade_date = v.trade_date and f.code = v.code
left join v_sector_rank sr on sr.sector = v.sector
left join signals sg    on sg.trade_date = v.trade_date and sg.code = v.code
                       and sg.signal_type = 'V4_CANDIDATE';

do $$
begin
  grant select on v_sector_stocks, v_screener to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
