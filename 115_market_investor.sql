-- 시장별 투자자 매매동향(코스피·코스닥·선물): 개인·외국인·기관계 순매수(억원). 쓰기는 Actions(서비스 DB URL)만, 읽기 공개.
create table if not exists market_investor_daily (
  trade_date  date     not null,
  market      text     not null,        -- KOSPI | KOSDAQ | FUT(코스피200 선물)
  personal    numeric,                  -- 개인 순매수(억원)
  foreign_net numeric,                  -- 외국인
  inst        numeric,                  -- 기관계
  updated_at  timestamptz not null default now(),
  primary key (trade_date, market)
);
do $$
begin
  alter table public.market_investor_daily enable row level security;
  drop policy if exists "public read" on public.market_investor_daily;
  create policy "public read" on public.market_investor_daily for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.market_investor_daily from anon, authenticated;
    grant select on public.market_investor_daily to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;
