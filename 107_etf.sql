-- ============================================================================
-- STOCK RADAR · ETF 유니버스(2026-11-02 확정 101개) + 일봉
-- ============================================================================
--   etf_master : 종목당 1행 — 분야/세부분야/업종태그/국가/운용(액티브·패시브)/특성 + 최신 시가총액
--   etf_daily  : 일봉(시가·고가·저가·종가·거래량·거래대금) — 2025-09-01부터
-- 107_etf_collect.py 가 실행될 때마다 이 파일을 먼저 실행합니다(idempotent). 용량: 101종목 × 약 290일 ≈ 4MB.
-- ============================================================================
create table if not exists etf_master (
  code        text primary key,
  name        text not null,
  field       text,            -- 분야: 국내 업종·테마 / 국가별(해외주식) / 인버스·레버리지 / 원자재 ...
  subfield    text,            -- 세부분야
  tags        text,            -- 업종태그
  country     text,
  mgmt        text,            -- 액티브 | 패시브
  flags       text,            -- 합성/선물/환헤지(H)/레버리지/인버스 ...
  mcap_eok    numeric(14,1),   -- 시가총액(억원), 최신
  as_of       date,
  updated_at  timestamptz default now()
);

create table if not exists etf_daily (
  code        text not null,
  trade_date  date not null,
  open        numeric(14,2),
  high        numeric(14,2),
  low         numeric(14,2),
  close       numeric(14,2),
  volume      bigint,
  amount      bigint,          -- 거래대금(원)
  primary key (code, trade_date)
);
create index if not exists idx_etf_daily_date on etf_daily (trade_date desc);

-- RLS: 읽기만 공개 (78번 원칙)
do $$
declare t text;
begin
  foreach t in array array['etf_master','etf_daily'] loop
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
