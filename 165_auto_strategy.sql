-- 자동매매 컨트롤 타워 A단계(2026-11-15): 전략(엔진 유형 + 조건값)과 버전 이력. relay(service key) 전용
create table if not exists public.auto_strategies (
  id          text primary key,
  name        text not null,
  kind        text not null check (kind in ('intraday','closing')),
  "desc"      text not null default '',
  enabled     boolean not null default false,
  archived    boolean not null default false,
  builtin     boolean not null default false,
  version     int not null default 1,
  params      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.auto_strategy_versions (
  id          bigserial primary key,
  strategy_id text not null references public.auto_strategies(id) on delete cascade,
  version     int not null,
  params      jsonb not null,
  changed     jsonb not null default '[]'::jsonb,
  who         text,
  at          timestamptz not null default now(),
  unique (strategy_id, version)
);
-- 기본 전략 2개 = 1~3단계 확정값. 종목당 금액은 지금 auto_config 'main' 값을 옮김
insert into public.auto_strategies(id, name, kind, "desc", enabled, builtin, version, params)
values
 ('intraday-default', '수급 돌파 장중', 'intraday', '오전 외국인·기관·프로그램 동시 순매수 + 체결강도 강세 종목을 사서 당일 손절·5분할 익절', true, true, 1,
   '{"altFlowOn":true,"altFlowMinEok":1,"altAutoBuy":true,"selectAt":"10:05","noticeAfter":10,"approveWindow":15,"capMinEok":10000,"maTrend":true,"smx":"cont_stall","flowForeign":"req","flowInst":"req","flowProgram":"req","cttrMin":100,"openRiseMax":8,"poolTop":10,"notifyTop":5,"sectorMax":2,"weights":{"flow":40,"cttr":15,"rise":15,"amt":15,"trend":15},"perStockKrw":1000000,"buyPick":"q1","recheckPct":1.5,"fillWaitMin":3,"approval":"manual","stopPct":5,"rr":3,"split":5,"minPct":3,"trail":2,"eodWeak":"ask","eodTimeout":"keep"}'::jsonb || coalesce((select jsonb_build_object('perStockKrw', (value->>'perStockKrw')::bigint) from public.auto_config where key='main' and value ? 'perStockKrw'), '{}'::jsonb)),
 ('closing-default', '장중 강세 이월', 'closing', '15:10까지 강한 장중 보유 종목을 들고 가서 다음 날 아침 3분할 매도', true, true, 1, '{"judgeAt":"15:10","replyMin":8,"convertAt":"20:00","needAboveAvg":true,"highNearPct":2,"carryFlow":"any","idxFloor":-1,"overnightStopPct":5,"gapCut":-3,"holdOn":true,"holdMode":"price","slices":["09:05","09:10","09:15"]}'::jsonb)
on conflict (id) do nothing;
insert into public.auto_strategy_versions(strategy_id, version, params, changed, who)
select id, 1, params, '[{"key":"init","label":"처음 만듦","from":"","to":"기본값"}]'::jsonb, 'setup' from public.auto_strategies
on conflict (strategy_id, version) do nothing;
-- 그날 어떤 전략·버전으로 돌았는지(일지용)
alter table public.auto_runs add column if not exists strategy_id text;
alter table public.auto_runs add column if not exists strategy_version int;
do $$
begin
  alter table public.auto_strategies enable row level security;
  alter table public.auto_strategy_versions enable row level security;
  revoke all on public.auto_strategies from anon, authenticated;
  revoke all on public.auto_strategy_versions from anon, authenticated;
exception when others then null;
end $$;
notify pgrst, 'reload schema';
