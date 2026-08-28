-- ============================================================================
-- STOCK RADAR · sector_override 테이블 RLS 누락 수정
-- ============================================================================
-- 증상: 시장 매크로(STEP1, v_sector_rank ← sector_daily)에는 새 테마(K-컬처
-- 등)가 정상 반영됐는데, 종목 후보(v_screener)·종목 상세 등 브라우저가
-- 직접 조회하는 화면에서는 여전히 옛 KRX 29분류(예: 화학)로 보이는 문제.
--
-- 원인: 01_schema.sql은 stocks/daily_price 등 기존 테이블마다
--   alter table ... enable row level security;
--   create policy "public read" ... for select using (true);
-- 를 명시적으로 걸어뒀는데, 28_sector_override.sql에서 새로 만든
-- sector_override 테이블에는 이 처리가 빠졌습니다.
--
-- sector_daily(v_sector_rank가 참조)는 05_compute.py가 서비스 롤(직접
-- Postgres 연결, RLS 우회)로 채우기 때문에 화면에 정상적으로 보였지만,
-- 브라우저는 anon 키로 PostgREST를 거쳐 v_stock_sector(security_invoker=true)
-- 체인을 그대로 타므로, sector_override에 RLS가 걸려 있고(또는 정책이
-- 없어) anon이 그 테이블의 행을 하나도 못 보면 LEFT JOIN이 전부 NULL로
-- 빠지고 coalesce(sector_override, sector_krx)가 항상 sector_krx로
-- fallback됩니다 — 에러 없이 조용히 옛 분류로 보이는 정확히 이 증상입니다.
--
-- v_stock_sector를 참조하는 모든 화면(v_sector_stocks/v_screener/
-- v_stock_summary/v_sector_flow/v_sector_flow_daily = 종목후보·종목상세·
-- STEP2/3/4 전부)이 이 한 테이블의 권한에 걸려 있으므로, 이 파일 하나로
-- 사이트 전체가 일관되게 고쳐집니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행. 데이터는 건드리지
--   않고 권한만 정리합니다.
-- ============================================================================

alter table sector_override enable row level security;

drop policy if exists "public read" on sector_override;
create policy "public read" on sector_override for select using (true);

grant select on sector_override to anon, authenticated;


-- ── 확인용 쿼리 (그대로 실행해서 결과 확인) ──────────────────────────────────
-- ① sector_override 테이블 자체에 K-컬처가 들어갔는지
select code, sector_override, note from sector_override
where code in ('161890','192820','278470');

-- ② 뷰 체인(anon 권한 그대로) 통과해서 K-컬처로 보이는지
select code, sector from v_stock_sector
where code in ('161890','192820','278470');
