-- ============================================================================
-- STOCK RADAR · 조건 스크리너(종목 후보 화면)에 개별RS(rs20_vs_mkt) 노출
-- ============================================================================
-- 배경: 05_metrics.sql이 이미 매일 장마감 후(compute.yml, 16:30/18:30 KST)
-- 유니버스 전 종목(daily_metrics.rs20_vs_mkt)에 대해 개별 상대강도를 계산해
-- 두고 있습니다(= 종목 20일 수익률(%) − 유니버스 평균 20일 수익률(%)).
-- 06_signals.sql의 추세추종 3단계 매수 조건에서도 이미 쓰고 있고, A~G
-- 백테스트에서도 신고가 조건보다 성과가 나았습니다.
--
-- 지금까지는 이 값이 v_sector_stocks/v_screener 뷰에 노출되지 않아서 화면
-- "종목 후보" 조건 스크리너에서 조회 조건으로 쓸 수 없었습니다. 이 파일은
-- daily_metrics.rs20_vs_mkt 컬럼 하나를 뷰 체인에 추가로 노출만 합니다
-- (계산 로직·저장 스케줄은 전혀 바뀌지 않습니다 — 이미 매일 계산되고 있음).
--
-- 신고가/전고점 조건과 달리 절대 가격 위치를 보지 않으므로, 아직 신고가를
-- 찍지 못했더라도 "바닥권에서 시장 평균보다 먼저 반등하기 시작한" 종목을
-- 조건 스크리너에서 걸러낼 수 있게 됩니다.
--
-- 28_sector_override.sql(v_sector_stocks/v_screener/v_stock_summary 최신
-- 버전) + 37_daily_program_table.sql(v_screener에 pgtr_net_amt 추가) 이후
-- 최신 상태를 그대로 유지하면서 rs20_vs_mkt 한 줄만 추가한 것입니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행. drop cascade로 지워지는
--   뷰(v_screener/v_stock_summary/v_sector_stocks)를 전부 이 파일 안에서
--   다시 만들고 권한도 재부여하므로 그대로 실행하면 됩니다.
-- ============================================================================

drop view if exists v_screener cascade;
drop view if exists v_stock_summary cascade;
drop view if exists v_sector_stocks cascade;

-- ── STEP3 업종 구성 종목 (28_sector_override.sql 기준 + rs20_vs_mkt 추가) ────
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
       m.ma5, m.ma20, m.ma60, m.ma_aligned,
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

-- ── 조건 스크리너 (37_daily_program_table.sql 기준, 변경 없음 — v.*로 상속) ──
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

-- ── 종목 상세 헤더 요약 (28_sector_override.sql 기준, 변경 없음) ─────────────
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

-- ── anon(브라우저) 읽기 권한 재부여 (drop cascade로 지워졌으므로) ───────────
do $$
begin
  grant select on v_sector_stocks, v_screener, v_stock_summary to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인용 쿼리 (그대로 실행해서 결과 확인) ──────────────────────────────────
select code, name, trade_date, close, rs20_vs_mkt
from v_screener
where trade_date = (select max(trade_date) from v_screener)
order by rs20_vs_mkt desc nulls last
limit 10;
