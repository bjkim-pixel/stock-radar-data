-- 종목별 실적(확정)·예상실적(컨센서스). 단위: 매출액·영업이익·순이익 억원 / EPS·BPS 원 / ROE %.
-- 쓰기는 Actions(서비스 DB URL)만, 읽기 공개. freq: A=연간, Q=분기(단일 분기). period: 'YYYYMM'(결산월).
create table if not exists stock_earnings (
  code        text    not null,
  freq        text    not null,
  period      text    not null,
  is_est      boolean not null default false,   -- true = 컨센서스(예상)
  sales       numeric,
  op_profit   numeric,
  net_income  numeric,
  eps         numeric,
  bps         numeric,
  roe         numeric,
  src         text,
  updated_at  timestamptz not null default now(),
  primary key (code, freq, period)
);
do $$
begin
  alter table public.stock_earnings enable row level security;
  drop policy if exists "public read" on public.stock_earnings;
  create policy "public read" on public.stock_earnings for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.stock_earnings from anon, authenticated;
    grant select on public.stock_earnings to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;

alter table stock_earnings add column if not exists dps numeric;   -- 네이버 주당배당금(원, 예상 연간 포함)
