-- ============================================================================
-- STOCK RADAR · 나머지 4개 Advisor 경고 수정
-- ============================================================================
-- 76_fix_intraday_rls.sql과 같은 문제: anon/authenticated에 INSERT/UPDATE/
-- DELETE/TRUNCATE까지 전부 열려 있었음. 실제 쓰기는 전부 relay-server가
-- SUPABASE_SERVICE_KEY(RLS 우회)로 하고, anon 키는 읽기(프론트엔드 조회)에만
-- 쓰는 것 확인 — 아래처럼 잠가도 정상 동작에 영향 없음.
--   · intraday_daily_summary / intraday_decision_events: 릴레이서버가 쓰고,
--     프론트엔드(종목상세/전략성과2 등)가 읽음
--   · intraday_tick_log: 코드 어디서도 참조되지 않음(읽기/쓰기 다 없음) —
--     당장은 안전하게 잠그기만 하고, 정말 안 쓰는 게 맞으면 나중에 정리 후보
--   · v_program_trade_recent: 뷰라서 RLS 대상이 아님(RLS는 테이블에만 적용) —
--     쓰기 권한만 제거. 이것도 코드에서 안 쓰임(program_trade_daily 원본
--     테이블 위에 만든 뷰인데 화면·릴레이서버 어디서도 참조 안 함) — 정리 후보.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

-- 테이블 3개: 쓰기 권한 제거 + RLS 활성화 + 읽기 전용 정책
revoke insert, update, delete, truncate, trigger, references
  on public.intraday_daily_summary, public.intraday_decision_events, public.intraday_tick_log
  from anon, authenticated;

alter table public.intraday_daily_summary   enable row level security;
alter table public.intraday_decision_events enable row level security;
alter table public.intraday_tick_log        enable row level security;

drop policy if exists "read_only_anon" on public.intraday_daily_summary;
create policy "read_only_anon" on public.intraday_daily_summary
  for select to anon, authenticated using (true);

drop policy if exists "read_only_anon" on public.intraday_decision_events;
create policy "read_only_anon" on public.intraday_decision_events
  for select to anon, authenticated using (true);

drop policy if exists "read_only_anon" on public.intraday_tick_log;
create policy "read_only_anon" on public.intraday_tick_log
  for select to anon, authenticated using (true);

-- 뷰 1개: RLS 대상 아님 — 쓰기 권한만 제거 (원래 select만 있어야 정상)
revoke insert, update, delete, truncate, trigger, references
  on public.v_program_trade_recent
  from anon, authenticated;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema='public' and grantee in ('anon','authenticated')
  and table_name in ('intraday_daily_summary','intraday_decision_events',
                      'intraday_tick_log','v_program_trade_recent')
order by table_name, grantee, privilege_type;
