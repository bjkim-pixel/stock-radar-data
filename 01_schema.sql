-- ============================================================================
-- STOCK RADAR · Supabase 스키마 v1
-- ============================================================================
-- 사용법: Supabase 대시보드 → SQL Editor → 전체 붙여넣기 → Run
-- 멱등성: 여러 번 실행해도 안전합니다 (IF NOT EXISTS / OR REPLACE).
--
-- 구성
--   1. 종목 마스터        stocks
--   2. 일별 원본          daily_price · daily_flow
--   3. 외부 데이터        kiwoom_holder_stats
--   4. 시장·업종 집계     market_daily · sector_daily
--   5. 계산 결과          daily_metrics · signals
--   6. 사용자 데이터      watchlist · trades
--   7. 운영               ingest_log
--   8. RLS 정책
--   9. 편의 뷰
-- ============================================================================


-- ============================================================================
-- 0. 공통 — updated_at 자동 갱신 트리거
-- ============================================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;


-- ============================================================================
-- 1. 종목 마스터
-- ============================================================================
create table if not exists stocks (
  code            text primary key,                    -- '005930' (6자리 zero-pad)
  name            text not null,
  market          text,                                -- KOSPI | KOSDAQ | KONEX
  security_type   text not null default 'STOCK',       -- STOCK | ETF | ETN | SPAC | PREF | OTHER
  sector_krx      text,                                -- KRX 29분류 (기존 백테스트 기준)
  sector_kis      text,                                -- KIS 지수업종 중분류
  sector_kis_lcls text,                                -- KIS 지수업종 대분류
  listed_shares   bigint,                              -- 상장주식수 (시총 계산·회전율에 필수)
  is_admin_issue  boolean default false,               -- 관리종목
  is_trade_halt   boolean default false,               -- 거래정지
  market_warn     text,                                -- 시장경고 코드
  is_active       boolean default true,                -- 상장폐지 시 false
  first_seen      date,
  last_seen       date,
  updated_at      timestamptz default now()
);

comment on table  stocks              is '종목 마스터. 시드는 수급주체정리.xlsx 업종 시트(2,774종목), 이후 KIS search_stock_info로 주 1회 갱신';
comment on column stocks.security_type is '수집 대상은 STOCK만. ETF/ETN/SPAC은 저장하되 일별 순회에서 제외';
comment on column stocks.sector_krx   is 'KRX 29분류. 기존 백테스트와의 일관성을 위해 유지';
comment on column stocks.listed_shares is '시가총액 = 종가 × 상장주식수, 무게/주식수 = 등락률 × 거래량 / 상장주식수';

create index if not exists idx_stocks_active on stocks (is_active, security_type);
create index if not exists idx_stocks_sector on stocks (sector_krx);

drop trigger if exists trg_stocks_updated on stocks;
create trigger trg_stocks_updated before update on stocks
  for each row execute function set_updated_at();


-- ============================================================================
-- 2. 일별 원본 — 시세
-- ============================================================================
create table if not exists daily_price (
  trade_date      date   not null,
  code            text   not null references stocks(code) on delete cascade,

  open            bigint,
  high            bigint,
  low             bigint,
  close           bigint,
  change          bigint,                              -- 전일 대비
  change_pct      numeric(10,4),                       -- 등락률 (%)
  volume          bigint,                              -- 거래량 (주)
  trade_amount    bigint,                              -- 거래대금 (원)

  market_cap      bigint,                              -- 종가 × 상장주식수
  listed_shares   bigint,                              -- 그날 기준 상장주식수 (증자·분할 추적용)

  source          text default 'KIS',                  -- KIS | KRX | EXCEL
  is_partial      boolean default false,               -- 필터 수집분 표시

  -- ── 파생지표 (당일 데이터만으로 계산되므로 DB가 직접 계산)
  --    엑셀에서 실데이터로 역산해 검증한 수식 (소수점 15자리 일치)
  weight_per_share numeric(18,10)                      -- 무게/주식수 = 등락률 × 거래량 / 상장주식수
    generated always as (
      case when listed_shares > 0 then change_pct * volume::numeric / listed_shares end
    ) stored,

  primary key (trade_date, code)
);

