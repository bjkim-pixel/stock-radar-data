-- 128_data_version.sql — 웹 화면 요청 캐시용 "데이터 버전" (2026-11-08)
-- 수집·계산 파이프라인이 어떤 테이블이든 쓰기(insert/update/delete)를 하면 Postgres 통계 카운터가 올라가므로,
-- 그 합계가 바뀌었는지만 보고 브라우저가 저장해 둔 조회 결과를 다시 받을지 결정합니다.
-- 화면(릴레이)이 직접 쓰는 테이블(접속기록·투자일지·관심종목·푸시·토큰)은 제외 — 이들이 바뀌어도 시장 데이터 캐시는 유효.
create or replace function data_version() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text
  from pg_stat_user_tables
  where schemaname = 'public'
    and relname not in ('access_log','journal_entries','journal_images','my_watchlist',
                        'push_subscriptions','alert_targets','kis_token','watchlist','trades')
$$;
revoke all on function data_version() from public;
do $$ begin
  grant execute on function data_version() to anon, authenticated;
exception when undefined_object then raise notice 'anon 롤 없음 — 건너뜀';
end $$;
