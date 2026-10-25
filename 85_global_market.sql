-- ============================================================================
-- STOCK RADAR · 글로벌 시황(미국·한국 업종/테마) 데이터
-- ============================================================================
-- 2026-10-25 신설. 업종동향 페이지 맨 위 "글로벌 시황" 카드용.
--
--   global_series_daily : 티커별 일별 종가 원본 (미국 ETF·한국 ETF·환율·등락종목수)
--   etf_holdings        : 한국 테마 ETF 상위 5개 보유종목 + 당일 등락률
--   global_pack         : 탭(US/KR)별 화면용 묶음 데이터 1행(JSON) — 페이지는 이 한 행만 읽음
--
-- 21_collect_global.py가 실행될 때마다 이 파일을 먼저 실행하므로(모두 idempotent)
-- Supabase SQL Editor에서 따로 실행할 필요는 없습니다.
-- 용량: 티커 약 85개 × 하루 1행 — 2025-09-01부터 백필해도 수 MB 수준.
-- ============================================================================

create table if not exists global_series_daily (
  symbol      text not null,          -- US:SPY · KR:091160 · FX:KRW · KRB:KOSPI_ADV ...
  trade_date  date not null,
  close       numeric(20,6),
  primary key (symbol, trade_date)
);

create table if not exists etf_holdings (
  etf_symbol  text not null,          -- KR:091160
  rank        int  not null,          -- 1~5 (비중 큰 순)
  stock_code  text,
  stock_name  text,
  weight      numeric(10,4),          -- 비중 %
  change_pct  numeric(10,4),          -- 기준일 등락률 %
  as_of       date,
  primary key (etf_symbol, rank)
);

alter table etf_holdings add column if not exists exch text;   -- 2026-10-25: 미국 보유종목 거래소

create table if not exists global_pack (
  tab         text primary key,       -- US | KR
  as_of       date,
  payload     jsonb,
  updated_at  timestamptz default now()
);

-- RLS: anon/authenticated는 읽기만 (78번 원칙). 쓰기는 psycopg2(GitHub Actions)만.
do $$
declare t text;
begin
  foreach t in array array['global_series_daily','etf_holdings','global_pack'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
    execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;
