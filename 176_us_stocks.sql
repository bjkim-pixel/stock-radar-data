-- 해외(미국·홍콩·일본·중국) 종목·ETF 상세용 테이블 3개 (2026-11-27). 쓰기는 Actions(176_us_collect.py)만.
-- 읽기는 다른 시장 데이터와 같게(데이터 잠금 후엔 로그인한 주인만). 여러 번 실행해도 안전.
create table if not exists public.us_master (
  code           text primary key,           -- 표시 티커(BRK.B, 0700.HK 등)
  kis_excd       text not null,              -- KIS 거래소(NAS NYS AMS HKS TSE SHS SZS)
  kis_sym        text not null,              -- KIS 호출용 심볼(BRK/B, 00700 등)
  name_en        text,
  name_ko        text,
  is_etf         boolean not null default false,
  ccy            text,                       -- 거래 통화(USD HKD JPY CNY)
  sector         text,                       -- KIS 업종명(ETF는 비어 있음)
  listed_shares  bigint,
  last           numeric,
  base           numeric,                    -- 전일 종가
  h52p numeric, h52d date, l52p numeric, l52d date,
  per numeric, pbr numeric, eps numeric, bps numeric,
  mkt_cap        numeric,                    -- 시가총액(거래통화)
  krw_rate       numeric,                    -- 원화 환율(거래통화 1단위당 원)
  updated_at     timestamptz not null default now()
);
create table if not exists public.us_daily (
  code        text not null,
  trade_date  date not null,
  open numeric, high numeric, low numeric, close numeric,
  volume      bigint, amount numeric, change_pct numeric,
  listed_shares bigint,
  weight_per_share numeric(18,10) generated always as (
    case when listed_shares > 0 then change_pct * volume::numeric / listed_shares end) stored,
  primary key (code, trade_date)
);
create index if not exists us_daily_date on public.us_daily (trade_date desc);
create table if not exists public.us_rights (
  code        text not null,
  base_date   date not null,                 -- 배당 기준일
  rght_type   text not null default '03',    -- 03 = 배당
  cash_per_share numeric,
  ccy         text,
  primary key (code, base_date, rght_type)
);
do $$
declare t text;
begin
  foreach t in array array['us_master','us_daily','us_rights'] loop
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
