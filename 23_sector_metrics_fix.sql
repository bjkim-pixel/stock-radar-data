-- ============================================================================
-- STOCK RADAR · STEP2 섹터 지표 수정
-- ============================================================================
-- 1) v_sector_rank.amt_chg_1w_pct(주간증감) 로직 수정
--    기존: lag(total_amount, 5) — "5거래일 전 '하루' 거래대금" 대비 오늘 '하루'
--          거래대금 비교였습니다(그래서 거의 항상 마이너스로 보였음).
--    수정: 최근 5거래일 거래대금 "합계" ÷ 이전 5거래일 거래대금 "합계".
--
-- 2) 신규 뷰 v_sector_flow_daily — 업종별 일별 수급주체 순매수(+누적, 2025-09-01~)
--    STEP2 사이드 "업종 수급주체" 카드를 기간 누적 라인차트로 바꾸기 위한 소스.
--
-- ⚠ v_sector_rank를 cascade로 지우면 v_screener도 같이 지워지므로,
--   이 파일 안에서 v_screener까지 함께 재생성합니다 (22_screener_columns.sql의
--   최신 정의와 동일 — v_sector_stocks 쪽은 이 파일에서 건드리지 않습니다).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

drop view if exists v_screener cascade;
drop view if exists v_sector_rank cascade;

create view v_sector_rank
with (security_invoker = true) as
with base as (
  select trade_date, sector, total_amount, avg_change_pct, stock_count, rs20, rs_rank,
         foreign_net, inst_net, smart_net,
         sum(total_amount) over (partition by sector order by trade_date
                                 rows between 4 preceding and current row)     as amt_5d,
         sum(total_amount) over (partition by sector order by trade_date
                                 rows between 9 preceding and 5 preceding)     as amt_prev5d,
         avg(total_amount) over (partition by sector order by trade_date
                                 rows between 19 preceding and current row)    as amt_ma20
  from sector_daily
  where market = 'ALL'
),
latest as (select max(trade_date) as d from base)
select b.trade_date,
       b.sector,
       b.total_amount,
       round(b.total_amount::numeric / nullif(sum(b.total_amount) over (), 0) * 100, 2) as share_pct,
       b.amt_5d,
       b.amt_prev5d,
       case when b.amt_prev5d > 0
            then round((b.amt_5d - b.amt_prev5d)::numeric / b.amt_prev5d * 100, 2) end   as amt_chg_1w_pct,
       case when b.amt_ma20 > 0
            then round(b.total_amount::numeric / b.amt_ma20 * 100, 1) end               as amt_vs_ma20_pct,
       b.avg_change_pct,
       b.rs20,
       b.rs_rank,
       b.stock_count,
       b.foreign_net,
       b.inst_net,
       b.smart_net
from base b, latest l
where b.trade_date = l.d
order by b.total_amount desc;

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

-- ── STEP2 사이드 "업종 수급주체" 카드 소스: 업종 × 일별 수급 + 누적(2025-09-01~) ──
drop view if exists v_sector_flow_daily cascade;
create view v_sector_flow_daily
with (security_invoker = true) as
with d as (
  select s.sector_krx as sector, fl.trade_date,
         sum(fl.foreign_net)    as foreign_net,
         sum(fl.inst_net)       as inst_net,
         sum(fl.fin_inv_net)    as fin_inv_net,
         sum(fl.inv_trust_net)  as inv_trust_net,
         sum(fl.pension_net)    as pension_net,
         sum(fl.pe_net)         as pe_net,
         sum(fl.individual_net) as individual_net
  from daily_flow fl
  join stocks s on s.code = fl.code and s.security_type = 'STOCK' and s.sector_krx is not null
  where fl.trade_date >= '2025-09-01'
  group by s.sector_krx, fl.trade_date
)
select sector, trade_date, foreign_net, inst_net, fin_inv_net, inv_trust_net,
       pension_net, pe_net, individual_net,
       sum(foreign_net)    over w as foreign_cum,
       sum(inst_net)       over w as inst_cum,
       sum(fin_inv_net)    over w as fin_inv_cum,
       sum(inv_trust_net)  over w as inv_trust_cum,
       sum(pension_net)    over w as pension_cum,
       sum(pe_net)         over w as pe_cum,
       sum(individual_net) over w as individual_cum
from d
window w as (partition by sector order by trade_date rows unbounded preceding);

do $$
begin
  grant select on v_sector_rank, v_screener, v_sector_flow_daily to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
