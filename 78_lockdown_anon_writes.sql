-- ============================================================================
-- STOCK RADAR · 프로젝트 전체 anon 쓰기 권한 긴급 잠금
-- ============================================================================
-- 2026-09-26 확인: public 스키마의 테이블 17개 전부(뷰 제외)에 anon/
-- authenticated 롤이 SELECT뿐 아니라 INSERT/UPDATE/DELETE/TRUNCATE까지 갖고
-- 있었습니다. anon 키는 web/index.html에 그대로 노출되는 공개 키라, 이론상
-- 누구나 daily_price/daily_flow/stocks 등 핵심 데이터를 지우거나 조작할 수
-- 있는 상태였습니다. 76·77번 마이그레이션에서 intraday_* 6개만 먼저
-- 고쳤는데, 확인해보니 사실상 프로젝트 전체가 같은 상태였습니다.
--
-- 안전성 확인 완료:
--   · 프론트엔드(web/index.html)는 Supabase에 직접 쓰는 코드가 전혀 없음
--     (유일한 POST는 relay-server 자체 API로 가는 push 구독 요청)
--   · relay-server(server.js)의 실제 쓰기(sbWrite/sbWriteReturning)는 전부
--     SUPABASE_SERVICE_KEY(RLS 우회)만 씀 — anon 아님
--   · GitHub Actions의 모든 파이썬 스크립트는 SUPABASE_DB_URL로 직접 접속
--     (psycopg2) — PostgREST의 anon/authenticated 롤과 완전히 별개라 이
--     권한 변경과 무관
-- → 아래처럼 잠가도 정상 동작에 영향 없음.
--
-- 테이블은 동적으로(pg_tables) 순회해서 하나도 빠짐없이 처리하고, 앞으로
-- 새로 만드는 테이블에도 기본으로 이 원칙이 적용되도록 ALTER DEFAULT
-- PRIVILEGES도 같이 설정합니다(같은 실수 재발 방지).
--
-- ⚠ 이미 76/77번에서 RLS+정책을 걸어둔 intraday_* 6개 테이블도 이 스크립트가
--   다시 훑고 지나가지만, revoke는 이미 없는 권한을 다시 빼는 것뿐이고
--   정책도 drop-then-create라 안전하게 중복 실행됩니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행. 테이블 수가 많아 몇 초
--   걸릴 수 있습니다.
-- ============================================================================

do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated',
      t.tablename);
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('drop policy if exists "read_only_anon" on public.%I', t.tablename);
    execute format(
      'create policy "read_only_anon" on public.%I for select to anon, authenticated using (true)',
      t.tablename);
  end loop;
end $$;

-- 뷰는 RLS 대상이 아님(RLS는 테이블에만 적용) — 쓰기 권한만 제거
do $$
declare
  v record;
begin
  for v in select viewname from pg_views where schemaname = 'public'
  loop
    execute format(
      'revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated',
      v.viewname);
  end loop;
end $$;

-- 앞으로 새로 만드는 테이블은 기본적으로 anon/authenticated에 쓰기 권한이
-- 안 생기도록. (기존 테이블엔 소급 적용 안 됨 — 위 do 블록이 그 몫을 함)
alter default privileges in schema public
  revoke insert, update, delete, truncate, trigger, references
  on tables from anon, authenticated;

-- ── 확인: 아직도 쓰기 권한이 남은 테이블이 있으면 여기 나옵니다(비어있어야 정상) ──
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name, grantee, privilege_type;
