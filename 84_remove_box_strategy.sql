-- ============================================================================
-- STOCK RADAR · 박스권 전략 가상매매 기록 정리 (2026-10-09)
-- ============================================================================
-- 박스권은 매매 전략이 아니라 "오늘의 시장" 지표(지수 박스위치)로 바꿨습니다.
-- 이미 compute가 한 번 돌아 생긴 BOX 포지션·신호가 전략성과에 남아 있으니 지웁니다.
-- (다음 compute는 BOX를 만들지 않습니다.)
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================
delete from positions where portfolio = 'VIRTUAL' and strategy = 'BOX';
delete from signals   where signal_type in ('V4_BUY_BOX', 'V4_SELL_BOX');

select
  (select count(*) from positions where strategy = 'BOX')                           as box_positions_left,
  (select count(*) from signals where signal_type in ('V4_BUY_BOX','V4_SELL_BOX'))  as box_signals_left;
