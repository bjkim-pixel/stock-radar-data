-- ============================================================================
-- STOCK RADAR · ETF 상세 페이지용 데이터 (2026-11-14)
--   etf_info            : ETF당 1행 — 유형·기초지수·운용사·NAV·괴리율·순자산·상장좌수·구성종목 수 (매일 덮어씀)
--   etf_holdings_now    : 최신 구성종목 상위 30 (KIS 제공 한도) — ETF별로 매일 교체
--   etf_holdings_weekly : 관리 액티브(etf_master.watch_grp 있음) 주간 스냅샷 상위 20 — 주의 마지막 영업일 값만 남김
--   etf_dividends       : ETF 분배금(예탁원)
-- 161_etf_detail_collect.py 가 실행될 때마다 먼저 실행(idempotent).
-- ============================================================================
create table if not exists etf_info (
  code        text primary key,
  as_of       date,
  etf_type    text,          -- KIS bstp_kor_isnm (예: ETF(Active/수익증권))
  div_name    text,          -- 수익증권형 등
  idx_name    text,          -- 기초지수
  mgr         text,          -- 운용사
  mult        numeric(6,2),  -- 추적배수(레버리지 2, 인버스 -1/-2)
  div_cycle   int,           -- 분배 주기 코드
  list_date   date,
  nav         numeric(14,2),
  dprt        numeric(8,2),  -- 괴리율 %
  ntas_eok    numeric(14,1), -- 순자산총액(억원)
  listed      bigint,        -- 상장좌수
  cfg_cnt     int,           -- 구성종목 수
  cu_unit     bigint,        -- CU 단위 좌수
  updated_at  timestamptz default now()
);
create table if not exists etf_holdings_now (
  etf_code    text not null,
  rank        smallint,
  stock_code  text not null,
  stock_name  text,
  cu_qty      numeric(18,2), -- CU(설정단위)당 보유 수량
  shares      numeric(20,0), -- 전체 보유 수량 추정 = cu_qty × 상장좌수 ÷ CU단위
  amount      numeric(20,0), -- 평가금액(원) = shares × 현재가
  weight      numeric(8,3),  -- 비중 %
  price       numeric(14,2),
  chg_pct     numeric(8,2),
  as_of       date,
  primary key (etf_code, stock_code)
);
create table if not exists etf_holdings_weekly (
  week_date   date not null, -- 그 주의 마지막 영업일(수집 기준일)
  etf_code    text not null,
  rank        smallint,
  stock_code  text not null,
  stock_name  text,
  cu_qty      numeric(18,2),
  shares      numeric(20,0),
  amount      numeric(20,0),
  weight      numeric(8,3),
  primary key (week_date, etf_code, stock_code)
);
create index if not exists idx_etf_hw_stock on etf_holdings_weekly (stock_code, week_date desc);
create index if not exists idx_etf_hw_etf on etf_holdings_weekly (etf_code, week_date desc);
create table if not exists etf_dividends (
  code        text not null,
  record_date date not null,
  dps         numeric(14,2), -- 1좌당 분배금(원)
  rate        numeric(8,2),  -- 분배율 %
  pay_date    date,
  primary key (code, record_date)
);
do $$
declare t text;
begin
  foreach t in array array['etf_info','etf_holdings_now','etf_holdings_weekly','etf_dividends'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
    begin
      execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', t);
    exception when others then null;
    end;
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

-- 2026-11-15: ETF 허브(액티브/패시브) 페이지용 일간 기록 ---------------------------------
-- etf_holdings_daily : 액티브 ETF(etf_master.mgmt='액티브') 일별 구성종목 상위 30 — 신규편입·편출·주식수변동 계산용. 120일 보관
-- etf_flow_daily     : 전 ETF 일별 상장좌수·순자산·NAV — 설정/환매(자금 유출입) 계산용. 400일 보관
create table if not exists etf_holdings_daily (
  d           date not null,
  etf_code    text not null,
  rank        smallint,
  stock_code  text not null,
  stock_name  text,
  cu_qty      numeric(18,2),
  shares      numeric(20,0),
  amount      numeric(20,0),
  weight      numeric(8,3),
  primary key (d, etf_code, stock_code)
);
create index if not exists idx_etf_hd_stock on etf_holdings_daily (stock_code, d desc);
create table if not exists etf_flow_daily (
  d         date not null,
  etf_code  text not null,
  listed    bigint,
  ntas_eok  numeric(14,1),
  nav       numeric(14,2),
  primary key (d, etf_code)
);
alter table etf_holdings_daily enable row level security;
alter table etf_flow_daily enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='etf_holdings_daily' and policyname='public read') then
    create policy "public read" on etf_holdings_daily for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename='etf_flow_daily' and policyname='public read') then
    create policy "public read" on etf_flow_daily for select using (true); end if;
end $$;
grant select on etf_holdings_daily, etf_flow_daily to anon, authenticated;
