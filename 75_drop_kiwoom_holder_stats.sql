-- ============================================================================
-- STOCK RADAR · 안 쓰는 kiwoom_holder_stats 정리
-- ============================================================================
-- kiwoom_holder_stats: 현재 0행, 정기 수집 파이프라인 없음(02_migrate.py에만
-- 일회성 INSERT 로직 존재, 어떤 GH Actions 워크플로도 호출 안 함).
-- daily_metrics.accounts_chg_20d_pct: 이 테이블에서만 계산되는 컬럼인데
-- 프론트엔드(web/index.html) 어디서도 안 쓰임(0회 참조).
-- 05_metrics.sql에서 이 컬럼을 채우던 UPDATE 블록은 먼저 제거했습니다.
--
-- 2026-09-23 최초 실행 시 발견: v_daily·v_data_coverage(둘 다 01_schema.sql,
-- 초창기 설계) 뷰가 kiwoom_holder_stats에 의존해서 단순 DROP TABLE이 막혔음.
-- 확인 결과 둘 다 프론트엔드 미사용(0회 참조):
--   · v_daily — "매수후보·종목상세가 이 뷰 하나만 보면 됨"이라는 초기 설계
--     의도였으나, 실제로는 v_sector_stocks/v_screener/v_stock_summary로
--     완전히 대체됨. 그냥 삭제.
--   · v_data_coverage — 날짜별 적재 현황 점검용 운영 도구(SQL Editor에서
--     수동 확인용). 계속 쓸모 있어 kiwoom 조인만 빼고 재생성.
--
-- 다시 필요해지면 01_schema.sql·git 이력에서 정의 복구 가능합니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_daily;

drop view if exists v_data_coverage;
create view v_data_coverage as
select
  d.trade_date,
  count(*)                                         as price_rows,
  count(f.code)                                    as flow_rows,
  count(*) filter (where f.is_partial)             as partial_flow_rows,
  count(m.code)                                    as metrics_rows
from daily_price d
left join daily_flow          f on f.trade_date = d.trade_date and f.code = d.code
left join daily_metrics       m on m.trade_date = d.trade_date and m.code = d.code
group by d.trade_date
order by d.trade_date desc;

comment on view v_data_coverage is '날짜별 적재 현황. 마이그레이션·수집 후 여기부터 확인 (2026-09-23: kiwoom_holder_stats 컬럼 제거됨)';

alter table daily_metrics drop column if exists accounts_chg_20d_pct;
drop table if exists kiwoom_holder_stats;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_name = 'kiwoom_holder_stats')             as table_still_exists,
  (select count(*) from information_schema.columns
    where table_name = 'daily_metrics'
      and column_name = 'accounts_chg_20d_pct')            as column_still_exists,
  (select count(*) from information_schema.views
    where table_name = 'v_daily')                          as v_daily_still_exists,
  (select count(*) from information_schema.views
    where table_name = 'v_data_coverage')                  as v_data_coverage_recreated;
