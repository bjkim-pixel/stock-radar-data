-- 반도체 추종 페이지(2026-11-25): KRX OpenAPI 선물 일별매매정보 → 코스피200 선물·삼성전자·SK하이닉스 주식선물의 종가·고저·거래량·미결제약정
-- 쓰기는 Actions(180_semi_collect.py)만, 읽기는 다른 시장 데이터와 같게(데이터 잠금 후엔 로그인한 주인만).
create table if not exists public.krx_fut_daily (
  trade_date date not null,
  sym        text not null,               -- K200(코스피200 선물) | SEC(삼성전자 선물) | HYX(SK하이닉스 선물) — 정규장 거래량 최대 월물(보통 최근월)
  isu_nm     text,
  close      numeric,
  chg        numeric,                     -- 전일 대비
  open       numeric,
  high       numeric,
  low        numeric,
  spot       numeric,                     -- 기초자산(현물) 가격
  vol        bigint,
  amt        numeric,
  oi         bigint,                      -- 미결제약정(계약)
  updated_at timestamptz not null default now(),
  primary key (trade_date, sym)
);
create index if not exists krx_fut_daily_sym on public.krx_fut_daily (sym, trade_date desc);
do $$
begin
  alter table public.krx_fut_daily enable row level security;
  revoke insert, update, delete, truncate, trigger, references on public.krx_fut_daily from anon, authenticated;
  drop policy if exists "public read" on public.krx_fut_daily;
  drop policy if exists "read_owner" on public.krx_fut_daily;
  if to_regprocedure('public.is_owner()') is not null and exists (select 1 from pg_class where relname = '_anon_lock_list' and relnamespace = 'public'::regnamespace) then
    revoke select on public.krx_fut_daily from anon;
    grant select on public.krx_fut_daily to authenticated;
    create policy "read_owner" on public.krx_fut_daily for select to authenticated using ((select public.is_owner()));
    insert into public._anon_lock_list values ('krx_fut_daily', 'r') on conflict (relname) do nothing;
  else
    grant select on public.krx_fut_daily to anon, authenticated;
    create policy "public read" on public.krx_fut_daily for select using (true);
  end if;
end $$;
notify pgrst, 'reload schema';
