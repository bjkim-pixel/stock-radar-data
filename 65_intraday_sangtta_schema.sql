-- ============================================================================
-- STOCK RADAR · 전략 성과2 — 상따(상한가 따라잡기) 가상매매 스키마
-- ============================================================================
-- 기존 스윙 엔진(positions/signals, VIRTUAL/REAL 포트폴리오)과는 완전히 별도의
-- 실시간 인트라데이 엔진용 테이블입니다. 충돌 없이 독립 운용됩니다.
--
-- 참고: sangtta_virtual_trading_spec.md (전략성과2 설계 스펙)
-- ============================================================================

-- @@STEP: 오늘의 후보 (장전/NXT/정규장초반/장중신규 단계별 갱신)
CREATE TABLE IF NOT EXISTS intraday_candidates (
    trade_date  date        NOT NULL,
    code        text        NOT NULL,
    source      text        NOT NULL,   -- PRE_MARKET / NXT / REGULAR / NEW_DETECTED
  rank        int,
    snapshot    jsonb,                  -- 해당 단계에서의 근거 지표 스냅샷
  created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trade_date, code, source)
  );

CREATE INDEX IF NOT EXISTS idx_intraday_candidates_date
  ON intraday_candidates (trade_date);

-- @@STEP: 가상매매 포지션 (상따 전용)
CREATE TABLE IF NOT EXISTS intraday_positions (
    id            bigserial   PRIMARY KEY,
    portfolio     text        NOT NULL DEFAULT 'INTRADAY_SANGTTA',
    code          text        NOT NULL,
    name          text,
    trade_date    date        NOT NULL,

  entry_time    timestamptz NOT NULL,
    entry_price   int         NOT NULL,
    entry_reason  jsonb,      -- entry_grade, source, execution_strength,
                             -- large_prints_1min, minute_volume_ratio,
                             -- change_pct_at_entry, reason_text

  peak_price    int,
    peak_time     timestamptz,

  status        text        NOT NULL DEFAULT 'OPEN',  -- OPEN / CLOSED

  exit_time     timestamptz,
    exit_price    int,
    exit_reason   jsonb,      -- exit_type(HARD_STOP/TRAILING_STOP/MARKET_CLOSE),
                             -- peak_price, peak_time, hold_minutes, reason_text

  realized_pnl  bigint,
    return_pct    numeric
  );

CREATE INDEX IF NOT EXISTS idx_intraday_positions_date_status
  ON intraday_positions (trade_date, status);
CREATE INDEX IF NOT EXISTS idx_intraday_positions_code
  ON intraday_positions (code, trade_date);

-- @@STEP: 당일 배치성 틱 로그 (장마감 후 TRUNCATE 대상 — 영구 보관 아님)
CREATE TABLE IF NOT EXISTS intraday_tick_log (
    trade_date      date        NOT NULL,
    code            text        NOT NULL,
    ts              timestamptz NOT NULL,
    price           int,
    exec_strength   numeric,    -- 체결강도(매수체결/매도체결 비율)
  minute_volume   bigint      -- 해당 분 누적 거래대금
  );

CREATE INDEX IF NOT EXISTS idx_intraday_tick_log_date_code
  ON intraday_tick_log (trade_date, code, ts);

-- @@STEP: 진입/청산 전후 이벤트 요약 (영구 보관 — 신호 임계값 튜닝용)
-- 원본 틱은 지워도 되지만, 실제 매수/매도 판단이 일어난 전후 구간만은
-- 요약해서 남겨 나중에 임계값을 실증적으로 검증할 수 있게 합니다.
CREATE TABLE IF NOT EXISTS intraday_decision_events (
    id            bigserial   PRIMARY KEY,
    position_id   bigint      REFERENCES intraday_positions(id),
    event_type    text        NOT NULL,  -- ENTRY / EXIT
  event_time    timestamptz NOT NULL,
    metrics       jsonb       NOT NULL   -- 그 시점 체결강도/분당거래액/틱간격 등 스냅샷
);

CREATE INDEX IF NOT EXISTS idx_intraday_decision_events_position
  ON intraday_decision_events (position_id);

-- @@STEP: 일별 정산
CREATE TABLE IF NOT EXISTS intraday_daily_summary (
    trade_date      date    PRIMARY KEY,
    total_buy_amt   bigint  NOT NULL DEFAULT 0,
    total_sell_amt  bigint  NOT NULL DEFAULT 0,
    realized_pnl    bigint  NOT NULL DEFAULT 0,
    return_pct      numeric,
    trade_count     int     NOT NULL DEFAULT 0,
    win_count       int     NOT NULL DEFAULT 0,
    loss_count      int     NOT NULL DEFAULT 0
  );