comment on column daily_price.weight_per_share is '무게/주식수 = 등락률 × 거래량 ÷ 상장주식수. 거래량 회전율 × 등락률. 사용자 핵심 후보 선정 지표';
comment on column daily_price.is_partial       is 'true면 필터된 범위에서 수집돼 공백이 있을 수 있음. 신호 계산에서 제외';

create index if not exists idx_price_code_date on daily_price (code, trade_date desc);
create index if not exists idx_price_weight    on daily_price (trade_date desc, weight_per_share desc);
-- idx_price_date(trade_date desc)는 2026-08 용량 정리 때 제거. PK가 이미
-- (trade_date, code)로 시작해 날짜 단독 조회는 PK로 충분합니다.


-- ============================================================================
-- 2. 일별 원본 — 수급 (wide 형태, 순매수 거래대금 중심)
-- ============================================================================
create table if not exists daily_flow (
  trade_date        date not null,
  code              text not null references stocks(code) on delete cascade,

  -- 순매수 거래대금 (원)
  foreign_net       bigint,     -- 외국인        KIS frgn_ntby_tr_pbmn
  inst_net          bigint,     -- 기관합계      KIS orgn_ntby_tr_pbmn
  fin_inv_net       bigint,     -- 금융투자/증권 KIS scrt_ntby_tr_pbmn
  inv_trust_net     bigint,     -- 투신          KIS ivtr_ntby_tr_pbmn
  pension_net       bigint,     -- 연기금 등/기금 KIS fund_ntby_tr_pbmn
  pe_net            bigint,     -- 사모          KIS pe_fund_ntby_tr_pbmn
  individual_net    bigint,     -- 개인          KIS prsn_ntby_tr_pbmn

  source            text default 'KIS',                -- KIS | KRX | EXCEL
  is_partial        boolean default false,

  -- 스마트머니 = 외국인 + 기관합계. 조회 편의를 위해 DB가 계산
  smart_net         bigint generated always as (
                      coalesce(foreign_net,0) + coalesce(inst_net,0)
                    ) stored,

  primary key (trade_date, code)
);

comment on table  daily_flow           is '일별 투자자별 순매수. long이 아닌 wide인 이유: 분석에 쓰이는 건 순매수뿐이고 한 종목의 전 주체를 pivot 없이 한 행으로 조회';
comment on column daily_flow.pension_net is 'KRX "연기금 등" ↔ KIS "기금". 집계 범위가 다를 수 있어 검증 대상. 단 신호 규칙은 이 컬럼을 쓰지 않음';
comment on column daily_flow.is_partial is '엑셀 마이그레이션분 중 외국인·기관합계는 시총 5000억↑·거래량 1억↑ 필터로 수집돼 공백 있음';

create index if not exists idx_flow_code_date on daily_flow (code, trade_date desc);
create index if not exists idx_flow_smart     on daily_flow (trade_date desc, smart_net desc);
-- idx_flow_date(trade_date desc)는 2026-08 용량 정리 때 제거. PK가 이미
-- (trade_date, code)로 시작해 날짜 단독 조회는 PK로 충분합니다.


-- ============================================================================
-- 3. 외부 데이터 — 키움 보유종목 통계 (영웅문4 1331 화면)
-- ============================================================================
-- 별도 테이블인 이유: 업로드 주기가 불규칙(233일 중 113일만 존재)해서
-- daily_price에 컬럼으로 두면 결측이 절반이 됩니다. 조회 시 join하면 충분합니다.
create table if not exists kiwoom_holder_stats (
  trade_date      date not null,
  code            text not null,
  rank            integer,                             -- 보유계좌수 순위
  accounts        bigint,                              -- 보유계좌수
  avg_buy_price   bigint,                              -- 평균매수가
  return_pct      numeric(10,2),                       -- 보유계좌수익률 (%) — 매물대 지표
  close_at_upload bigint,                              -- 업로드 시점 현재가 (검산용)
  uploaded_at     timestamptz default now(),
  primary key (trade_date, code)
);

