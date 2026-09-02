-- ============================================================================
-- STOCK RADAR · v_screener/v_stock_summary에 ma120 노출 (56번 후속 수정)
-- ============================================================================
-- 56_daily_metrics_ma120.sql에서 v_sector_stocks만 create or replace로
-- 갱신하고 "v_screener/v_stock_summary는 v.*로 상속하니 자동으로 노출된다"고
-- 적었는데, 이건 틀렸습니다.
--
-- PostgreSQL은 `select v.*`를 뷰 생성/치환 시점에 그 순간의 실제 컬럼
-- 목록으로 "고정"해서 저장합니다(런타임에 매번 다시 펼치지 않음). 즉
-- v_sector_stocks에 ma120을 나중에 추가해도, 이미 만들어져 있던
-- v_screener/v_stock_summary는 그 시점 이전에 고정된 옛 컬럼 목록(ma120 없음)
-- 을 그대로 씁니다 — 그래서 v_screener?select=...,ma120 조회 시
-- "column v_screener.ma120 does not exist" 에러가 계속 나는 것이었습니다.
--
-- 해결: v.*를 쓰는 의존 뷰(v_screener, v_stock_summary)를 지금 다시
-- create or replace 해서, v_sector_stocks의 최신 컬럼 목록(ma120 포함)으로
-- 다시 펼쳐지게 합니다. 정의 자체는 51_screener_rs.sql과 동일 — 아무 로직도
-- 바뀌지 않았고 단지 재선언만 하는 것입니다.
--
-- 겸사겸사: 56번의 ALTER TABLE + 대량 UPDATE(compute.yml 재실행) 직후라
-- daily_metrics의 planner 통계가 오래됐을 수 있어 analyze도 같이 실행합니다
-- (안전하고 몇 초 내로 끝나는 작업입니다 — 혹시 v_sector_stocks에 ma120을
-- 필터 없이 조회했을 때 느려지는 문제가 있었다면 이걸로 해소됩니다).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

analyze daily_metrics;

create or replace view v_screener
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

create or replace view v_stock_summary
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
