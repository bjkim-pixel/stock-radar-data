-- 종가 정리 개편(2026-11-16): 정규장 종목은 15:00 판정(답 마감 15:20), NXT 거래 종목은 19:00 판정(답 마감 19:40).
-- 약한 종목 정리는 항상 승인 후에만(자동 정리·무응답 정리 없음). 여러 번 실행해도 안전(이미 바뀌었으면 건드리지 않음).
with u as (
  update public.auto_strategies
     set params = (params - 'eodTimeout') || '{"judgeAt":"15:00","replyMin":20,"nxtJudgeAt":"19:00","nxtReplyMin":40}'::jsonb,
         "desc" = '15:00(정규장 종목)·19:00(NXT 종목)에 약한 종목을 승인 후 정리하고, 강한 종목은 들고 가서 다음 날 아침 3분할 매도',
         version = version + 1, updated_at = now()
   where kind = 'closing' and coalesce(params->>'nxtJudgeAt', '') = ''
   returning id, version, params
)
insert into public.auto_strategy_versions(strategy_id, version, params, changed, who)
select id, version, params,
       '[{"key":"judgeAt","label":"종가 판정 시각(정규장 종목)","from":"15:10","to":"15:00"},{"key":"replyMin","label":"정리 답 마감까지(정규장 종목)","from":"8분","to":"20분"},{"key":"nxtJudgeAt","label":"종가 판정 시각(NXT 거래 종목)","from":"없음","to":"19:00"},{"key":"nxtReplyMin","label":"정리 답 마감까지(NXT 거래 종목)","from":"없음","to":"40분"}]'::jsonb,
       'setup'
  from u
on conflict (strategy_id, version) do nothing;

-- 장중 전략: 예전 '자동 정리' 값은 '승인 후 정리'로, 무응답 정리 설정은 삭제
update public.auto_strategies
   set params = (case when params->>'eodWeak' = 'auto_sell' then params || '{"eodWeak":"ask"}'::jsonb else params end) - 'eodTimeout'
 where kind = 'intraday' and (params->>'eodWeak' = 'auto_sell' or params ? 'eodTimeout');