comment on table  kiwoom_holder_stats            is '키움 영웅문4 1331 화면 CSV 업로드분. KRX·KIS 어디에도 없는 키움 고객 통계';
comment on column kiwoom_holder_stats.return_pct is '키움 고객 평균 손익률. 사실상 매물대 지표 — 계좌수 변화와 함께 보면 개인이 손절 중인지 익절 중인지 구분';

create index if not exists idx_kiwoom_code on kiwoom_holder_stats (code, trade_date desc);
create index if not exists idx_kiwoom_date on kiwoom_holder_stats (trade_date desc);


-- ============================================================================
-- 4. 시장 · 업종 집계
-- ============================================================================
create table if not exists market_daily (
  trade_date       date not null,
  market           text not null,                      -- KOSPI | KOSDAQ
  index_close      numeric(14,2),
  index_change     numeric(14,2),
  index_change_pct numeric(10,4),
  index_ma20       numeric(14,2),
  total_amount     bigint,                             -- 시장 전체 거래대금
  foreign_net      bigint,
  inst_net         bigint,
  individual_net   bigint,
  regime           text,                               -- RISK_ON | NEUTRAL | RISK_OFF
  primary key (trade_date, market)
);

comment on column market_daily.regime is 'RISK_ON: 지수>MA20 AND 시장 외국인+기관 순매수>0 / 둘 중 하나만 NEUTRAL / 둘 다 아니면 RISK_OFF. RISK_OFF일 때 STRONG_BUY 미부여';

create table if not exists sector_daily (
  trade_date      date not null,
  sector          text not null,
  market          text not null default 'ALL',
  avg_change_pct  numeric(10,4),
  total_amount    bigint,
  foreign_net     bigint,
  inst_net        bigint,
  smart_net       bigint,
  stock_count     integer,
  primary key (trade_date, sector, market)
);

-- v4 신호엔진(업종 RS) 추가 컬럼. 기존 테이블에도 적용되도록 ALTER로 둡니다.
alter table sector_daily add column if not exists rs20    numeric(14,6);
alter table sector_daily add column if not exists rs_rank integer;

comment on column sector_daily.rs20    is '업종RS20 = 업종 평균 등락률의 20거래일 누적수익률(rolling, 최소 15일). 소속 종목 3개 미만 업종은 NULL';
comment on column sector_daily.rs_rank is '당일 전체 업종 중 rs20 내림차순 순위. v4 매수조건: 5위 이내';


