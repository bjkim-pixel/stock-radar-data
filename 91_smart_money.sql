-- ============================================================================
-- STOCK RADAR · 스마트머니(외국인+투신+사모+연기금) 매집·분산 국면 / 신호
-- ============================================================================
-- 91_smart_money.py 가 매 거래일 Compute 후 전 종목을 다시 계산해 채웁니다(계산 로직: sm_core.py,
-- 화면 종목상세 카드는 같은 로직을 브라우저에서 다시 계산 — web/index.html smSeries()).
--   smart_money_state  : 종목당 1행 — 오늘 국면·지속일·평단·점수 (스마트머니 탭 목록용)
--   smart_money_signal : 신호 발생 이력 (B1 매집 돌파 · B2 평단 눌림 · S1 분산 개시 · S2 평단 이탈 · S3 보유 소진 · S4 이익 실현)
-- 추가 수집 없음 — daily_flow(외국인·투신·사모·연기금·개인)와 daily_price만 사용.
-- ============================================================================

create table if not exists smart_money_state (
  code            text primary key,
  name            text,
  market          text,
  sector          text,
  as_of           date,
  close           bigint,
  trade_amount    bigint,
  phase           text,          -- NEUTRAL | ACC | MARKUP | DIST | DOWN
  phase_days      integer,
  phase_prev      text,
  changed_today   boolean,
  quiet           boolean,       -- 조용한 매집(가격 120일 수익률 ≤ 0 인데 SM 매집)
  d_w             numeric(10,3), -- SM 120일 지분 변화 (%p)
  d_20            numeric(10,3), -- SM 20일 지분 변화 (%p)
  ind_w           numeric(10,3), -- 개인 120일 지분 변화 (%p)
  hold_pct        numeric(10,3), -- SM 추정 보유 (상장주식수 대비 %)
  peak_pct        numeric(10,3), -- 이번 사이클 최대 보유 (%)
  cost            numeric(14,2), -- SM 평균 매입단가 (원)
  gap             numeric(10,4), -- 현재가 ÷ 평단 − 1
  buy_days20      integer,
  transfer20      numeric(6,4),  -- 개인 이전율 (최근 20일)
  ret_w           numeric(10,4), -- 120일 수익률
  buy_sig         text, buy_sig_ago integer, buy_sig_date date,
  sell_sig        text, sell_sig_ago integer, sell_sig_date date,
  buy_score       numeric(6,1),
  sell_score      numeric(6,1),
  updated_at      timestamptz default now()
);

create table if not exists smart_money_signal (
  code        text not null,
  trade_date  date not null,
  signal      text not null,
  close       bigint,
  phase       text,
  primary key (code, trade_date, signal)
);
create index if not exists idx_sm_signal_date on smart_money_signal (trade_date desc);

-- RLS: 읽기만 공개 (78번 원칙)
do $$
declare t text;
begin
  foreach t in array array['smart_money_state','smart_money_signal'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
    begin
      execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', t);
      execute format('grant select on public.%I to anon, authenticated', t);
    exception when undefined_object then null;
    end;
  end loop;
end $$;
