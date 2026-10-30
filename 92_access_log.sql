-- ============================================================================
-- STOCK RADAR · 접속 기록 (access_log)
-- ============================================================================
-- 사이트 접속(세션 시작)마다 relay-server(/visit-log)가 한 줄씩 기록합니다.
-- 쓰기·읽기 모두 relay-server가 service_role로만 하므로 anon/authenticated에는
-- 어떤 권한도 주지 않습니다(IP 등 개인정보라 공개 읽기 금지). 180일 지난 행은
-- relay-server가 매시간 정리합니다.
-- 실행: Actions "Setup Access Log" 한 번(또는 SQL Editor에 붙여넣기). 여러 번 실행해도 안전.
-- ============================================================================
create table if not exists access_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  visitor_id  text,            -- 브라우저별 랜덤 ID(localStorage) — 같은 기기 식별용
  session_id  text,
  ip          text,
  country     text,
  region      text,
  city        text,
  isp         text,
  is_mobile_net boolean,       -- 모바일 통신망 여부(ip-api)
  is_proxy    boolean,         -- VPN/프록시/호스팅 의심(ip-api)
  ua          text,
  os          text,
  browser     text,
  device      text,            -- 모바일/태블릿/PC
  screen      text,
  lang        text,
  tz          text,
  referrer    text,
  view        text,            -- 접속 시 열린 화면(#해시)
  is_owner    boolean not null default false,   -- "내 기기"로 표시한 기기
  is_bot      boolean not null default false
);
create index if not exists idx_access_log_ts on access_log (ts desc);
create index if not exists idx_access_log_vid on access_log (visitor_id);
alter table access_log enable row level security;
revoke all on access_log from anon, authenticated;
do $$ begin
  revoke all on sequence access_log_id_seq from anon, authenticated;
exception when others then null; end $$;