-- ============================================================================
-- 5. 계산 결과 — 파생 지표 (매일 배치가 계산해 저장, 웹은 읽기만)
-- ============================================================================
create table if not exists daily_metrics (
  trade_date          date not null,
  code                text not null references stocks(code) on delete cascade,

  -- 추세
  ma5                 numeric(14,2),
  ma10                numeric(14,2),
  ma20                numeric(14,2),
  ma60                numeric(14,2),
  above_ma20          boolean,
  ma_aligned          boolean,                         -- 종가 > MA20 > MA60

  -- 거래대금 / 거래량
  amt_avg20           bigint,
  amt_ratio20         numeric(10,2),                   -- 당일/20일평균 × 100
  vol_avg20           bigint,
  vol_ratio20         numeric(10,2),
  quarter_amt         bigint,                          -- 최근 90거래일 누적 거래대금

  -- 신고가
  high_period         bigint,                          -- 최근 250거래일 최고 종가
  high_period_date    date,
  pct_from_high       numeric(10,2),                   -- (종가-고가)/고가 × 100
  is_new_high         boolean,
  near_high           boolean,                         -- 고가의 97% 이상
  high_60d            bigint,                          -- 60일 박스권 상단
  data_span_days      integer,                         -- 이 종목의 실제 데이터 보유 거래일수
  high_label          text,                            -- '52주 신고가' | '기간 내 신고가(N일)'

  -- 누적 수급
  foreign_cum5        bigint,
  foreign_cum20       bigint,
  inst_cum5           bigint,
  inst_cum20          bigint,
  smart_cum5          bigint,
  smart_cum20         bigint,
  smart_cum5_prev     bigint,                          -- 직전 5일 누적 (가속 판정용)
  smart_cum5_cap_pct  numeric(12,6),                   -- 5일 누적 / 시총 × 100
  smart_cum20_cap_pct numeric(12,6),

  -- 수급 기울기 (5일 선형회귀, 시총 정규화 bp)
  foreign_slope       numeric(14,6),
  inst_slope          numeric(14,6),
  flow_lead           text,                            -- FOREIGN_LEAD|INST_LEAD|SYNC|DIVERGE|NONE

  -- 연속성
  consec_both_buy     integer default 0,
  consec_both_sell    integer default 0,

  -- 기관 내부 주도 주체
  inst_lead_field     text,                            -- fin_inv|inv_trust|pension|pe
  inst_lead_value     bigint,

  -- 키움 (join 결과 캐시 — 화면 조회 단순화)
  accounts_chg_20d_pct numeric(10,2),                  -- 20일 전 대비 보유계좌수 증감률

  computed_at         timestamptz default now(),
  primary key (trade_date, code)
);

comment on column daily_metrics.data_span_days is '250 미만이면 high_label을 "기간 내 신고가(N일)"로 표기. 250 도달 시 "52주 신고가"로 자동 전환';
comment on column daily_metrics.flow_lead      is 'DIVERGE(외국인·기관 방향 엇갈림) + 고점권이면 매도 1단계 WATCH_EXIT (d)조건 — 가격이 꺾이기 전 수급 이탈 감지';

create index if not exists idx_metrics_code on daily_metrics (code, trade_date desc);
-- idx_metrics_date(trade_date desc)는 2026-08 용량 정리 때 제거. PK가 이미
-- (trade_date, code)로 시작해 날짜 단독 조회는 PK로 충분합니다.

-- ── v4 신호엔진 추가 지표 ────────────────────────────────────────────────────
-- 기존 컬럼과 계산 기준이 달라 별도 컬럼으로 둡니다.
--   vol_ratio20  : 당일 포함 20일 평균 대비 (기존)
--   vol_ratio20_prev : "전일까지" 20일 평균 대비 (v4 스펙 — 당일 제외)
--   is_new_high  : 250일 롤링 최고 (기존)
--   is_new_high_all  : 상장 이후 전일까지 누적 최고 (v4 스펙 — 확장 윈도우)
alter table daily_metrics add column if not exists vol_avg20_prev   bigint;
alter table daily_metrics add column if not exists vol_ratio20_prev numeric(12,2);
alter table daily_metrics add column if not exists high_all_prev    bigint;
alter table daily_metrics add column if not exists is_new_high_all  boolean;
alter table daily_metrics add column if not exists nonpersonal_net  bigint;
alter table daily_metrics add column if not exists weight_rank      integer;
alter table daily_metrics add column if not exists cap_rank         integer;
alter table daily_metrics add column if not exists pick_score       numeric(10,2);

