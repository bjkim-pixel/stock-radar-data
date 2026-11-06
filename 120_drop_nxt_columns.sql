-- ============================================================================
-- STOCK RADAR · daily_price 의 NXT 컬럼 4개 삭제 (2026-11-06)
-- ============================================================================
-- 배경: NXT 시간외 시세는 "종가베팅2" 전략만 쓰던 값이었고, 전략 폐지(2026-11-06)와 함께
--       수집 워크플로(nxt_collect.yml)·스크립트(70_nxt_collect.py)도 삭제했습니다.
--       코드 어디에서도 이 컬럼을 읽거나 쓰지 않습니다(저장소 전체 검색으로 확인).
--
-- 삭제 대상: daily_price.nxt_close / nxt_change_pct / nxt_price_1800 / nxt_change_pct_1800
-- 되돌릴 수 없음: 컬럼에 쌓인 과거 NXT 값은 사라집니다(KIS가 과거 NXT 시세를 다시 주지 않음).
--
-- 안전장치: CASCADE 를 쓰지 않았습니다. 혹시 이 컬럼에 기대는 뷰가 있으면 오류가 나면서
--           (트랜잭션이 통째로 취소되어) 아무것도 지워지지 않습니다.
-- 여러 번 실행해도 안전합니다(if exists).
-- ============================================================================
begin;

alter table daily_price
  drop column if exists nxt_close,
  drop column if exists nxt_change_pct,
  drop column if exists nxt_price_1800,
  drop column if exists nxt_change_pct_1800;

commit;

-- 확인: 0행이면 모두 삭제된 것
select column_name from information_schema.columns
where table_name = 'daily_price'
  and column_name in ('nxt_close', 'nxt_change_pct', 'nxt_price_1800', 'nxt_change_pct_1800');
