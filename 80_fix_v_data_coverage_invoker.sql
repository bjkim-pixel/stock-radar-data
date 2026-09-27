-- ============================================================================
-- STOCK RADAR · v_data_coverage security_invoker 누락 수정
-- ============================================================================
-- 75_drop_kiwoom_holder_stats.sql에서 이 뷰를 다시 만들 때 security_invoker
-- 옵션을 빠뜨렸습니다(제 실수). 79번에서 다른 4개 뷰를 고치면서 Advisor가
-- 이것도 같은 문제로 잡아냄 — 동일하게 수정.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_data_coverage;
create view v_data_coverage
with (security_invoker = true) as
select
  d.trade_date,
  count(*)                                         as price_rows,
  count(f.code)                                    as flow_rows,
  count(*) filter (where f.is_partial)             as partial_flow_rows,
  count(m.code)                                    as metrics_rows
from daily_price d
left join daily_flow          f on f.trade_date = d.trade_date and f.code = d.code
left join daily_metrics       m on m.trade_date = d.trade_date and m.code = d.code
group by d.trade_date
order by d.trade_date desc;

comment on view v_data_coverage is '날짜별 적재 현황. 마이그레이션·수집 후 여기부터 확인 (2026-09-26: security_invoker=true 추가)';

-- ── 확인 ──────────────────────────────────────────────────────────────────
select trade_date, price_rows, flow_rows, metrics_rows
from v_data_coverage
order by trade_date desc
limit 3;
