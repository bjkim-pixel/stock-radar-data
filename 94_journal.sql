-- ============================================================================
-- STOCK RADAR · 투자일지 (journal_entries) — 나만 보는 게시판
-- ============================================================================
-- 읽기·쓰기 모두 relay-server(/journal)가 service_role로만 합니다. anon/authenticated에는
-- 어떤 권한도 주지 않습니다(공개 읽기 금지). 여러 번 실행해도 안전.
-- ============================================================================
create table if not exists journal_entries (
  id          bigserial primary key,
  entry_date  date not null default current_date,
  kind        text not null default '메모',      -- 매수 / 매도 / 관찰 / 복기 / 메모
  title       text,
  body        text,
  stock_code  text,
  stock_name  text,
  price       numeric,                          -- 매수·매도 가격(원)
  qty         numeric,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_journal_date on journal_entries (entry_date desc, id desc);
create index if not exists idx_journal_code on journal_entries (stock_code);
alter table journal_entries enable row level security;
revoke all on journal_entries from anon, authenticated;
do $$ begin
  revoke all on sequence journal_entries_id_seq from anon, authenticated;
exception when others then null; end $$;
