-- ============================================================================
-- STOCK RADAR · 실전매매 기록 테이블 — 매매 6단계
-- ============================================================================
-- 실행: Actions "[수시] DB 테이블·뷰 생성" → 대상 live_trading (여러 번 실행해도 안전)
-- relay-server(service_role)만 읽고 씁니다. anon/authenticated 권한 없음.
-- 계좌의 진실은 KIS(잔고·체결조회)이고, 여기에는 우리가 낸 주문의 기록·자동 매도 계획·체결 증분을 남깁니다.
--   live_orders  실전 주문(KIS 주문번호 odno, 가상 체결가 sim_avg 함께 저장)
--   live_fills   체결 증분(체결조회에서 늘어난 만큼)
--   live_plans   종목별 자동 매도 계획(손절·익절 단계)
--   live_events  엔진 이벤트(손절·익절·대조·계획 수정)
-- ============================================================================
create table if not exists live_orders (
  id          text primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  code        text not null,
  name        text,
  side        text not null check (side in ('buy','sell')),
  type        text not null check (type in ('limit','market')),
  price       numeric,
  qty         bigint not null check (qty > 0),
  filled_qty  bigint not null default 0,
  filled_amt  numeric not null default 0,
  avg_price   numeric,
  status      text not null check (status in ('pending','unknown','open','partial','filled','cancelled','rejected')),
  reason      text,
  plan        jsonb,
  note        text,
  odno        text,
  orgno       text,
  ref_price   numeric,
  sim_avg     numeric,
  sim_qty     bigint,
  sent_at     timestamptz,
  msg         text,
  cancel_req  boolean not null default false
);
create index if not exists idx_live_orders_status on live_orders (status);
create index if not exists idx_live_orders_created on live_orders (created_at desc);
create unique index if not exists idx_live_orders_odno on live_orders (odno) where odno is not null;

create table if not exists live_fills (
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
create index if not exists idx_live_fills_ts on live_fills (ts desc);

create table if not exists live_plans (
  code        text primary key,
  name        text,
  plan        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists live_events (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  kind    text not null,
  code    text,
  detail  jsonb
);
create index if not exists idx_live_events_ts on live_events (ts desc);

do $$
declare t text;
begin
  foreach t in array array['live_orders','live_fills','live_plans','live_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
  begin revoke all on sequence live_events_id_seq from anon, authenticated; exception when others then null; end;
end $$;
