-- 지배구조: 이사회(사내이사·기타비상무이사) / 최대주주·특수관계인 / 5% 대량보유자 / 소액주주·자기주식 요약 (DART OpenAPI)
create table if not exists public.gov_board (
  code text not null, nm text not null, rcept_no text, stlm_dt date,
  birth_ym text, ofcps text, kind text, fte text, chrg_job text, main_career text, tenure_end text,
  own_shares bigint, own_rate numeric,
  updated_at timestamptz not null default now(), primary key (code, nm));
create table if not exists public.gov_owner (
  code text not null, nm text not null, relate text, stock_knd text not null, rcept_no text, stlm_dt date,
  shares bigint, rate numeric, shares_beg bigint, rate_beg numeric, is_corp boolean,
  updated_at timestamptz not null default now(), primary key (code, nm, stock_knd));
create table if not exists public.gov_major (
  code text not null, repror text not null, rcept_dt date, rcept_no text, report_tp text, shares bigint, rate numeric, rate_chg numeric, reason text,
  updated_at timestamptz not null default now(), primary key (code, repror));
create table if not exists public.gov_summary (
  code text primary key, rcept_no text, stlm_dt date, board_rcept text,
  small_holders bigint, small_holders_rate numeric, small_shares_rate numeric, issued_shares bigint,
  treasury_shares bigint, treasury_rate numeric, checked_at timestamptz not null default now());
do $$
declare t text;
begin
  foreach t in array array['gov_board','gov_owner','gov_major','gov_summary'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists "public read" on public.%I',t);
    execute format('create policy "public read" on public.%I for select using (true)',t);
    begin
      execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated',t);
      execute format('grant select on public.%I to anon, authenticated',t);
    exception when undefined_object then null;
    end;
  end loop;
end $$;
