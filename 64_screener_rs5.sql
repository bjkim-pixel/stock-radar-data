-- ============================================================================
-- STOCK RADAR · 조건 스크리너/오늘의 종목 화면에 개별RS5 + 백분위 노출
-- ============================================================================
-- 배경: 63_rs5_and_percentile.sql이 daily_metrics에 rs5_vs_mkt(개별RS 5일
-- 버전)·rs20_pctl·rs5_pctl(둘 다 그날 유니버스 내 0~100 백분위 환산값)을
-- 추가했습니다. 이 파일은 그 3개 컬럼을 v_sector_stocks/v_screener 뷰
-- 체인에 노출만 합니다(계산 로직은 05_metrics.sql, 저장 스케줄도 그대로).
--
-- 51_screener_rs.sql(rs20_vs_mkt 노출) 이후 최신 상태를 그대로 유지하면서
-- rs5_vs_mkt/rs20_pctl/rs5_pctl 세 줄만 추가한 것입니다.
--
-- ⚠ 실행 순서: 63_rs5_and_percentile.sql(컬럼 추가) → 05_metrics.sql이 포함된
--   compute 배치 최소 1회 실행(과거분 채우기) → 이 파일(뷰 노출) 순으로
--   실행하세요. 이 파일만 먼저 실행해도 에러는 안 나지만(컬럼이 있으면
--   되므로), 배치가 아직 안 돌았으면 rs5_vs_mkt/rs20_pctl/rs5_pctl이
--   당분간 NULL로 보입니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행. drop cascade로 지워지는
--   뷰(v_screener/v_stock_summary/v_sector_stocks)를 전부 이 파일 안에서
--   다시 만들고 권한도 재부여하므로 그대로 실행하면 됩니다.
-- ============================================================================

drop view if exists v_screener cascade;
drop view if exists v_stock_summary cascade;
drop view if exists v_sector_stocks cascade;

-- ── STEP3 업종 구성 종목 (51_screener_rs.sql 기준 + rs5_vs_mkt/rs20_pctl/rs5_pctl 추가) ──
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
       -- 개별RS 5일 버전(원시 %p) — 계산 방식은 rs20_vs_mkt와 동일, 창만 5거래일
       m.rs5_vs_mkt,
       -- 개별RS를 그날 유니버스 내 0~100 백분위로 환산한 값(100=최상위) — 화면
       -- 표시는 원시 %p 대신 이 값을 기본으로 씁니다("상위 N%" 식으로 해석 가능)
       m.rs20_pctl,
       m.rs5_pctl,
       case when p.high > p.low
            then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1) end as close_pos_pct
from daily_price p
join stocks s on s.code = p.code and s.security_type = 'STOCK'
join v_stock_sector vs on vs.code = p.code
left join daily_metrics m on m.trade_date = p.trade_date and m.code = p.code
where p.close > 0;

-- ── 조건 스크리너 (51_screener_rs.sql 기준, 변경 없음 — v.*로 상속) ──────────
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

-- ── 종목 상세 헤더 요약 (51_screener_rs.sql 기준, 변경 없음) ─────────────────
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
select code, name, trade_date, close, rs20_vs_mkt, rs20_pctl, rs5_vs_mkt, rs5_pctl
from v_screener
where trade_date = (select max(trade_date) from v_screener)
order by rs20_pctl desc nulls last
limit 10;
