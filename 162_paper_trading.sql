-- ============================================================================
-- STOCK RADAR · 가상매매(자체 체결 시뮬레이터) 테이블 — 매매 3단계
-- ============================================================================
-- 실행: Actions "[수시] DB 테이블·뷰 생성" → 대상 paper_trading (여러 번 실행해도 안전, 기존 화면에 영향 없음)
-- 모두 relay-server(service_role)만 읽고 씁니다. anon/authenticated 에는 권한을 주지 않습니다(화면은 relay 를 통해 조회).
--   paper_orders     가상 주문(상태·대기 큐 위치 포함)
--   paper_fills      가상 체결(건별, 실현손익 포함)
--   paper_positions  가상 보유(평균단가·자동 매도 계획)
--   paper_events     엔진 이벤트(손절·익절 발동 등, 4단계)
--   paper_book_snaps 호가 10단계 스냅샷(09:00·12:00·15:10·주문/체결 시점만, 14일 보관) — 백테스트·체결 검증용
-- ============================================================================
create table if not exists paper_orders (
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
  reason       text,           -- manual / stop / tp1..tp5
  plan         jsonb,          -- 매수 주문에 붙인 자동 매도 계획(손절·익절 단계)
  note         text
);
create index if not exists idx_paper_orders_status on paper_orders (status);
create index if not exists idx_paper_orders_created on paper_orders (created_at desc);

create table if not exists paper_fills (
  id        text primary key,   -- 주문id_순번 (다시 저장해도 중복되지 않게)
  ts        timestamptz not null default now(),
  order_id  text not null,
  code      text not null,
  side      text not null,
  price     numeric not null,
  qty       bigint not null,
  amount    numeric not null,
  fee       numeric not null default 0,
  realized  numeric,            -- 매도 체결의 실현손익(수수료 전)
  reason    text
);
create index if not exists idx_paper_fills_ts on paper_fills (ts desc);
create index if not exists idx_paper_fills_order on paper_fills (order_id);

create table if not exists paper_positions (
  code        text primary key,
  name        text,
  qty         bigint not null,
  avg_price   numeric not null,
  opened_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  plan        jsonb
);

create table if not exists paper_events (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  kind    text not null,
  code    text,
  detail  jsonb
);
create index if not exists idx_paper_events_ts on paper_events (ts desc);

create table if not exists paper_book_snaps (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  code      text not null,
  kind      text not null,      -- open / noon / close / order / fill
  price     numeric,
  asks      jsonb,              -- [[가격, 잔량], ...] 낮은 가격부터 10개
  bids      jsonb,              -- [[가격, 잔량], ...] 높은 가격부터 10개
  order_id  text
);
create index if not exists idx_paper_snaps_ts on paper_book_snaps (ts desc);
create index if not exists idx_paper_snaps_code on paper_book_snaps (code, ts desc);

do $$
declare t text;
begin
  foreach t in array array['paper_orders','paper_fills','paper_positions','paper_events','paper_book_snaps'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
  begin revoke all on sequence paper_events_id_seq from anon, authenticated; exception when others then null; end;
  begin revoke all on sequence paper_book_snaps_id_seq from anon, authenticated; exception when others then null; end;
end $$;
