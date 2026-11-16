-- 자동매매 "오늘 탭 일지"(2026-11-16): 하루에 한 행 — 20:30 에 오늘 탭 내용(uiState)을 그대로 저장한다.
-- snap 은 오늘 탭이 그리는 데이터 전부(후보·주문·체결·회차 기록·보유·현황), sum 은 목록에 보일 가벼운 요약.
-- memo 는 사람이 적는 짧은 메모(다시 저장해도 덮어쓰지 않음). 릴레이 서버(service_role)만 읽고 쓴다.
create table if not exists public.auto_daylog (
  trade_date  date primary key,
  sum         jsonb not null default '{}'::jsonb,
  snap        jsonb not null default '{}'::jsonb,
  size        int   not null default 0,
  memo        text  not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$
begin
  alter table public.auto_daylog enable row level security;
  revoke all on public.auto_daylog from anon, authenticated;
exception when others then null;
end $$;
notify pgrst, 'reload schema';
