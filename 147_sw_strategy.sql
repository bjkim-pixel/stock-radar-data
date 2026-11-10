-- 국면 전환 전략(횡보장 전략 페이지): 매일의 시장 상태·신호·모의 성과와 조건 충족/보유 종목
create table if not exists public.sw_daily (
  trade_date  date primary key,
  kospi       numeric, ma60 numeric, box_hi numeric, box_lo numeric,
  pos20       numeric,              -- 20일 박스 내 위치(0~1, 밖이면 <0 또는 >1)
  ret3        numeric,              -- 코스피 최근 3거래일 수익률(%)
  trend_down  boolean,              -- 코스피 < 60일선
  gate_open   boolean,              -- ① 선별 매수 허용(위치 30% 초과)
  inv_signal  boolean,              -- ② 오늘 신규 인버스 신호(60일선 아래 + 3일 +4% 이상)
  inv_hold    boolean,              -- ② 오늘 종가 기준 인버스 보유 중
  inv_left    integer,              -- ② 남은 보유 거래일
  n_new       integer, n_hold integer,
  r1 numeric, r2 numeric, r3 numeric, r4 numeric, rk numeric,        -- 그날 수익률(%): ①②③④·코스피
  eq1 numeric, eq2 numeric, eq3 numeric, eq4 numeric, eqk numeric,   -- 2026-08-03=100 누적
  is_live     boolean not null default false,                        -- 페이지 공개(2026-11-10) 이후 = 사후 검증이 아닌 실제 추적
  updated_at  timestamptz not null default now()
);
create table if not exists public.sw_picks (
  trade_date  date not null,
  code        text not null,
  kind        text not null,        -- new(오늘 조건 충족) | hold(이전 충족분 보유 중) | basket(④ 바스켓)
  entry_date  date, entry_close numeric, close numeric,
  chg numeric, amt_eok numeric, cap_eok numeric, sm5_pct numeric, fo20_pct numeric,
  weight      numeric,              -- ① 안에서의 비중(%)
  days_left   integer,              -- 남은 보유 거래일
  vol20       numeric,              -- 최근 20일 하루 등락폭 평균(%)
  nxt_ok      boolean,              -- 대체거래소(NXT) 거래 가능 = 20시 마감
  primary key (trade_date, code, kind)
);
alter table public.stocks add column if not exists nxt_ok boolean, add column if not exists nxt_checked date;
do $$
declare t text;
begin
  foreach t in array array['sw_daily','sw_picks'] loop
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
