-- ============================================================================
-- STOCK RADAR · 매매 보안 기반 2/2 — 데이터 읽기를 "로그인한 주인"에게만 허용
-- ============================================================================
-- 실행 순서(중요): ① 160_trade_security(대상 trade_security) → ② 사이트에 로그인 되는지 확인 → ③ 이 파일(대상 lock_data)
-- 되돌리기: 161_unlock_data.sql (대상 unlock_data) — 예전처럼 anon 키로 읽을 수 있게 복구
--
-- 하는 일 (public 스키마, 지금 anon 이 읽을 수 있는 테이블·뷰만 대상)
--   · anon 의 SELECT 권한을 회수 → 로그인 없는 요청은 401
--   · authenticated 에 SELECT 부여 + RLS 정책 "read_owner"(주인만) 로 교체 (is_owner() 는 쿼리당 1번만 계산)
--   · public 스키마의 함수(RPC) 실행 권한도 anon/PUBLIC 에서 회수, authenticated 에만 부여
--   · 이미 anon 이 못 읽던 테이블(access_log·trade_audit·kis_token_cache 등)은 건드리지 않음
-- 영향 없음: relay-server(service_role)·GitHub Actions(DB 직접 접속)는 이 권한과 무관하게 동작
-- ============================================================================
-- 되돌리기용: 이번에 anon 읽기를 막은 개체 목록(비공개 테이블 — anon/authenticated 권한 없음)
create table if not exists public._anon_lock_list (relname text primary key, relkind "char" not null);
alter table public._anon_lock_list enable row level security;
revoke all on public._anon_lock_list from anon, authenticated;

do $$
declare r record;
begin
  for r in
    select c.relname, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
      and has_table_privilege('anon', c.oid, 'SELECT')
  loop
    insert into public._anon_lock_list values (r.relname, r.relkind) on conflict (relname) do nothing;
    execute format('grant select on public.%I to authenticated', r.relname);
    execute format('revoke select on public.%I from anon', r.relname);
    if r.relkind in ('r','p') then
      execute format('alter table public.%I enable row level security', r.relname);
      execute format('drop policy if exists "read_only_anon" on public.%I', r.relname);
      execute format('drop policy if exists "read_owner" on public.%I', r.relname);
      execute format('create policy "read_owner" on public.%I for select to authenticated using ((select public.is_owner()))', r.relname);
      -- 제한(RESTRICTIVE) 정책: 예전부터 있던 다른 읽기 정책(예: to public using (true))이 남아 있어도
      -- 반드시 이 조건과 AND 로 묶이므로, 주인이 아닌 로그인 계정은 어떤 정책으로도 읽을 수 없음
      execute format('drop policy if exists "owner_only" on public.%I', r.relname);
      execute format('create policy "owner_only" on public.%I as restrictive for select to authenticated using ((select public.is_owner()))', r.relname);
    end if;
  end loop;
end $$;

-- 이미 잠근 뒤 다시 실행하는 경우(anon 권한이 이미 없어 위 반복에서 빠짐): 기록된 테이블에 제한 정책 보강
do $$
declare r record;
begin
  for r in select relname from public._anon_lock_list where relkind in ('r','p') loop
    if to_regclass(format('public.%I', r.relname)) is null then continue; end if;
    execute format('drop policy if exists "owner_only" on public.%I', r.relname);
    execute format('create policy "owner_only" on public.%I as restrictive for select to authenticated using ((select public.is_owner()))', r.relname);
  end loop;
end $$;

revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- 앞으로 만드는 테이블도 anon 읽기 기본 차단
alter default privileges in schema public revoke select on tables from anon;

-- ── 확인(비어 있어야 정상): 아직 anon 이 읽을 수 있는 테이블·뷰 ──
select c.relname as still_readable_by_anon
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p','v','m') and has_table_privilege('anon', c.oid, 'SELECT');
