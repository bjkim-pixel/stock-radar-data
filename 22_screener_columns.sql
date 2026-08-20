-- ============================================================================
-- STOCK RADAR · 조건 스크리너 결과에 52주 최고가/날짜 노출
-- ============================================================================
-- v_sector_stocks(→ v_screener가 select v.*로 상속)에 daily_metrics.high_period_date
-- (52주/기간 내 최고 종가를 기록한 날짜)와 high_label(라벨: '52주 신고가' 등)을
-- 추가로 노출합니다. daily_metrics.high_period(최고 종가 값) 자체는 이미
-- v_sector_stocks에 있었고, 그 날짜만 빠져 있었습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_screener cascade;
drop view if exists v_sector_stocks cascade;

create view v_sector_stocks
with (security_invoker = true) as
with latest as (select max(trade_date) as d from daily_price)
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
cross join latest l
where p.trade_date = l.d and p.close > 0;

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
