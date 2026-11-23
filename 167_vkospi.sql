-- 코스피200 변동성지수(VKOSPI) 일 종가. 2026-01-02~11-20은 CSV 적재(src='csv'), 이후는 일일 수집(src='krx' 등)
create table if not exists vkospi_daily (
  trade_date date primary key,
  close numeric not null,
  src text not null default 'krx',
  updated_at timestamptz not null default now()
);
alter table vkospi_daily enable row level security;
drop policy if exists vkospi_daily_read on vkospi_daily;
create policy vkospi_daily_read on vkospi_daily for select using (true);
