-- ============================================================================
-- STOCK RADAR · 프로그램 매매 수집 인프라
-- ============================================================================
-- 1) daily_program 테이블 신설 (오늘부터 수집 시작)
-- 2) v_stock_chart  — daily_program LEFT JOIN → pgtr_net_amt 노출
-- 3) v_screener     — daily_program LEFT JOIN → pgtr_net_amt 노출
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================


-- ── 1. 테이블 ────────────────────────────────────────────────────────────────
create table if not exists daily_program (
  trade_date    date   not null,
  code          text   not null,
  pgtr_buy_amt  bigint,        -- 프로그램 매수금액 (원)
  pgtr_sell_amt bigint,        -- 프로그램 매도금액 (원)
  pgtr_net_amt  bigint,        -- 프로그램 순매수금액 (원) — 양수=순매수, 음수=순매도
  pgtr_buy_qty  bigint,        -- 프로그램 매수수량
  pgtr_sell_qty bigint,        -- 프로그램 매도수량
  pgtr_net_qty  bigint,        -- 프로그램 순매수수량
  source        text default 'KIS',
  collected_at  timestamptz default now(),
  primary key (trade_date, code)
);

-- RLS: anon 읽기 허용 (다른 테이블과 동일 정책)
alter table daily_program enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename='daily_program' and policyname='anon read daily_program'
  ) then
    execute $p$
      create policy "anon read daily_program" on daily_program
      for select using (true)
    $p$;
  end if;
end $$;


-- ── 2. v_stock_chart 재빌드 — pgtr_net_amt 추가 ─────────────────────────────
drop view if exists v_stock_chart cascade;

create view v_stock_chart
with (security_invoker = true) as
select p.code, p.trade_date, p.close, p.high, p.low, p.volume, p.trade_amount,
       p.change_pct, p.market_cap,
       p.weight_per_share,
       -- 이동평균 직접 계산 (daily_metrics는 2026-01-01 이후만 보관)
       case when count(*) over w5   >= 5   then round(avg(p.close) over w5,   2) end as ma5,
       case when count(*) over w10  >= 10  then round(avg(p.close) over w10,  2) end as ma10,
       case when count(*) over w20  >= 20  then round(avg(p.close) over w20,  2) end as ma20,
       case when count(*) over w60  >= 60  then round(avg(p.close) over w60,  2) end as ma60,
       case when count(*) over w120 >= 120 then round(avg(p.close) over w120, 2) end as ma120,
       -- 주체별 누적 순매수 (상장 이후 전 기간 누적)
       sum(coalesce(f.foreign_net,0))    over w as foreign_cum,
       sum(coalesce(f.inst_net,0))       over w as inst_cum,
       sum(coalesce(f.individual_net,0)) over w as individual_cum,
       sum(coalesce(f.fin_inv_net,0))    over w as fin_inv_cum,
       sum(coalesce(f.inv_trust_net,0))  over w as inv_trust_cum,
       sum(coalesce(f.pension_net,0))    over w as pension_cum,
       sum(coalesce(f.pe_net,0))         over w as pe_cum,
       sum(coalesce(f.corp_other_net,0)) over w as corp_other_cum,
       coalesce(f.foreign_net,0)    as foreign_net,
       coalesce(f.inst_net,0)       as inst_net,
       coalesce(f.individual_net,0) as individual_net,
       -- 프로그램 순매수 (오늘부터 수집, 이전 날짜는 null)
       dp.pgtr_net_amt
from daily_price p
left join daily_flow    f  on f.trade_date  = p.trade_date and f.code  = p.code
left join daily_program dp on dp.trade_date = p.trade_date and dp.code = p.code
join stocks s on s.code = p.code and s.security_type = 'STOCK'
where p.close > 0
window
  w    as (partition by p.code order by p.trade_date rows unbounded preceding),
  w5   as (partition by p.code order by p.trade_date rows between   4 preceding and current row),
  w10  as (partition by p.code order by p.trade_date rows between   9 preceding and current row),
  w20  as (partition by p.code order by p.trade_date rows between  19 preceding and current row),
  w60  as (partition by p.code order by p.trade_date rows between  59 preceding and current row),
  w120 as (partition by p.code order by p.trade_date rows between 119 preceding and current row);


-- ── 3. v_screener 재빌드 — pgtr_net_amt 추가 ─────────────────────────────────
drop view if exists v_screener cascade;

create view v_screener
with (security_invoker = true) as
select v.*,
       f.foreign_net, f.inst_net, f.fin_inv_net, f.inv_trust_net,
       f.pension_net, f.pe_net, f.individual_net,
       -(coalesce(f.individual_net,0) + coalesce(f.foreign_net,0)
         + coalesce(f.inst_net,0))                       as corp_other_net,
       sr.rs_rank                                        as sector_rs_rank,
       sg.signal_type, sg.grade, sg.score, sg.reason_text,
       -- 프로그램 순매수 (오늘부터 수집, 이전 날짜는 null)
       dp.pgtr_net_amt
from v_sector_stocks v
left join daily_flow    f  on f.trade_date  = v.trade_date and f.code  = v.code
left join v_sector_rank sr on sr.sector     = v.sector
left join signals       sg on sg.trade_date = v.trade_date and sg.code = v.code
                          and sg.signal_type = 'V4_CANDIDATE'
left join daily_program dp on dp.trade_date = v.trade_date and dp.code = v.code;


-- ── 4. 권한 ──────────────────────────────────────────────────────────────────
do $$
begin
  grant select on daily_program to anon, authenticated;
  grant select on v_stock_chart  to anon, authenticated;
  grant select on v_screener     to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
