-- ============================================================================
-- STOCK RADAR · 웹 조회용 뷰
-- ============================================================================
-- 브라우저(anon key)가 복잡한 SQL 없이 바로 읽을 수 있도록 화면 단위로 뷰를
-- 만들어 둡니다. 집계는 전부 DB에서 끝내고 프론트는 select * 만 합니다.
--
--   v_market_overview   STEP1 시장 — 일별 거래대금·투자자별 순매수 + 누적
--   v_sector_rank       STEP2 섹터 — 업종별 거래대금·1주전 대비·RS
--   v_sector_flow       STEP2 섹터 — 업종 × 기간별 수급주체 누적 순매수
--   v_sector_stocks     STEP3 종목 — 업종별 구성 종목 (최근일)
--   v_screener          조건 스크리너 — 최근일 전 종목 + 지표 + 신호
--   v_stock_chart       종목 상세 — 전 기간 종가·이평·누적 수급
--   v_stock_summary     종목 상세 — 헤더용 요약 1행
--
-- 모든 뷰는 security_invoker=true 로 만들어 원본 테이블의 RLS가 그대로
-- 적용되게 합니다(뷰가 RLS를 우회하지 않도록).
--
-- ⚠ 실행: python 19_apply_views.py  또는 Supabase SQL Editor에 붙여넣기
-- ============================================================================


-- ── STEP1 시장 ───────────────────────────────────────────────────────────────
-- 유니버스 300종목 합계입니다. 실제 시장 전체값(KRX 기준)은 별도 수집이
-- 필요하므로, 절대 수준이 아니라 추세로 읽어야 하는 값입니다.
drop view if exists v_market_overview cascade;
create view v_market_overview
with (security_invoker = true) as
with d as (
  select p.trade_date,
         sum(p.trade_amount)                         as total_amount,
         sum(coalesce(f.foreign_net, 0))             as foreign_net,
         sum(coalesce(f.inst_net, 0))                as inst_net,
         sum(coalesce(f.individual_net, 0))          as individual_net,
         count(*)                                    as stock_count
  from daily_price p
  join stocks s        on s.code = p.code and s.security_type = 'STOCK'
  left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
  where p.close > 0
  group by p.trade_date
)
select trade_date,
       total_amount,
       foreign_net,
       inst_net,
       individual_net,
       stock_count,
       -- 누적 순매수: 선 차트로 "돈이 계속 들어오는가"를 보는 값
       sum(foreign_net)    over w as foreign_cum,
       sum(inst_net)       over w as inst_cum,
       sum(individual_net) over w as individual_cum,
       avg(total_amount)   over (order by trade_date rows between 19 preceding and current row)
                                  as amt_ma20
from d
window w as (order by trade_date rows unbounded preceding);


-- ── STEP2 섹터 랭킹 ──────────────────────────────────────────────────────────
-- "돈이 어디로 몰리고 있는가" — 1주일(5거래일) 전 대비 거래대금 증감이 핵심.
drop view if exists v_sector_rank cascade;
create view v_sector_rank
with (security_invoker = true) as
with base as (
  select trade_date, sector, total_amount, avg_change_pct, stock_count, rs20, rs_rank,
         foreign_net, inst_net, smart_net,
         lag(total_amount, 5) over (partition by sector order by trade_date) as amt_1w,
         avg(total_amount) over (partition by sector order by trade_date
                                 rows between 19 preceding and current row)  as amt_ma20
  from sector_daily
  where market = 'ALL'
),
latest as (select max(trade_date) as d from base)
select b.trade_date,
       b.sector,
       b.total_amount,
       round(b.total_amount::numeric / nullif(sum(b.total_amount) over (), 0) * 100, 2) as share_pct,
       b.amt_1w,
       case when b.amt_1w > 0
            then round((b.total_amount - b.amt_1w)::numeric / b.amt_1w * 100, 2) end    as amt_chg_1w_pct,
       case when b.amt_ma20 > 0
            then round(b.total_amount::numeric / b.amt_ma20 * 100, 1) end               as amt_vs_ma20_pct,
       b.avg_change_pct,
       b.rs20,
       b.rs_rank,
       b.stock_count,
       b.foreign_net,
       b.inst_net,
       b.smart_net
from base b, latest l
where b.trade_date = l.d
order by b.total_amount desc;


-- ── STEP2 섹터 × 기간별 수급주체 누적 ────────────────────────────────────────
-- 어느 주체가 이 섹터를 밀어올리고 있는지. 오늘 / 1주 / 2주 / 1개월 / 3개월.
drop view if exists v_sector_flow cascade;
create view v_sector_flow
with (security_invoker = true) as
with dates as (
  -- 거래일에 순번을 매겨 "N거래일 전"을 정확히 잡습니다(달력일이 아니라).
  select trade_date, row_number() over (order by trade_date desc) - 1 as ago
  from (select distinct trade_date from daily_price) t
),
periods(period, label, ndays, ord) as (
  values ('1D','오늘',1,1), ('1W','1주',5,2), ('2W','2주',10,3),
         ('1M','1개월',20,4), ('3M','3개월',60,5)
),
f as (
  select s.sector_krx as sector, d.ago,
         coalesce(fl.foreign_net,0)   as foreign_net,
         coalesce(fl.inst_net,0)      as inst_net,
         coalesce(fl.fin_inv_net,0)   as fin_inv_net,
         coalesce(fl.inv_trust_net,0) as inv_trust_net,
         coalesce(fl.pension_net,0)   as pension_net,
         coalesce(fl.pe_net,0)        as pe_net,
         coalesce(fl.individual_net,0) as individual_net
  from daily_flow fl
  join stocks s on s.code = fl.code and s.security_type = 'STOCK' and s.sector_krx is not null
  join dates d  on d.trade_date = fl.trade_date
  where d.ago < 60
)
select f.sector, p.period, p.label, p.ord,
       sum(f.foreign_net)    as foreign_net,
       sum(f.inst_net)       as inst_net,
       sum(f.fin_inv_net)    as fin_inv_net,
       sum(f.inv_trust_net)  as inv_trust_net,
       sum(f.pension_net)    as pension_net,
       sum(f.pe_net)         as pe_net,
       sum(f.individual_net) as individual_net,
       -- 비개인 = -(개인). 기타법인 컬럼이 없어도 총합이 0이라 성립합니다.
       -sum(f.individual_net) as nonpersonal_net
