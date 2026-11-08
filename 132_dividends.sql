-- 132_dividends.sql — 종목별 배당 확정 일정(KIS 예탁원) + 네이버 연간 예상 주당배당금(stock_earnings.dps). 단위: 원.
-- 쓰기는 Actions(서비스 DB URL)만, 읽기 공개. 여러 번 실행해도 안전.
create table if not exists stock_dividends (
  code        text    not null,
  record_date date    not null,           -- 배당 기준일
  divi_kind   text    not null,           -- 결산 / 분기 / 중간 …
  dps         numeric not null,           -- 주당배당금(원)
  pay_date    date,                       -- 지급일(미정이면 null)
  stk_kind    text,                       -- 보통 / 우선
  updated_at  timestamptz not null default now(),
  primary key (code, record_date, divi_kind)
);
alter table stock_earnings add column if not exists dps numeric;   -- 네이버 주당배당금(예상 연간 포함)
do $$
begin
  alter table public.stock_dividends enable row level security;
  drop policy if exists "public read" on public.stock_dividends;
  create policy "public read" on public.stock_dividends for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.stock_dividends from anon, authenticated;
    grant select on public.stock_dividends to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;
