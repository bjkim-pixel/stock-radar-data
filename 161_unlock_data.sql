-- ============================================================================
-- STOCK RADAR · 161_lock_data_to_login 되돌리기 — 예전처럼 anon 키로 읽기 허용
-- ============================================================================
-- 실행: Actions "[수시] DB 테이블·뷰 생성" → 대상 unlock_data. 여러 번 실행해도 안전.
-- 잠글 때 기록해 둔 목록(_anon_lock_list)의 개체에만 anon 읽기를 되돌립니다.
-- ============================================================================
do $$
declare r record;
begin
  if to_regclass('public._anon_lock_list') is null then
    raise notice '잠금 기록(_anon_lock_list)이 없습니다 — 잠근 적이 없거나 이미 복구됨';
    return;
  end if;
  for r in select relname, relkind from public._anon_lock_list loop
    if to_regclass(format('public.%I', r.relname)) is null then continue; end if;
    execute format('grant select on public.%I to anon', r.relname);
    if r.relkind in ('r','p') then
      execute format('drop policy if exists "read_only_anon" on public.%I', r.relname);
      execute format('create policy "read_only_anon" on public.%I for select to anon, authenticated using (true)', r.relname);
      execute format('drop policy if exists "read_owner" on public.%I', r.relname);
    end if;
  end loop;
  drop table public._anon_lock_list;
end $$;

grant execute on all functions in schema public to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant select on tables to anon;
