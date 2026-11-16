-- 시장·종목 이벤트(2026-11-16, 자동매매 보강 E2): 실적 발표·IR(DART), 선물·옵션 만기일·지수 정기변경(규칙 계산), FOMC 등(수동 파일)
-- 표시용 — 매수에서 제외하지 않음. 쓰기는 Actions(169_market_events.py)만, 읽기는 다른 시장 데이터와 같게(데이터 잠금 후엔 로그인한 주인만).
create table if not exists public.market_events (
  ev_key      text primary key,             -- kind|날짜|종목|공시번호나 제목
  event_date  date not null,
  kind        text not null,                -- earnings | ir | expiry | index | fomc | other
  code        text,                         -- 종목 이벤트면 종목코드, 시장 전체면 null
  name        text,
  title       text not null,
  detail      text,
  source      text not null default 'rule', -- dart | rule | manual
  updated_at  timestamptz not null default now()
);
create index if not exists market_events_date on public.market_events (event_date);
create index if not exists market_events_code_date on public.market_events (code, event_date desc);
do $$
begin
  alter table public.market_events enable row level security;
  revoke insert, update, delete, truncate, trigger, references on public.market_events from anon, authenticated;
  drop policy if exists "public read" on public.market_events;
  drop policy if exists "read_owner" on public.market_events;
  if to_regprocedure('public.is_owner()') is not null and exists (select 1 from pg_class where relname = '_anon_lock_list' and relnamespace = 'public'::regnamespace) then
    revoke select on public.market_events from anon;
    grant select on public.market_events to authenticated;
    create policy "read_owner" on public.market_events for select to authenticated using ((select public.is_owner()));
    insert into public._anon_lock_list values ('market_events', 'r') on conflict (relname) do nothing;
  else
    grant select on public.market_events to anon, authenticated;
    create policy "public read" on public.market_events for select using (true);
  end if;
end $$;

notify pgrst, 'reload schema';
