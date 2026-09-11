-- ============================================================================
-- STOCK RADAR · daily_price에 NXT(넥스트레이드) 마감 시세 컬럼 추가
-- ============================================================================
-- 배경: "종가베팅2" 전략(2026-09-11 신설) — 정규장 마감 등락률과 NXT 애프터
-- 마켓(장 마감~20:00) 등락률의 괴리를 보는 전략 — 을 06_signals.sql(일배치)에서
-- 계산하려면 NXT 마감 시세가 daily_price에 저장돼 있어야 합니다.
--
-- 지금까지는 NXT 시세를 저장하는 곳이 전혀 없었습니다 — "전략성과2"(상따)
-- 후보 엔진의 stageNxt()/66_intraday_candidates.py가 NXT 시세를 실시간
-- 조회하긴 하지만 그 자리에서만 쓰고 버립니다(저장 안 함).
--
-- 이 파일이 하는 일: daily_price에 nxt_close(NXT 마감가)·nxt_change_pct
-- (NXT 등락률, 전일 정규장 종가 대비 KIS가 계산해 내려주는 값 그대로) 두
-- 컬럼만 추가합니다. 채우는 건 새 70_nxt_collect.py(20:10 KST 실행,
-- nxt_collect.yml)의 몫이고, 이 파일 자체는 컬럼만 만듭니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행 (Claude는 DB 쓰기 권한이
--   없어 직접 실행할 수 없습니다 — 이 파일을 실행해주셔야 종가베팅2가 동작합니다).
-- ============================================================================

alter table daily_price
  add column if not exists nxt_close       bigint,
  add column if not exists nxt_change_pct  numeric(10,4);

comment on column daily_price.nxt_close is
  'NXT(넥스트레이드) 애프터마켓 마감가 — 70_nxt_collect.py가 20:10 KST경(NXT 마감 20:00 이후) 채움. 정규장 마감 후 데이터라 그날 마감(close)과 별개 값.';
comment on column daily_price.nxt_change_pct is
  'NXT 등락률(%) — KIS 시세 API(market_div=NX)의 전일대비등락률(prdy_ctrt)을 그대로 저장. 기준(전일 정규장 종가 대비인지 등)은 66_intraday_candidates.py/relay-server stageNxt()와 동일하게 미검증 상태(최초 데이터로 확인 필요).';

-- ── 확인 ──────────────────────────────────────────────────────────────────
select column_name, data_type
from information_schema.columns
where table_name = 'daily_price' and column_name in ('nxt_close', 'nxt_change_pct');
