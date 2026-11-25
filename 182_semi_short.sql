-- 반도체 추종 2단계(2026-11-25): KIS 공매도 일별·신용잔고 일별(반도체 업종 종목) + 시장 전체 투자자별(연기금 포함) 순매수
-- 쓰기는 Actions(182_semi_short.py)만, 읽기는 다른 시장 데이터와 같게(데이터 잠금 후엔 로그인한 주인만).
create table if not exists public.kis_short_daily (
  trade_date date not null, code text not null,
  close bigint, vol bigint,
  short_qty bigint,            -- 공매도 체결수량(주)
  short_vol_ratio numeric,     -- 공매도 거래량 비중(%)
  short_amt bigint,            -- 공매도 거래대금(원)
  short_amt_ratio numeric,     -- 공매도 거래대금 비중(%)
  updated_at timestamptz not null default now(),
  primary key (trade_date, code)
);
create table if not exists public.kis_credit_daily (
  trade_date date not null, code text not null,
  loan_qty bigint,             -- 신용 융자 잔고(주)
  loan_amt bigint,             -- 융자 잔고 금액(KIS 단위 그대로 — 삼성전자 잔고수량×주가와 대조하면 만원 단위)
  loan_rate numeric,           -- 융자 잔고율(%)
  loan_gvrt numeric,           -- 융자 공여율(%)
  stln_qty bigint,             -- 대주 잔고(주)
  updated_at timestamptz not null default now(),
  primary key (trade_date, code)
);
create table if not exists public.market_investor_detail (
  trade_date date not null, market text not null,     -- KOSPI | KOSDAQ
  foreign_net numeric, personal numeric, inst numeric,
  fin_inv numeric, inv_trust numeric, pe numeric, bank numeric, insurance numeric, other_fin numeric,
  pension numeric,             -- 연기금 등(KIS '기금')
  etc_corp numeric,
  updated_at timestamptz not null default now(),      -- 단위: 억원
  primary key (trade_date, market)
);
do $$
declare t text;
begin
  foreach t in array array['kis_short_daily','kis_credit_daily','market_investor_detail'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('drop policy if exists "read_owner" on public.%I', t);
    if to_regprocedure('public.is_owner()') is not null and exists (select 1 from pg_class where relname = '_anon_lock_list' and relnamespace = 'public'::regnamespace) then
      execute format('revoke select on public.%I from anon', t);
      execute format('grant select on public.%I to authenticated', t);
      execute format('create policy "read_owner" on public.%I for select to authenticated using ((select public.is_owner()))', t);
      execute format('insert into public._anon_lock_list values (%L, %L) on conflict (relname) do nothing', t, 'r');
    else
      execute format('grant select on public.%I to anon, authenticated', t);
      execute format('create policy "public read" on public.%I for select using (true)', t);
    end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
