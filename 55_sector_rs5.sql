-- ============================================================================
-- STOCK RADAR · 섹터 RS5(5거래일) 도입 — 빠른 순환매 대응
-- ============================================================================
-- 배경: "주도 섹터" 판정을 RS20(20거래일 ≈ 1개월) 하나로만 하다 보니, 최근처럼
-- 하루~며칠 단위로 도는 빠른 순환매 장세에서 두 가지 문제가 있었습니다.
--   1) 이미 꺾인 섹터가 20일 누적수익률엔 과거 랠리분이 남아있어 며칠간 계속
--      "주도 섹터"로 잘못 표시됨 (퇴장 신호 지연 — 예: K-컬처/화장품이 8/31
--      하락 전환했는데도 RS20 상 계속 상위로 잡히는 케이스)
--   2) 반대로 하루 반짝 급등한 섹터는 RS20 기준으로는 애초에 주도로 안 잡힘
--      (이건 오히려 노이즈를 걸러내는 정상 동작 — 예: 2차전지 8/31 1일 스파이크)
--
-- 해결: RS5(5거래일 ≈ 1주)를 추가 계산해 RS20과 병행 비교합니다. 05_metrics.sql
-- 의 sector_daily 계산식이 rs5 / rs5_rank / rs5_top5_streak을 이미 산출하도록
-- 함께 수정되어 있습니다(이 파일 실행 후 다음 compute.yml 실행부터 값이 채워짐).
--
--   · 신흥 주도(is_emerging_leader): RS5 상위 5위가 "2일 연속" 유지 + 아직
--     RS20 상위 5위는 아님 → 막 뜨기 시작한 섹터. 2일 연속 조건으로 하루짜리
--     스파이크 오탐을 걸러냅니다.
--   · 이탈 조짐(is_weakening_leader): RS20은 아직 상위 5위(추세상 주도 유지)
--     인데 RS5가 당장 5위 밖으로 밀림 → 꺾이기 시작한 신호. 퇴장은 속도가
--     중요하므로 확인 없이 하루만으로 표시합니다(진입은 보수적으로, 퇴장은
--     민감하게 — 비대칭 규칙).
--
-- v_sector_rank는 기존 컬럼 순서/타입을 그대로 두고 끝에만 추가하므로
-- create or replace view로 처리합니다(= v_screener/v_stock_summary 등
-- 의존 뷰를 건드리지 않고, cascade 재생성도 필요 없음).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

alter table sector_daily add column if not exists rs5             numeric(14,6);
alter table sector_daily add column if not exists rs5_rank        integer;
alter table sector_daily add column if not exists rs5_top5_streak smallint;

comment on column sector_daily.rs5 is
  '업종RS5 = 업종 평균 등락률의 5거래일 누적수익률(rolling, 최소 4일). 소속 종목 3개 미만 업종은 NULL';
comment on column sector_daily.rs5_rank is
  '당일 전체 업종 중 rs5 내림차순 순위';
comment on column sector_daily.rs5_top5_streak is
  'rs5_rank가 5위 이내로 연속 유지된 거래일 수(오늘 포함). 5위 밖이면 0';

create or replace view v_sector_rank
with (security_invoker = true) as
with base as (
  select trade_date, sector, total_amount, avg_change_pct, stock_count,
         rs20, rs_rank, rs5, rs5_rank, rs5_top5_streak,
         foreign_net, inst_net, smart_net,
         sum(total_amount) over (partition by sector order by trade_date
                                 rows between 4 preceding and current row)     as amt_5d,
         sum(total_amount) over (partition by sector order by trade_date
                                 rows between 9 preceding and 5 preceding)     as amt_prev5d,
         avg(total_amount) over (partition by sector order by trade_date
                                 rows between 19 preceding and current row)    as amt_ma20
  from sector_daily
  where market = 'ALL'
),
latest as (select max(trade_date) as d from base)
select b.trade_date,
       b.sector,
       b.total_amount,
       round(b.total_amount::numeric / nullif(sum(b.total_amount) over (), 0) * 100, 2) as share_pct,
       b.amt_5d,
       b.amt_prev5d,
       case when b.amt_prev5d > 0
            then round((b.amt_5d - b.amt_prev5d)::numeric / b.amt_prev5d * 100, 2) end   as amt_chg_1w_pct,
       case when b.amt_ma20 > 0
            then round(b.total_amount::numeric / b.amt_ma20 * 100, 1) end               as amt_vs_ma20_pct,
       b.avg_change_pct,
       b.rs20,
       b.rs_rank,
       b.stock_count,
       b.foreign_net,
       b.inst_net,
       b.smart_net,
       b.rs5,
       b.rs5_rank,
       b.rs5_top5_streak,
       -- 신흥 주도: RS5 상위 5위 2일 연속 + 아직 RS20 상위 5위는 아님
       (b.rs5_rank is not null and b.rs5_rank <= 5 and b.rs5_top5_streak >= 2
        and (b.rs_rank is null or b.rs_rank > 5))                                       as is_emerging_leader,
       -- 이탈 조짐: RS20 상위 5위인데 RS5는 당장 5위 밖
       (b.rs_rank is not null and b.rs_rank <= 5
        and (b.rs5_rank is null or b.rs5_rank > 5))                                     as is_weakening_leader
from base b, latest l
where b.trade_date = l.d
order by b.total_amount desc;

do $$
begin
  grant select on v_sector_rank to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
