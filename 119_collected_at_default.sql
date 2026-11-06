-- 수집 시각(collected_at) 기본값: 새 행을 처음 INSERT할 때 null이 되어 "기준 시각"이 비어 보이던 문제 수정.
-- (upsert의 UPDATE 경로에만 collected_at=now()가 있어, 그날 첫 수집 직후에는 null → 두 번째 수집부터 시각이 나왔음)
alter table daily_price alter column collected_at set default now();
alter table daily_flow  alter column collected_at set default now();
-- 이미 null인 최신 거래일 행은 지금 시각으로 채움(정확한 수집 시각은 모르지만 "시각 없음"보다 낫고, 다음 수집이 바로 덮어씀)
update daily_price set collected_at = now()
 where collected_at is null and trade_date = (select max(trade_date) from daily_price);
update daily_flow set collected_at = now()
 where collected_at is null and trade_date = (select max(trade_date) from daily_flow);
