-- 장중 반복 검토(2026-11-16): 기본 장중 전략에 승인 방식 '자동' + 반복 검토 값을 심는다. 여러 번 실행해도 안전(이미 자동이면 건드리지 않음).
with u as (
  update public.auto_strategies
     set params = params || '{"approval":"auto","roundMin":30,"roundEnd":"14:30","maxBuys":5}'::jsonb,
         version = version + 1, updated_at = now()
   where id = 'intraday-default' and coalesce(params->>'approval', 'manual') <> 'auto'
   returning id, version, params
)
insert into public.auto_strategy_versions(strategy_id, version, params, changed, who)
select id, version, params,
       '[{"key":"approval","label":"승인 방식","from":"직접 승인","to":"자동 승인"},{"key":"roundMin","label":"장중 반복 검토 간격","from":"없음","to":"30분"},{"key":"maxBuys","label":"하루 최대 매수 종목 수","from":"없음","to":"5종목"}]'::jsonb,
       'setup'
  from u
on conflict (strategy_id, version) do nothing;
