-- ============================================================================
-- STOCK RADAR · 텔레그램 목표가 알림 저장용 테이블
-- ============================================================================
-- 배경: relay-server(Render)가 텔레그램 "/목표가 종목코드 가격" 명령으로
-- 설정한 목표가를 지금까지 서버 메모리에만 저장했습니다 — Render가 재배포
-- 되거나 재시작되면 설정이 전부 날아가는 문제가 있어, 이 값을 Supabase에
-- 영구 저장하도록 바꿉니다.
--
-- 조회(select)는 다른 시장 데이터 테이블처럼 공개(anon 읽기 허용) —
-- 나중에 프론트엔드에서 목표가를 보여줄 수도 있으니까요. 쓰기(insert/
-- update/delete)는 RLS로 막아두고, relay-server가 anon 키가 아니라
-- service_role 키로만 쓸 수 있게 합니다(service_role은 RLS를 우회함).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

create table if not exists alert_targets (
  code         text primary key,        -- 종목코드 (6자리)
  target_price numeric(14,2) not null,  -- 목표가
  updated_at   timestamptz not null default now()
);

comment on table alert_targets is
  '텔레그램 "/목표가" 명령으로 설정한 종목별 목표가. relay-server(Render)가 읽고 씀.';

alter table alert_targets enable row level security;

drop policy if exists "alert_targets_public_read" on alert_targets;
create policy "alert_targets_public_read" on alert_targets
  for select using (true);
-- insert/update/delete 정책을 만들지 않음 = anon/authenticated는 쓰기 불가.
-- relay-server는 SUPABASE_SERVICE_KEY(service_role)로 RLS를 우회해서 씁니다.

do $$
begin
  grant select on alert_targets to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