comment on column daily_metrics.vol_ratio20_prev is 'v4: 당일거래량 ÷ 전일까지 20일 평균거래량 × 100. 매수조건 200 이상';
comment on column daily_metrics.is_new_high_all  is 'v4: 당일 종가 > 상장 이후 전일까지 누적 최고 종가. data_span_days 20 미만 종목은 NULL';
comment on column daily_metrics.nonpersonal_net  is 'v4: 비개인 순매수 = -(개인 순매수). 투자자 주체 순매수 총합이 0이므로 외국인+기관+기타법인과 동일';
comment on column daily_metrics.pick_score       is 'v4 후보 우선순위 = 무게/주식수 순위×0.6 + 시가총액 순위×0.4. 낮을수록 우선';


-- ============================================================================
-- 5. 계산 결과 — 신호
-- ============================================================================
create table if not exists signals (
  id              bigserial primary key,
  trade_date      date not null,
  code            text not null references stocks(code) on delete cascade,
  signal_type     text not null,   -- TREND_START | NEW_HIGH_BREAK | TREND_CONTINUE
                                   -- WATCH_EXIT  | SELL_ALERT     | SELL_SIGNAL
  grade           text not null,   -- STRONG_BUY | BUY | WATCH | CAUTION | SELL
  score           numeric(8,2),
  reason          jsonb not null default '{}'::jsonb,  -- 조건별 통과 내역
  reason_text     text,                                -- 자연어 한 줄
  notified        boolean default false,
  created_at      timestamptz default now(),
  unique (trade_date, code, signal_type)
);

comment on table  signals          is '첫날부터 쌓이는 것 자체가 신호 이력이자 백테스트 원재료';
comment on column signals.notified is '텔레그램 발송 후 true. 재실행해도 중복 발송되지 않음';

create index if not exists idx_signals_date_grade on signals (trade_date desc, grade);
create index if not exists idx_signals_code       on signals (code, trade_date desc);
create index if not exists idx_signals_pending    on signals (notified) where notified = false;


