-- 시장 상태 점수(2026-11-16, 자동매매 보강 E1): 날짜별 0~100점 · 4단계(공격/보통/보수/방어) · 지표별 값
-- 계산: 168_market_regime.py (GitHub Actions — 매일 계산 직후 + 수동 과거 채우기). 릴레이·사이트는 읽기만.
-- 읽기 권한: 다른 시장 데이터와 같게(데이터 잠금 후라면 로그인한 주인만). 쓰기는 DB 직접 접속(Actions)만.
create table if not exists public.market_regime (
  trade_date  date primary key,
  score       numeric(5,1) not null,
  stage       text not null,              -- attack | normal | caution | defense
  parts       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
do $$
begin
  alter table public.market_regime enable row level security;
  revoke insert, update, delete, truncate, trigger, references on public.market_regime from anon, authenticated;
  drop policy if exists "public read" on public.market_regime;
  drop policy if exists "read_owner" on public.market_regime;
  drop policy if exists "owner_only" on public.market_regime;
  if to_regprocedure('public.is_owner()') is not null and exists (select 1 from pg_class where relname = '_anon_lock_list' and relnamespace = 'public'::regnamespace) then
    -- 데이터 잠금(161)이 적용된 DB: 로그인한 주인만 읽기
    revoke select on public.market_regime from anon;
    grant select on public.market_regime to authenticated;
    create policy "read_owner" on public.market_regime for select to authenticated using ((select public.is_owner()));
    insert into public._anon_lock_list values ('market_regime', 'r') on conflict (relname) do nothing;
  else
    grant select on public.market_regime to anon, authenticated;
    create policy "public read" on public.market_regime for select using (true);
  end if;
end $$;

notify pgrst, 'reload schema';
