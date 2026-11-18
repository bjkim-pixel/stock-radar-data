-- ============================================================================
-- STOCK RADAR · 실전 탭 자동매매(2026-11-19) — 드라이런 장부 + 전략 원본 연결
-- ============================================================================
-- 실행: Actions "[수시] DB 테이블·뷰 생성" → 대상 dryrun_ledger (여러 번 실행해도 안전, 기존 화면·가상매매에 영향 없음)
--   dry_orders / dry_fills / dry_positions / dry_events
--     드라이런 전략의 가상 주문·체결·보유. 가상매매(paper_*)와 같은 모양이지만 따로 기록해서,
--     가상 전략과 그 드라이런 복제가 같은 종목을 각자 보유할 수 있다(장부는 종목당 보유 1개).
--   auto_strategies.source
--     "실전에 적용"으로 만든 실전 탭 전략이 어느 가상 전략에서 왔는지(원본 변경 반영·성과 비교에 씀).
-- 모두 relay-server(service_role)만 읽고 씁니다.
-- ============================================================================
create table if not exists dry_orders (
  id           text primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  code         text not null,
  name         text,
  side         text not null check (side in ('buy','sell')),
  type         text not null check (type in ('limit','market')),
  price        numeric,
  qty          bigint not null check (qty > 0),
  filled_qty   bigint not null default 0,
  avg_price    numeric,
  status       text not null check (status in ('open','partial','filled','cancelled','rejected')),
  queue_ahead  bigint not null default 0,
  last_vol     bigint,
  low_seen     numeric,
  high_seen    numeric,
  reason       text,
  plan         jsonb,
  note         text,
  ref_price    numeric,
  venue        text,
  origin       text
);
create index if not exists idx_dry_orders_status on dry_orders (status);
create index if not exists idx_dry_orders_created on dry_orders (created_at desc);

create table if not exists dry_fills (
  id        text primary key,
  ts        timestamptz not null default now(),
  order_id  text not null,
  code      text not null,
  side      text not null,
  price     numeric not null,
  qty       bigint not null,
  amount    numeric not null,
  fee       numeric not null default 0,
  realized  numeric,
  reason    text
);
create index if not exists idx_dry_fills_ts on dry_fills (ts desc);
create index if not exists idx_dry_fills_order on dry_fills (order_id);

create table if not exists dry_positions (
  code        text primary key,
  name        text,
  qty         bigint not null,
  avg_price   numeric not null,
  opened_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  plan        jsonb
);

create table if not exists dry_events (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  kind    text not null,
  code    text,
  detail  jsonb
);
create index if not exists idx_dry_events_ts on dry_events (ts desc);

do $$
declare t text;
begin
  foreach t in array array['dry_orders','dry_fills','dry_positions','dry_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
  begin revoke all on sequence dry_events_id_seq from anon, authenticated; exception when others then null; end;
end $$;

-- 전략 원본 연결(auto_strategy 를 먼저 실행해 auto_strategies 가 있어야 함 — 없으면 이 부분만 건너뜀)
do $$
begin
  if to_regclass('public.auto_strategies') is not null then
    alter table public.auto_strategies add column if not exists source text;
  end if;
end $$;

notify pgrst, 'reload schema';