-- ============================================================================
-- 5-3. 포지션 (v4 트레일링 손절 판정용)
-- ============================================================================
-- v4 매도 규칙("보유 중 최고종가 대비 -7%")은 전 종목 스크리닝으로는 판정할 수
-- 없습니다 — 언제 얼마에 샀는지와 그 이후의 최고종가를 알아야 하기 때문입니다.
-- 그래서 포지션을 상태로 저장합니다.
--
-- portfolio 구분
--   VIRTUAL : 06_portfolio.py가 백테스트 규칙 그대로 자동 운용하는 가상 포트폴리오.
--             매 실행 시 전체 재생성되므로 직접 수정하지 마세요.
--   REAL    : 사용자가 직접 넣는 실제 보유분. 엔진은 peak_price 갱신과 매도·추가매수
--             신호 생성만 하고, 진입/청산은 사용자가 기록합니다.
create table if not exists positions (
  id              bigserial primary key,
  portfolio       text not null default 'VIRTUAL',     -- VIRTUAL | REAL
  code            text not null references stocks(code) on delete cascade,
  status          text not null default 'OPEN',        -- OPEN | CLOSED

  entry_date      date   not null,
  entry_price     bigint not null,                     -- 최초 매수가 (불타기 트리거 기준)
  avg_price       numeric(14,2) not null,              -- 트랜치 가중평균 단가
  quantity        bigint not null,
  invested        bigint not null,                     -- 누적 투입금액 (원)
  tranches        integer not null default 1,          -- 트랜치 수 (최초 1 + 불타기 최대 3)

  peak_price      bigint not null,                     -- 보유 중 최고 종가
  peak_date       date,
  pyramid_blocked boolean default false,               -- 과거 손절 이력 종목 → 불타기 중단

  exit_date       date,
  exit_price      bigint,
  exit_reason     text,                                -- TRAIL_STOP_7 | CRASH_STOP_10
  realized_pnl    bigint,                              -- 거래비용 반영 실현손익 (원)
  return_pct      numeric(10,4),

  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

comment on table  positions                 is 'v4 트레일링 손절 판정을 위한 포지션 상태. VIRTUAL은 엔진이 자동 운용(매 실행 시 재생성), REAL은 사용자 기록';
comment on column positions.entry_price     is '최초 매수가. 불타기 트리거(+14%/+28%/+42%)는 평균단가가 아니라 이 값 기준';
comment on column positions.peak_price      is '매수 이후 갱신되는 보유 중 최고 종가. 당일종가/peak-1 <= -7%면 전량 매도';
comment on column positions.pyramid_blocked is 'v4 스펙: 과거에 -7% 손절이 발동된 적 있는 종목은 재진입 후 불타기 안 함';

create index if not exists idx_positions_open on positions (portfolio, status, code);
create index if not exists idx_positions_code on positions (code, entry_date desc);

drop trigger if exists trg_positions_updated on positions;
create trigger trg_positions_updated before update on positions
  for each row execute function set_updated_at();


-- ============================================================================
-- 6. 사용자 데이터
-- ============================================================================
create table if not exists watchlist (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  code            text not null references stocks(code) on delete cascade,
  status          text not null default 'WATCH',       -- WATCH(관심) | HOLD(보유)
  buy_price       bigint,
  quantity        integer,
  buy_date        date,
  target_price    bigint,
  stop_price      bigint,
  memo            text,
  entry_signal    jsonb,                               -- 담을 당시 신호 스냅샷 (사후 검증용)
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (user_id, code)
);

create index if not exists idx_watchlist_user on watchlist (user_id, status);

drop trigger if exists trg_watchlist_updated on watchlist;
create trigger trg_watchlist_updated before update on watchlist
  for each row execute function set_updated_at();


create table if not exists trades (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  code            text not null,
  side            text not null,                       -- BUY | SELL
  price           bigint not null,
  quantity        integer not null,
  trade_date      date not null,
  signal_snapshot jsonb,
  memo            text,
  created_at      timestamptz default now()
);

create index if not exists idx_trades_user on trades (user_id, trade_date desc);


-- ============================================================================
-- 7. 운영 로그
-- ============================================================================
create table if not exists ingest_log (
  id          bigserial primary key,
  job         text not null,        -- price | flow | master | kiwoom | metrics | signals | telegram
  trade_date  date,
  status      text not null,        -- SUCCESS | FAIL | SKIP_HOLIDAY | PARTIAL
  row_count   integer,
  duration_ms integer,
  message     text,
  ran_at      timestamptz default now()
);

create index if not exists idx_ingest_recent on ingest_log (ran_at desc);
create index if not exists idx_ingest_job    on ingest_log (job, trade_date desc);


-- ============================================================================
-- 8. RLS — 반드시 적용
-- ============================================================================
-- 정적 사이트라 Anon Key가 HTML 소스에 노출됩니다.
-- 안전성은 전적으로 여기에 달려 있습니다.
--
-- 시장 데이터: 읽기는 누구나(anon), 쓰기 정책은 만들지 않음
--              → service_role 키(GitHub Secrets)로만 쓰기 가능
-- 개인 데이터: 본인 행만

alter table stocks              enable row level security;
alter table daily_price         enable row level security;
alter table daily_flow          enable row level security;
alter table kiwoom_holder_stats enable row level security;
alter table market_daily        enable row level security;
alter table sector_daily        enable row level security;
alter table daily_metrics       enable row level security;
alter table signals             enable row level security;
alter table positions           enable row level security;
alter table ingest_log          enable row level security;
alter table watchlist           enable row level security;
alter table trades              enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'stocks','daily_price','daily_flow','kiwoom_holder_stats',
    'market_daily','sector_daily','daily_metrics','signals','positions'
  ] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('create policy "public read" on %I for select using (true)', t);
  end loop;
end $$;

-- ingest_log는 운영 정보라 로그인 사용자에게만 공개
drop policy if exists "auth read" on ingest_log;
create policy "auth read" on ingest_log
  for select to authenticated using (true);

