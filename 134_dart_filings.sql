-- 134_dart_filings.sql — DART 공시 중 수급 관련 이벤트(5% 대량보유·임원 소유보고·자사주·공급부담 등). 쓰기는 Actions만, 읽기 공개.
create table if not exists dart_filings (
  rcept_no     text primary key,          -- DART 접수번호
  rcept_dt     date not null,             -- 접수일
  code         text not null,             -- 종목코드(우리 DB 기준)
  corp_code    text,
  corp_name    text,
  kind         text not null,             -- HOLD5 대량보유 / INSIDER 임원·주요주주 / BUYBACK 자사주 취득 / SELLBACK 자사주 처분·신탁해지 / CANCEL 소각 / SUPPLY 유증·CB·BW·EB / TENDER 공개매수 / MAJOR 최대주주 변경 / ORDER 수주 / CAPEX 증설·시설투자 / STAKE 지분투자 / BONUS 무상증자·분할 / MERGER 합병·양수도 / RISK 악재 경고
  report_nm    text,
  filer        text,                      -- 보고자(운용사·임원·주주 등)
  filer_type   text,                      -- 운용사 / 연기금 / 증권사 / 외국계 / 임원 / 주요주주 / 기타
  report_tp    text,                      -- 일반 / 약식 / 경영참여
  rt_prev      numeric,                   -- 직전 보유비율(%)
  rt_now       numeric,                   -- 보고 후 보유비율(%)
  shares_now   bigint,
  shares_delta bigint,                    -- 증감 주식수(+매수, −매도)
  amount       numeric,                   -- 금액(원, 자사주 취득 예정금액 등)
  reason       text,
  detail       jsonb,
  updated_at   timestamptz not null default now()
);
create index if not exists dart_filings_code_dt on dart_filings (code, rcept_dt desc);
create index if not exists dart_filings_dt_kind on dart_filings (rcept_dt desc, kind);
do $$
begin
  alter table public.dart_filings enable row level security;
  drop policy if exists "public read" on public.dart_filings;
  create policy "public read" on public.dart_filings for select using (true);
  begin
    revoke insert, update, delete, truncate, trigger, references on public.dart_filings from anon, authenticated;
    grant select on public.dart_filings to anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;