from f
join periods p on f.ago < p.ndays
group by f.sector, p.period, p.label, p.ord;


-- ── STEP3 업종 구성 종목 ─────────────────────────────────────────────────────
drop view if exists v_sector_stocks cascade;
create view v_sector_stocks
with (security_invoker = true) as
with latest as (select max(trade_date) as d from daily_price)
select p.trade_date, s.sector_krx as sector, p.code, s.name, s.market,
       p.close, p.change_pct, p.trade_amount, p.volume, p.market_cap,
       p.weight_per_share,
       case when p.market_cap > 0
            then round(p.trade_amount::numeric / p.market_cap * 100, 3) end as amt_cap_pct,
       m.vol_ratio20, m.vol_ratio20_prev, m.amt_ratio20,
       m.is_new_high, m.is_new_high_all, m.near_high, m.pct_from_high, m.high_period,
       m.ma5, m.ma20, m.ma60, m.ma_aligned,
       m.smart_cum5, m.smart_cum20, m.consec_both_buy, m.consec_both_sell,
       m.nonpersonal_net, m.pick_score,
       -- 종가 위치: 당일 저가~고가 중 어디서 끝났나 (종가베팅 판정용)
       case when p.high > p.low
            then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1) end as close_pos_pct
from daily_price p
join stocks s on s.code = p.code and s.security_type = 'STOCK'
left join daily_metrics m on m.trade_date = p.trade_date and m.code = p.code
cross join latest l
where p.trade_date = l.d and p.close > 0;


-- ── 조건 스크리너 ────────────────────────────────────────────────────────────
drop view if exists v_screener cascade;
create view v_screener
with (security_invoker = true) as
select v.*,
       f.foreign_net, f.inst_net, f.fin_inv_net, f.inv_trust_net,
       f.pension_net, f.pe_net, f.individual_net,
       -- 기타법인 = -(개인+외국인+기관). 순매수 총합이 0이라 역산됩니다.
       -(coalesce(f.individual_net,0) + coalesce(f.foreign_net,0)
         + coalesce(f.inst_net,0))                       as corp_other_net,
       sr.rs_rank                                        as sector_rs_rank,
       sg.signal_type, sg.grade, sg.score, sg.reason_text
from v_sector_stocks v
left join daily_flow f  on f.trade_date = v.trade_date and f.code = v.code
left join v_sector_rank sr on sr.sector = v.sector
left join signals sg    on sg.trade_date = v.trade_date and sg.code = v.code
                       and sg.signal_type = 'V4_CANDIDATE';


-- ── 종목 상세 · 전 기간 차트 ─────────────────────────────────────────────────
drop view if exists v_stock_chart cascade;
create view v_stock_chart
with (security_invoker = true) as
select p.code, p.trade_date, p.close, p.high, p.low, p.volume, p.trade_amount,
       p.change_pct, p.market_cap,
       -- 이동평균은 daily_metrics를 쓰지 않고 여기서 직접 계산합니다.
       -- daily_metrics는 용량 때문에 2026-01-01 이후만 보관하므로, 그대로 쓰면
       -- 차트 앞부분의 이평선이 통째로 비어 보입니다.
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
       coalesce(f.foreign_net,0)    as foreign_net,
       coalesce(f.inst_net,0)       as inst_net,
       coalesce(f.individual_net,0) as individual_net
from daily_price p
left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
join stocks s on s.code = p.code and s.security_type = 'STOCK'
where p.close > 0
window
  w    as (partition by p.code order by p.trade_date rows unbounded preceding),
  w5   as (partition by p.code order by p.trade_date rows between   4 preceding and current row),
  w10  as (partition by p.code order by p.trade_date rows between   9 preceding and current row),
  w20  as (partition by p.code order by p.trade_date rows between  19 preceding and current row),
  w60  as (partition by p.code order by p.trade_date rows between  59 preceding and current row),
  w120 as (partition by p.code order by p.trade_date rows between 119 preceding and current row);


drop view if exists v_stock_summary cascade;
create view v_stock_summary
with (security_invoker = true) as
with latest as (select max(trade_date) as d from daily_price)
select v.*, sr.rs_rank as sector_rs_rank,
       f.foreign_net, f.inst_net, f.individual_net
from v_sector_stocks v
left join v_sector_rank sr on sr.sector = v.sector
left join daily_flow f on f.trade_date = v.trade_date and f.code = v.code
cross join latest l
where v.trade_date = l.d;


-- ── anon(브라우저) 읽기 권한 ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'v_market_overview','v_sector_rank','v_sector_flow','v_sector_stocks',
    'v_screener','v_stock_chart','v_stock_summary'
  ] loop
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
