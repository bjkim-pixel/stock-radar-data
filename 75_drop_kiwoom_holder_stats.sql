-- ============================================================================
-- STOCK RADAR · 안 쓰는 kiwoom_holder_stats 정리
-- ============================================================================
-- kiwoom_holder_stats: 현재 0행, 정기 수집 파이프라인 없음(02_migrate.py에만
-- 일회성 INSERT 로직 존재, 어떤 GH Actions 워크플로도 호출 안 함).
-- daily_metrics.accounts_chg_20d_pct: 이 테이블에서만 계산되는 컬럼인데
-- 프론트엔드(web/index.html) 어디서도 안 쓰임(0회 참조).
-- 05_metrics.sql에서 이 컬럼을 채우던 UPDATE 블록은 먼저 제거했습니다.
--
-- 다시 필요해지면 01_schema.sql·git 이력에서 정의 복구 가능합니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

alter table daily_metrics drop column if exists accounts_chg_20d_pct;
drop table if exists kiwoom_holder_stats;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_name = 'kiwoom_holder_stats')             as table_still_exists,
  (select count(*) from information_schema.columns
    where table_name = 'daily_metrics'
      and column_name = 'accounts_chg_20d_pct')            as column_still_exists;
