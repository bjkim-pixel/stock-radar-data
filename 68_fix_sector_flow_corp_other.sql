-- ============================================================================
-- STOCK RADAR · v_sector_flow_daily 기타법인(corp_other) 컬럼 누락 수정
-- ============================================================================
-- 31_flow_subj_individual_corp.sql이 daily_flow.corp_other_net 컬럼 추가와
-- 함께 v_stock_chart(종목상세)·v_market_overview(STEP1)에는 corp_other_net/
-- corp_other_cum을 정상 반영했는데, 같은 파일 4)번 항목인 v_sector_flow_daily
-- (STEP2/업종동향 — 업종별 누적 수급) 재정의만 실제 운영 DB에는 반영이 안 된
-- 상태였습니다(2026-09-11, 업종동향 페이지 신설 중 발견 — v_sector_flow_daily
-- select * 결과에 corp_other_net/corp_other_cum 컬럼 자체가 없었음. daily_flow.
-- corp_other_net·v_stock_chart.corp_other_cum은 이미 정상 존재/작동 확인됨).
--
-- 이 파일은 31_flow_subj_individual_corp.sql의 4)번 블록(v_sector_flow_daily
-- 재정의)만 그대로 다시 실행합니다 — 다른 뷰·테이블은 전혀 건드리지 않습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 (05_metrics.sql/17_migrate_v4.py 등
--   백엔드 스크립트 수정·재배포 필요 없음 — 뷰만 재생성하면 프론트는 이미
--   corp_other_cum을 참조하도록 배포돼 있어 즉시 반영됩니다)
-- ============================================================================

drop view if exists v_sector_flow_daily cascade;
create view v_sector_flow_daily
with (security_invoker = true) as
with d as (
  select vs.sector, fl.trade_date,
         sum(fl.foreign_net)     as foreign_net,
         sum(fl.inst_net)        as inst_net,
         sum(fl.fin_inv_net)     as fin_inv_net,
         sum(fl.inv_trust_net)   as inv_trust_net,
         sum(fl.pension_net)     as pension_net,
         sum(fl.pe_net)          as pe_net,
         sum(fl.individual_net)  as individual_net,
         sum(fl.corp_other_net)  as corp_other_net
  from daily_flow fl
  join stocks s on s.code = fl.code and s.security_type = 'STOCK'
  join v_stock_sector vs on vs.code = fl.code and vs.sector is not null
  where fl.trade_date >= '2025-09-01'
  group by vs.sector, fl.trade_date
)
select sector, trade_date, foreign_net, inst_net, fin_inv_net, inv_trust_net,
       pension_net, pe_net, individual_net, corp_other_net,
       sum(foreign_net)     over w as foreign_cum,
       sum(inst_net)        over w as inst_cum,
       sum(fin_inv_net)     over w as fin_inv_cum,
       sum(inv_trust_net)   over w as inv_trust_cum,
       sum(pension_net)     over w as pension_cum,
       sum(pe_net)          over w as pe_cum,
       sum(individual_net)  over w as individual_cum,
       sum(corp_other_net)  over w as corp_other_cum
from d
window w as (partition by sector order by trade_date rows unbounded preceding);

-- anon(브라우저) 읽기 권한 재부여 (drop cascade로 지워졌으므로)
do $$
begin
  grant select on v_sector_flow_daily to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
-- corp_other_cum 컬럼이 이제 존재하고 값이 채워지는지 확인 (NULL이 아니어야 함)
select sector, trade_date, corp_other_net, corp_other_cum
from v_sector_flow_daily
order by trade_date desc
limit 5;
