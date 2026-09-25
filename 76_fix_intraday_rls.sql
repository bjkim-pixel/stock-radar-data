-- ============================================================================
-- STOCK RADAR · intraday_candidates / intraday_positions 보안 긴급 수정
-- ============================================================================
-- 2026-09-25 Supabase Advisor에서 발견: 이 두 테이블에 RLS가 꺼져 있는 채로
-- anon(공개 키, 브라우저 어디서든 볼 수 있음) 롤에 INSERT/UPDATE/DELETE/
-- TRUNCATE까지 전부 열려 있었습니다 — 즉 anon 키를 아는 누구든 이 두 테이블을
-- 지우거나 조작할 수 있는 상태였습니다.
--
-- 확인 결과 relay-server(server.js)의 실제 쓰기(sbWrite/sbWriteReturning)는
-- SUPABASE_SERVICE_KEY(비공개)만 쓰고, anon 키는 읽기(sbGet)에만 씁니다.
-- service_role은 RLS를 무시하고 항상 전체 접근이 가능하므로, 아래처럼
-- anon/authenticated의 쓰기 권한을 없애고 읽기만 허용해도 relay-server의
-- 실제 동작(포지션 진입/청산 기록)에는 영향이 없습니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

-- 위험한 쓰기 권한부터 제거 (RLS를 켜기 전에 먼저 — 순서 안전장치)
revoke insert, update, delete, truncate, trigger, references
  on public.intraday_candidates
  from anon, authenticated;

revoke insert, update, delete, truncate, trigger, references
  on public.intraday_positions
  from anon, authenticated;

-- RLS 활성화
alter table public.intraday_candidates enable row level security;
alter table public.intraday_positions  enable row level security;

-- anon/authenticated는 읽기만 허용 (화면 표시용)
drop policy if exists "read_only_anon"  on public.intraday_candidates;
create policy "read_only_anon" on public.intraday_candidates
  for select
  to anon, authenticated
  using (true);

drop policy if exists "read_only_anon" on public.intraday_positions;
create policy "read_only_anon" on public.intraday_positions
  for select
  to anon, authenticated
  using (true);

-- ── 확인 ──────────────────────────────────────────────────────────────────
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema='public' and grantee in ('anon','authenticated')
  and table_name in ('intraday_positions','intraday_candidates')
order by table_name, grantee, privilege_type;
