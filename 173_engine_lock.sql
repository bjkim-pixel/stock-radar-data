-- 주문 권한 잠금(2026-11-18, 실거래 전환 0단계): 배포 중 옛·새 인스턴스가 동시에 주문·손절을 내지 않게 하는 임대(lease) 한 줄.
-- name='order' 한 행만 쓴다. holder 는 지금 권한을 쥔 인스턴스, expires_at 이 지나면 다른 인스턴스가 이어받는다.
-- 릴레이 서버(service_role)만 읽고 쓴다.
create table if not exists public.engine_lock (
  name        text primary key,
  holder      text not null,
  expires_at  timestamptz not null,
  beat_at     timestamptz not null default now()
);
do $$
begin
  alter table public.engine_lock enable row level security;
  revoke all on public.engine_lock from anon, authenticated;
exception when others then null;
end $$;
notify pgrst, 'reload schema';
