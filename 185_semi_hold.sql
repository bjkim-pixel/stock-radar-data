-- 반도체 추종 2차(2026-11-25): 반도체 업종 종목의 외국인 보유율(소진율) 일별
-- 쓰기는 Actions(185_semi_hold.py)만, 읽기는 다른 시장 데이터와 같게.
create table if not exists public.semi_hold_daily (
  trade_date date not null, code text not null,
  frgn_ratio numeric,          -- 외국인 보유율(%) — KIS hts_frgn_ehrt / 네이버 foreignerHoldRatio
  frgn_net_qty bigint,         -- 외국인 순매수 수량(주, 있을 때만)
  src text,                    -- KIS | NAVER
  updated_at timestamptz not null default now(),
  primary key (trade_date, code)
);
do $$
declare t text;
begin
  foreach t in array array['semi_hold_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('drop policy if exists "read_owner" on public.%I', t);
    if to_regprocedure('public.is_owner()') is not null and exists (select 1 from pg_class where relname = '_anon_lock_list' and relnamespace = 'public'::regnamespace) then
      execute format('revoke select on public.%I from anon', t);
      execute format('grant select on public.%I to authenticated', t);
      execute format('create policy "read_owner" on public.%I for select to authenticated using ((select public.is_owner()))', t);
      execute format('insert into public._anon_lock_list values (%L, %L) on conflict (relname) do nothing', t, 'r');
    else
      execute format('grant select on public.%I to anon, authenticated', t);
      execute format('create policy "public read" on public.%I for select using (true)', t);
    end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
