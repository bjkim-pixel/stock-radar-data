-- ============================================================================
-- STOCK RADAR · 매매 보안 기반 1/2 — 감사 기록 테이블 + 소유자 확인 함수
-- ============================================================================
-- 실행: Actions "[수시] DB 테이블·뷰 생성" → 대상 trade_security (여러 번 실행해도 안전, 기존 화면에 영향 없음)
--
--  trade_audit : 매매 관련 모든 요청(거부 포함)의 기록. relay-server(service_role)만 쓰고 읽음.
--                anon/authenticated 에는 어떤 권한도 주지 않음(IP 등 민감 정보).
--  is_owner()  : "지금 요청한 로그인 사용자가 이 사이트의 주인인가". 161번(데이터 잠금)의 RLS 정책이 사용.
--                주인 = auth.users 에서 가장 먼저 만든 계정. 회원가입을 꺼 두면 계정은 내 것 하나뿐.
-- ============================================================================
create table if not exists trade_audit (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  event  text not null,          -- session_open / pin_fail / kill / order_reject / ...
  ok     boolean not null,
  mode   text,                   -- VIRTUAL / REAL
  ip     text,
  ua     text,
  detail jsonb
);
create index if not exists idx_trade_audit_ts on trade_audit (ts desc);
create index if not exists idx_trade_audit_event on trade_audit (event, ts desc);
alter table trade_audit enable row level security;
revoke all on trade_audit from anon, authenticated;
do $$ begin
  revoke all on sequence trade_audit_id_seq from anon, authenticated;
exception when others then null; end $$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select lower(u.email) from auth.users u order by u.created_at asc limit 1)
      = lower(coalesce(auth.jwt() ->> 'email', '')),
    false)
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;