-- 개인 데이터
drop policy if exists "own rows" on watchlist;
create policy "own rows" on watchlist for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on trades;
create policy "own rows" on trades for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ============================================================================
-- 9. 편의 뷰 — 웹에서 조인 없이 한 번에 조회
-- ============================================================================

-- 9-1. 종목 일별 통합 (시세 + 수급 + 지표 + 키움)
drop view if exists v_daily;
create view v_daily as
select
  p.trade_date, p.code, s.name, s.market,
  s.sector_krx, s.sector_kis, s.security_type,
  p.close, p.change_pct, p.volume, p.trade_amount,
  p.market_cap, p.listed_shares,
  p.weight_per_share,
  f.foreign_net, f.inst_net, f.smart_net,
  f.fin_inv_net, f.inv_trust_net, f.pension_net, f.pe_net,
  f.individual_net,
  m.ma5, m.ma20, m.ma60, m.ma_aligned,
  m.amt_ratio20, m.vol_ratio20,
  m.is_new_high, m.near_high, m.high_label, m.pct_from_high, m.data_span_days,
  m.foreign_cum5, m.inst_cum5, m.smart_cum5, m.smart_cum5_cap_pct,
  m.flow_lead, m.consec_both_buy, m.inst_lead_field,
  k.accounts, k.avg_buy_price, k.return_pct as kiwoom_return_pct
from daily_price p
join      stocks              s on s.code = p.code
left join daily_flow          f on f.trade_date = p.trade_date and f.code = p.code
left join daily_metrics       m on m.trade_date = p.trade_date and m.code = p.code
left join kiwoom_holder_stats k on k.trade_date = p.trade_date and k.code = p.code;

comment on view v_daily is '웹 조회용 통합 뷰. 매수후보·종목상세가 이 뷰 하나만 보면 됨';

-- 9-2. 최신 신호 + 종목 정보
drop view if exists v_signals_latest;
create view v_signals_latest as
select
  sg.id, sg.trade_date, sg.code, s.name, s.market, s.sector_krx,
  sg.signal_type, sg.grade, sg.score, sg.reason_text, sg.reason,
  p.close, p.change_pct, p.trade_amount, p.market_cap,
  f.foreign_net, f.inst_net,
  m.amt_ratio20, m.high_label, m.smart_cum5, m.smart_cum5_cap_pct, m.flow_lead
from signals sg
join      stocks        s on s.code = sg.code
left join daily_price   p on p.trade_date = sg.trade_date and p.code = sg.code
left join daily_flow    f on f.trade_date = sg.trade_date and f.code = sg.code
left join daily_metrics m on m.trade_date = sg.trade_date and m.code = sg.code;

-- 9-3. 데이터 적재 현황 점검용
drop view if exists v_data_coverage;
create view v_data_coverage as
select
  d.trade_date,
  count(*)                                         as price_rows,
  count(f.code)                                    as flow_rows,
  count(k.code)                                    as kiwoom_rows,
  -- is_partial은 daily_flow에 있습니다(외국인·기관합계 시트가 필터 수집분).
  -- daily_price가 아니라 f를 보아야 합니다.
  count(*) filter (where f.is_partial)             as partial_flow_rows,
  count(m.code)                                    as metrics_rows
from daily_price d
left join daily_flow          f on f.trade_date = d.trade_date and f.code = d.code
left join kiwoom_holder_stats k on k.trade_date = d.trade_date and k.code = d.code
left join daily_metrics       m on m.trade_date = d.trade_date and m.code = d.code
group by d.trade_date
order by d.trade_date desc;

comment on view v_data_coverage is '날짜별 적재 현황. 마이그레이션·수집 후 여기부터 확인';


-- ============================================================================
-- 완료
-- ============================================================================
-- 확인:
--   select table_name from information_schema.tables
--    where table_schema='public' order by 1;
--   select * from v_data_coverage limit 10;
-- ============================================================================
