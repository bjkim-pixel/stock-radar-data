-- 자동매매 컨트롤 타워 D단계(2026-11-16): 자동 일지 — 날짜·전략별 한 행
-- 매수·매도·수익은 가상매매 체결(paper_fills)에서 전략별로 나눠 계산해 payload 에 담는다(직접 매매가 섞이지 않음).
-- 종가베팅 전략은 "넘겨받은 날" 한 행에 다음 날 아침 매도 결과를 채워 확정한다.
-- memo 는 사람이 적는 칸 — 일지를 다시 만들어도 덮어쓰지 않는다. 릴레이 서버(service_role)만 읽고 쓴다.
create table if not exists public.auto_journal (
  trade_date       date not null,
  strategy_id      text not null,
  kind             text not null default 'intraday',        -- intraday | closing
  strategy_version int,
  strategy_name    text,
  status           text not null default 'draft',           -- draft(작성 중) | open(종가베팅 결과 대기) | final(확정)
  net              numeric,                                 -- 순손익(원, 수수료 반영)
  cost             numeric,                                 -- 매수금액(종가베팅은 넘겨받은 가격 기준)
  pct              numeric,                                 -- 순손익 / 매수금액 (%)
  n_pos            int,
  wins             int,
  losses           int,
  payload          jsonb not null default '{}'::jsonb,
  memo             text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (trade_date, strategy_id)
);
create index if not exists idx_auto_journal_sid on public.auto_journal (strategy_id, trade_date desc);
create index if not exists idx_auto_journal_status on public.auto_journal (status) where status <> 'final';
do $$
begin
  alter table public.auto_journal enable row level security;
  revoke all on public.auto_journal from anon, authenticated;
exception when others then null;
end $$;

notify pgrst, 'reload schema';
