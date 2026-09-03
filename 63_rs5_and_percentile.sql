-- ============================================================================
-- STOCK RADAR · 개별RS 5거래일 버전 + 백분위(percentile) 환산 컬럼 추가
-- ============================================================================
-- 배경: 기존 개별RS(daily_metrics.rs20_vs_mkt)는 20거래일 수익률 기준 하나뿐이고,
-- 값이 "%p" 단위(예: +6.3%p)라 그날 유니버스 안에서 얼마나 강한 축인지 감을
-- 잡기 어렵다는 피드백이 있었습니다. 업종RS가 20일(rs20)과 5일(rs5) 두 창을
-- 같이 보는 것(55_sector_rs5.sql)처럼, 개별종목RS도 5거래일 버전을 추가하고,
-- 두 버전 모두 그날 유니버스 내 백분위(0~100, 높을수록 강함)로도 같이
-- 제공합니다. 실제 계산 로직은 05_metrics.sql이 담당하고, 이 파일은 컬럼
-- 추가만 합니다.
--
--   rs5_vs_mkt  : 종목 5거래일 수익률 − 그날 유니버스 평균 5거래일 수익률(%p).
--                 rs20_vs_mkt와 계산 방식은 동일하고 창만 5일로 축소.
--   rs20_pctl   : rs20_vs_mkt를 그날 유니버스(값이 있는 종목만) 안에서
--                 percent_rank()로 환산한 백분위(0~100). 100에 가까울수록
--                 그날 개별RS(20일) 기준 상위권.
--   rs5_pctl    : 위와 동일한 방식으로 rs5_vs_mkt를 백분위 환산.
--
-- 기존 rs20_vs_mkt(원시 %p 값) 컬럼은 그대로 두고 백분위 컬럼을 추가만
-- 합니다 — 06_signals.sql의 추세추종 3단계 조건(rs20_vs_mkt > 0)은 원시값
-- 기준으로 이미 백테스트 검증된 임계값이라 그대로 유지합니다. 화면 표시만
-- 백분위 기준으로 바뀝니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행. 그 다음 05_metrics.sql이
--   포함된 compute 배치(compute.yml)가 한 번 더 돌아야 rs5_vs_mkt/rs20_pctl/
--   rs5_pctl 값이 과거분까지 채워집니다(그 전까지는 NULL).
-- ============================================================================

alter table daily_metrics add column if not exists rs5_vs_mkt numeric(10,2);
alter table daily_metrics add column if not exists rs20_pctl  numeric(5,2);
alter table daily_metrics add column if not exists rs5_pctl   numeric(5,2);

comment on column daily_metrics.rs5_vs_mkt is
  '개별종목 상대강도(5일) = 종목 5거래일 수익률(%) − 그날 유니버스 평균 5거래일
   수익률(%). rs20_vs_mkt와 동일한 계산 방식, 창만 5거래일. 5거래일 이력 없으면
   NULL.';
comment on column daily_metrics.rs20_pctl is
  'rs20_vs_mkt를 그날 유니버스(값 존재 종목만) 안에서 percent_rank()로 환산한
   백분위(0~100). 100에 가까울수록 그날 개별RS(20일) 최상위. rs20_vs_mkt가
   NULL이면 NULL.';
comment on column daily_metrics.rs5_pctl is
  'rs5_vs_mkt를 그날 유니버스(값 존재 종목만) 안에서 percent_rank()로 환산한
   백분위(0~100). rs5_vs_mkt가 NULL이면 NULL.';
