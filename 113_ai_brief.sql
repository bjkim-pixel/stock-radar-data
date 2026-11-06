-- ============================================================================
-- STOCK RADAR · AI 데일리 브리핑 (ai_brief)
-- ============================================================================
-- 113_ai_brief.py 가 장마감 후 하루 2회(16시 데이터 = round 1, 18시 데이터 = round 2)
-- 우리 DB로 다이제스트(숫자·순위·방향 판정 — 코드가 계산)를 만들고, Gemini Flash가
-- 그 다이제스트만 보고 종합 판단·선별(AI)한 결과를 저장합니다.
-- 쓰기는 Actions(서비스 DB URL)만, 읽기는 공개(사이트 "AI 브리핑" 탭). 여러 번 실행해도 안전.
-- ============================================================================
create table if not exists ai_brief (
  trade_date   date        not null,
  round        smallint    not null,              -- 0 = 장중 수동(잠정치), 1 = 16시 데이터(장마감 직후), 2 = 18시 데이터(수급 확정 후)
  created_at   timestamptz not null default now(),
  model        text,                              -- 실제 응답한 Gemini 모델 (실패 시 null)
  status       text        not null default 'ok', -- ok | fallback(AI 실패 → 데이터 요약·규칙 후보만)
  data_partial boolean,                           -- 수집 데이터가 장중 잠정치를 포함했는지
  digest       jsonb       not null,              -- AI에 준 입력(코드가 계산한 숫자)
  result       jsonb,                             -- AI 결과(JSON) — 검증 통과분만
  primary key (trade_date, round)
);
create index if not exists idx_ai_brief_date on ai_brief (trade_date desc, round desc);

do $$
begin
  alter table public.ai_brief enable row level security;
  drop policy if exists "public read" on public.ai_brief;
  create policy "public read" on public.ai_brief for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.ai_brief from anon, authenticated;
    grant select on public.ai_brief to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;

-- 추천 성과 추적: 브리핑이 고른 관심 종목의 이후 수익률(브리핑 기준일 종가 → N거래일 뒤 종가)과 같은 기간 KOSPI 수익률
create table if not exists ai_brief_perf (
  trade_date  date     not null,
  round       smallint not null,
  code        text     not null,
  name        text,
  rank        smallint,
  entry_close numeric,
  days_after  integer,          -- 기준일 이후 지난 거래일 수(최신 종가까지)
  r1 numeric, r5 numeric, r20 numeric, r_last numeric,   -- 종목 수익률(%)
  k1 numeric, k5 numeric, k20 numeric, k_last numeric,   -- 같은 기간 KOSPI 수익률(%)
  updated_at  timestamptz not null default now(),
  primary key (trade_date, round, code)
);
do $$
begin
  alter table public.ai_brief_perf enable row level security;
  drop policy if exists "public read" on public.ai_brief_perf;
  create policy "public read" on public.ai_brief_perf for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.ai_brief_perf from anon, authenticated;
    grant select on public.ai_brief_perf to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;
