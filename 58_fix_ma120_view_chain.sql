-- ============================================================================
-- STOCK RADAR · ma120 노출 재시도 — drop cascade 방식으로 전환 (57번 실패 수정)
-- ============================================================================
-- 57_expose_ma120_dependents.sql이 아래 에러로 실패했습니다.
--
--   ERROR: 42P16: cannot change name of view column "foreign_net" to "ma120"
--   HINT:  Use ALTER VIEW ... RENAME COLUMN ... to change name of view column
--
-- 원인: v_sector_stocks 끝에 ma120을 추가(56번)하면서 v_sector_stocks가
-- 뿜어내는 컬럼 수가 하나 늘었습니다. v_screener는 `select v.*, f.foreign_net,
-- ...`처럼 v.* 뒤에 리터럴 컬럼을 이어붙이는 구조라서, v.*가 한 칸 늘어나면
-- 그 뒤에 오는 f.foreign_net 이하 모든 컬럼의 "순번"이 통째로 한 칸씩
-- 밀립니다. CREATE OR REPLACE VIEW는 기존에 이미 만들어진 순번의 컬럼명이
-- 바뀌는 걸 허용하지 않기 때문에(딱 "끝에 새 컬럼 추가"만 허용), 이 케이스처럼
-- 중간(v.*) 확장으로 뒤쪽 컬럼 순번이 밀리는 경우는 create or replace로
-- 처리할 수 없습니다. 55_sector_rs5.sql/56_daily_metrics_ma120.sql에서
-- create or replace가 통했던 건 그 두 뷰(v_sector_rank, v_sector_stocks)가
-- v.* 뒤에 리터럴 컬럼을 잇지 않고 끝에만 추가하는 구조였기 때문입니다.
--
-- 해결: v_sector_stocks를 cascade로 지우고(의존하는 v_screener/
-- v_stock_summary까지 함께 삭제됨) 세 뷰를 순서대로 다시 만듭니다. 로직은
-- 전혀 바뀌지 않고, ma120 노출 위치만 v_sector_stocks 안의 자연스러운
-- 자리(ma60 옆)로 정리했습니다 — 51_screener_rs.sql 최신 정의 + ma120 한 줄.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_sector_stocks cascade;  -- v_screener, v_stock_summary도 함께 삭제됨

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
       -- 신고가가 아니어도 시장보다 강한(=바닥에서 올라오는) 종목을 잡는 용도.
       m.rs20_vs_mkt,
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
