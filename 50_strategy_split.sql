-- ============================================================================
-- STOCK RADAR · 전략 분리 (추세추종 / 종가베팅) — positions.strategy 추가
-- ============================================================================
-- 기존 단일 v4 엔진을 "추세추종"과 "종가베팅" 두 개의 독립 가상 포트폴리오로
-- 분리합니다. 매수·매도·불타기가 서로 섞이지 않도록 positions에 strategy
-- 컬럼을 추가해 어느 전략이 만든 포지션인지 표시합니다.
--
--   strategy = 'TREND'    추세추종 (06_signals.sql V4_CAND_TREND_3 통과 종목)
--   strategy = 'CLOSEBET' 종가베팅 (06_signals.sql V4_CAND_CLOSEBET_3 통과 종목)
--   strategy = NULL       REAL 포트폴리오(사용자 직접 입력) 및 과거 레거시 행
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

alter table positions add column if not exists strategy text;

comment on column positions.strategy is
  '가상매수를 만든 전략: TREND(추세추종) | CLOSEBET(종가베팅) | NULL(REAL/레거시)';

create index if not exists idx_positions_strategy on positions (portfolio, strategy, status);
