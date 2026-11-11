-- 스마트머니 매집·이탈 진단(종목상세 카드와 같은 계산)을 종목·기간별로 저장 — 종목후보/종목상세 필터용
create table if not exists public.smx_state (
  code       text not null,
  win        text not null,          -- '63'(3개월) | '126'(6개월) | 'all'(전체)
  as_of      date,
  st         text not null,          -- CONT 매집 지속 | STALL 고점 후 정체 | LEAVE 이탈 진행 | HEAVY 이탈 심화 | OUT 기간 내 순유출 | NONE 매집 이력 없음
  build_eok  numeric,                -- 매집 구간 외+기 순매수(억)
  now_eok    numeric,                -- 기간 시작 대비 외+기 누적(억)
  ratio      numeric,                -- 고점 이후 회수율(고점 이후 순매도 ÷ 매집분)
  peak_date  date,
  since      integer,                -- 고점 이후 거래일 수
  r20_eok    numeric,                -- 최근 20일 외+기(억)
  updated_at timestamptz not null default now(),
  primary key (code, win)
);
alter table public.smx_state add column if not exists peak_eok numeric;  -- 외+기 누적 고점 금액(억, 기간 첫날=0 기준)
alter table public.smx_state add column if not exists lead_nm text, add column if not exists lead_trend text, add column if not exists lead_eok numeric;  -- 주도 세력 · 추세(UP/SLOW/DOWN/REBUY/RESUME/TURN/FLAT) · 매집 구간 순매수(억)
do $$
begin
  alter table public.smx_state enable row level security;
  drop policy if exists "public read" on public.smx_state;
  create policy "public read" on public.smx_state for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.smx_state from anon, authenticated;
    grant select on public.smx_state to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;
