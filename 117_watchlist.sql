-- ============================================================================
-- STOCK RADAR · 내 종목 목록(my_watchlist) — 관심(fav) · 투자(hold)
-- ============================================================================
-- 브라우저(localStorage)의 목록을 relay-server(/my_watchlist, 토큰 인증)가 service_role로 저장하고,
-- 113_ai_brief.py(Actions)가 읽어 매수·보유·매도 의견을 만듭니다. anon/authenticated에는 어떤 권한도 주지 않습니다.
-- 여러 번 실행해도 안전.
-- ============================================================================
create table if not exists my_watchlist (
  kind      text        not null check (kind in ('fav','hold')),   -- fav=관심, hold=투자(보유)
  code      text        not null,
  name      text,
  added_at  timestamptz not null default now(),
  primary key (kind, code)
);
alter table my_watchlist enable row level security;
revoke all on my_watchlist from anon, authenticated;
