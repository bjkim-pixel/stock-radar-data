-- 미국 13F 공시(거장 포트폴리오) 테이블 4개 + 변동 뷰 (2026-11-28). 쓰기는 Actions(231_13f_collect.py)만. 여러 번 실행해도 안전.
create table if not exists public.f13_fund (
  cik        bigint primary key,
  name_ko    text not null,
  name_en    text,                 -- SEC 등록명
  manager    text,                 -- 대표 인물
  intro      text,                 -- 한 줄 소개
  style      text,                 -- 집중 / 중간 / 분산·퀀트 (최신 보유 종목 수 기준)
  sort_no    int,
  last_period date,
  last_filed  date,
  updated_at timestamptz not null default now()
);
create table if not exists public.f13_filing (
  cik         bigint not null,
  period      date   not null,     -- 기준 분기말
  filed       date,                -- 공시일
  acc         text,                -- 접수번호
  total_value numeric,             -- 주식 평가액 합계($, 옵션 제외)
  n_pos       int,
  unit_fixed  boolean default false,   -- 천 달러 단위로 제출된 값을 달러로 보정했는지
  primary key (cik, period)
);
create table if not exists public.f13_holding (
  cik     bigint not null,
  period  date   not null,
  cusip   text   not null,
  put_call text  not null default '',
  name    text,
  ticker  text,
  value   numeric,                 -- $
  shares  numeric,
  pct     numeric(8,4),            -- 주식 평가액 합계 대비 비중(%)
  primary key (cik, period, cusip, put_call)
);
create index if not exists f13_holding_cusip on public.f13_holding (cusip, period);
create index if not exists f13_holding_ticker on public.f13_holding (ticker, period) where ticker is not null;
create table if not exists public.f13_cusip (
  cusip   text primary key,
  ticker  text,
  name    text,
  sec_type text,
  src     text,
  tried_at timestamptz not null default now()
);
create or replace view public.v_f13_change as
with f as (select cik, period, lag(period) over (partition by cik order by period) as prev from public.f13_filing),
cur as (
  select c.cik, c.period, c.cusip, c.name, c.ticker, c.value, c.shares, c.pct,
         p.shares as sh_prev, p.value as val_prev, p.pct as pct_prev, f.prev,
         case when f.prev is null then 'base'
              when p.cusip is null then 'new'
              when c.shares >= p.shares * 1.2 then 'add'
              when c.shares <= p.shares * 0.8 then 'cut'
              else 'hold' end as act
  from public.f13_holding c
  join f on f.cik = c.cik and f.period = c.period
  left join public.f13_holding p on p.cik = c.cik and p.period = f.prev and p.cusip = c.cusip and p.put_call = c.put_call
  where c.put_call = ''
),
ex as (
  select p.cik, f.period, p.cusip, p.name, p.ticker, null::numeric as value, null::numeric as shares, null::numeric as pct,
         p.shares as sh_prev, p.value as val_prev, p.pct as pct_prev, f.prev, 'exit'::text as act
  from f
  join public.f13_holding p on p.cik = f.cik and p.period = f.prev and p.put_call = ''
  where not exists (select 1 from public.f13_holding c where c.cik = f.cik and c.period = f.period and c.cusip = p.cusip and c.put_call = '')
)
select * from cur union all select * from ex;
do $$
declare t text;
begin
  foreach t in array array['f13_fund','f13_filing','f13_holding','f13_cusip'] loop
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
-- 뷰도 같은 읽기 권한(잠금 중이면 로그인한 주인만)
do $$
begin
  if to_regprocedure('public.is_owner()') is not null and exists (select 1 from pg_class where relname = '_anon_lock_list' and relnamespace = 'public'::regnamespace) then
    revoke select on public.v_f13_change from anon; grant select on public.v_f13_change to authenticated;
    insert into public._anon_lock_list values ('v_f13_change', 'v') on conflict (relname) do nothing;
  else
    grant select on public.v_f13_change to anon, authenticated;
  end if;
end $$;
notify pgrst, 'reload schema';
