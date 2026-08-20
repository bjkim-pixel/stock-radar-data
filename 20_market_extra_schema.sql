-- ============================================================================
-- STOCK RADAR · 프로그램매매 · 미국증시 스키마 + 뷰
-- 20_market_extra_schema.sql
-- ============================================================================
-- 사용법: Supabase 대시보드 → SQL Editor → 전체 붙여넣기 → Run
-- 전제 : 01_schema.sql, 19_web_views.sql을 먼저 실행해야 합니다.
-- 멱등성: 여러 번 실행해도 안전합니다.
--
-- 신용거래 융자잔고는 포함하지 않습니다 — KIS Open API에 시장 전체 집계
-- 엔드포인트가 없고(종목별 조회만 있음), 별도 소스 확정 후 추가 예정입니다.
-- ============================================================================


-- ============================================================================
-- A. program_trade_daily — 프로그램매매 종합현황(일별)
--    KIS "comp-program-trade-daily" (tr_id FHPPG04600001), KOSPI+KOSDAQ 각각 수집
-- ============================================================================
create table if not exists program_trade_daily (
  trade_date       date not null,
  market           text not null,           -- KOSPI | KOSDAQ
  arb_net_amount   bigint,                  -- 차익 순매수 거래대금 (원)
  nonarb_net_amount bigint,                 -- 비차익 순매수 거래대금 (원)
  source           text default 'KIS',
  created_at       timestamptz default now(),
  primary key (trade_date, market)
);

comment on table program_trade_daily is 'KIS 프로그램매매 종합현황(일별) API 수집분. 20_collect_market_extra.py가 매일 적재';

alter table program_trade_daily enable row level security;
drop policy if exists "public read" on program_trade_daily;
create policy "public read" on program_trade_daily for select using (true);


-- ============================================================================
-- B. us_market_daily — 미국 증시 주요 지수
--    Yahoo Finance 비공식 차트 API 수집 (나스닥종합·S&P500·다우·필라델피아반도체)
-- ============================================================================
create table if not exists us_market_daily (
  trade_date   date not null,
  symbol       text not null,               -- NASDAQ | SP500 | DOW | SOX
  close        numeric(16,4),
  change_pct   numeric(10,4),
  source       text default 'YAHOO',
  created_at   timestamptz default now(),
  primary key (trade_date, symbol)
);

comment on table us_market_daily is 'Yahoo Finance 비공식 차트 API(query1.finance.yahoo.com) 수집분. 20_collect_market_extra.py가 매일 적재';

alter table us_market_daily enable row level security;
drop policy if exists "public read" on us_market_daily;
create policy "public read" on us_market_daily for select using (true);


-- ============================================================================
-- C. v_program_trade_recent — 최근 12거래일 · 시장 합산(KOSPI+KOSDAQ) · 억원
-- ============================================================================
drop view if exists v_program_trade_recent cascade;
create or replace view v_program_trade_recent as
with agg as (
  select trade_date,
    sum(arb_net_amount)    as arb_net_amount,
    sum(nonarb_net_amount) as nonarb_net_amount
  from program_trade_daily
  group by trade_date
),
ranked as (
  select *, row_number() over (order by trade_date desc) as rn from agg
)
select trade_date, arb_net_amount, nonarb_net_amount
from ranked
where rn <= 12
order by trade_date asc;


-- ============================================================================
-- D. v_us_market_latest — 최신 거래일 4개 지수 · 전일 대비 등락률
-- ============================================================================
drop view if exists v_us_market_latest cascade;
create or replace view v_us_market_latest as
with latest as (
  select max(trade_date) as dt from us_market_daily
)
select u.symbol, u.close, u.change_pct, u.trade_date
from us_market_daily u
cross join latest l
where u.trade_date = l.dt;


-- ============================================================================
-- 완료 확인
-- ============================================================================
-- select * from v_program_trade_recent;
-- select * from v_us_market_latest;
-- ============================================================================
