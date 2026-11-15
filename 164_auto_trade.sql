-- 자동매매(2026-11-15): 날짜별 후보·점수·승인·그림자 기록(auto_runs) + 설정(auto_config)
-- 릴레이 서버(service_role)만 읽고 쓴다. 사이트 화면은 릴레이 엔드포인트로 본다(공개 읽기 없음 — 매매 정보).
create table if not exists public.auto_runs (
  trade_date  date primary key,
  status      text not null,            -- selected(선정) | noticed(알림 발송) | approved(매수 승인) | passed(패스) | expired(승인 시간 초과)
  payload     jsonb not null default '{}'::jsonb,   -- picks(알림 5개) · shadow(조건 통과 전체, 그림자 기록) · decision · approved · stat · warn
  updated_at  timestamptz not null default now()
);
create table if not exists public.auto_config (
  key         text primary key,         -- 'main'
  value       jsonb not null default '{}'::jsonb,   -- {on:false, perStockKrw:1000000}
  updated_at  timestamptz not null default now()
);
insert into public.auto_config(key, value) values ('main', '{"on": false, "perStockKrw": 1000000}'::jsonb) on conflict (key) do nothing;
do $$
begin
  alter table public.auto_runs enable row level security;
  alter table public.auto_config enable row level security;
  revoke all on public.auto_runs from anon, authenticated;
  revoke all on public.auto_config from anon, authenticated;
exception when others then null;
end $$;
