-- ============================================================================
-- STOCK RADAR · 업종 수동 보정 테이블 (sector_override)
-- ============================================================================
-- 배경: stocks.sector_krx(KRX 29분류, 수급주체정리.xlsx 1회성 마이그레이션)는
-- 백테스트 재현성 때문에 절대 건드리지 않기로 했습니다(21_sector_kis_refresh.py
-- 조사 결과, KIS search-stock-info로도 화장품 vs 화학 같은 투자자 체감 분류를
-- 얻을 수 없다는 것도 확인됨 — 표준산업분류는 등록 기준이라 다름).
--
-- 대신 화면에 노출/집계되는 "sector" 값에만 적용되는 수동 보정 테이블을 둡니다.
-- sector_krx 원본은 그대로 두고, sector_override가 있으면 그 값으로 덮어써서
-- 노출합니다.
--
-- ⚠ 중요: 이 보정은 표시(v_sector_stocks)뿐 아니라 업종 RS 랭킹 집계
--   (sector_daily → v_sector_rank, 05_metrics.sql에서 계산)와 신호 엔진
--   (06_signals.sql, sector_daily 조인)에도 동일하게 적용되어야 STEP2 업종
--   클릭→STEP3 필터, v_screener.sector_rs_rank 조인이 계속 일치합니다.
--   이 파일은 화면 뷰만 갱신합니다 — 05_metrics.sql / 06_signals.sql 쪽은
--   해당 파일들을 직접 수정했습니다(v_stock_sector 뷰를 그대로 재사용).
--
-- ⚠ 실행 순서:
--   1) Supabase SQL Editor에 이 파일 붙여넣기 (테이블+뷰 생성, 화면 즉시 반영)
--   2) python 05_compute.py   (전체 기간 재계산 — sector_daily의 업종 RS가
--      보정된 업종 기준으로 다시 그룹핑되도록. 비용이 크면 최근 구간만 먼저
--      돌려도 되지만, 완전히 일치시키려면 결국 전체 재계산이 필요합니다)
-- ============================================================================


-- ── 업종 보정 테이블 ─────────────────────────────────────────────────────────
create table if not exists sector_override (
  code             text primary key references stocks(code),
  sector_override  text not null,
  note             text,
  created_at       timestamptz not null default now()
);

comment on table sector_override is
  'sector_krx가 체감과 다른 종목의 수동 보정. sector_krx 원본은 유지하고, '
  '화면/집계에 노출되는 sector 값만 여기 있으면 이 값으로 덮어씁니다.';

-- ── 종목별 "표시용 업종" 단일 소스 ───────────────────────────────────────────
-- 05_metrics.sql / 06_signals.sql / 화면 뷰가 전부 이 뷰 하나만 참조하도록
-- 통일해서, sector_krx를 참조하는 곳이 늘어나도 보정이 누락되지 않게 합니다.
drop view if exists v_stock_sector cascade;
create view v_stock_sector
with (security_invoker = true) as
select s.code, coalesce(so.sector_override, s.sector_krx) as sector
from stocks s
left join sector_override so on so.code = s.code;


-- ── 시드: 화면에서 확인된 오분류 종목 (화학 → 화장품) ────────────────────────
insert into sector_override (code, sector_override, note) values
  ('278470', '화장품', '에이피알 — sector_krx상 화학으로 분류되어 있으나 화장품 ODM/브랜드'),
  ('161890', '화장품', '한국콜마 — 화장품 ODM. 표준산업분류상 "기타 화학제품 제조업"이라 화학으로 잡힘'),
  ('192820', '화장품', '코스맥스 — 화장품 ODM/OEM. 위와 동일한 사유로 화학으로 잡힘')
on conflict (code) do update set
  sector_override = excluded.sector_override,
  note            = excluded.note;


-- ── STEP3 업종 구성 종목 (보정 반영) ─────────────────────────────────────────
drop view if exists v_screener cascade;
drop view if exists v_sector_stocks cascade;

create view v_sector_stocks
with (security_invoker = true) as
select p.trade_date, vs.sector, p.code, s.name, s.market,
       p.close, p.change_pct, p.trade_amount, p.volume, p.market_cap,
       p.weight_per_share,
       case when p.market_cap > 0
            then round(p.trade_amount::numeric / p.market_cap * 100, 3) end as amt_cap_pct,
       m.vol_ratio20, m.vol_ratio20_prev, m.amt_ratio20,
       m.is_new_high, m.is_new_high_all, m.near_high, m.pct_from_high,
       m.high_period, m.high_period_date, m.high_label,
       m.ma5, m.ma20, m.ma60, m.ma_aligned,
       m.smart_cum5, m.smart_cum20, m.consec_both_buy, m.consec_both_sell,
       m.nonpersonal_net, m.pick_score,
       case when p.high > p.low
            then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1) end as close_pos_pct
from daily_price p
join stocks s on s.code = p.code and s.security_type = 'STOCK'
join v_stock_sector vs on vs.code = p.code
left join daily_metrics m on m.trade_date = p.trade_date and m.code = p.code
where p.close > 0;

create view v_screener
with (security_invoker = true) as
select v.*,
       f.foreign_net, f.inst_net, f.fin_inv_net, f.inv_trust_net,
       f.pension_net, f.pe_net, f.individual_net,
       -(coalesce(f.individual_net,0) + coalesce(f.foreign_net,0)
         + coalesce(f.inst_net,0))                       as corp_other_net,
       sr.rs_rank                                        as sector_rs_rank,
       sg.signal_type, sg.grade, sg.score, sg.reason_text
from v_sector_stocks v
left join daily_flow f  on f.trade_date = v.trade_date and f.code = v.code
left join v_sector_rank sr on sr.sector = v.sector
left join signals sg    on sg.trade_date = v.trade_date and sg.code = v.code
                       and sg.signal_type = 'V4_CANDIDATE';


-- ── 종목 상세 헤더 요약 (v_sector_stocks cascade로 같이 지워져서 재생성) ──────
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


-- ── STEP2 섹터 × 기간별 수급주체 누적 (보정 반영) ────────────────────────────
drop view if exists v_sector_flow cascade;
create view v_sector_flow
with (security_invoker = true) as
with dates as (
  select trade_date, row_number() over (order by trade_date desc) - 1 as ago
  from (select distinct trade_date from daily_price) t
),
periods(period, label, ndays, ord) as (
  values ('1D','오늘',1,1), ('1W','1주',5,2), ('2W','2주',10,3),
         ('1M','1개월',20,4), ('3M','3개월',60,5)
),
f as (
  select vs.sector, d.ago,
         coalesce(fl.foreign_net,0)   as foreign_net,
         coalesce(fl.inst_net,0)      as inst_net,
         coalesce(fl.fin_inv_net,0)   as fin_inv_net,
         coalesce(fl.inv_trust_net,0) as inv_trust_net,
         coalesce(fl.pension_net,0)   as pension_net,
         coalesce(fl.pe_net,0)        as pe_net,
         coalesce(fl.individual_net,0) as individual_net
  from daily_flow fl
  join stocks s on s.code = fl.code and s.security_type = 'STOCK'
  join v_stock_sector vs on vs.code = fl.code and vs.sector is not null
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
       -sum(f.individual_net) as nonpersonal_net
from f
join periods p on f.ago < p.ndays
group by f.sector, p.period, p.label, p.ord;


-- ── STEP2 사이드 "업종 수급주체" 카드 소스 (보정 반영) ───────────────────────
drop view if exists v_sector_flow_daily cascade;
create view v_sector_flow_daily
with (security_invoker = true) as
with d as (
  select vs.sector, fl.trade_date,
         sum(fl.foreign_net)    as foreign_net,
         sum(fl.inst_net)       as inst_net,
         sum(fl.fin_inv_net)    as fin_inv_net,
         sum(fl.inv_trust_net)  as inv_trust_net,
         sum(fl.pension_net)    as pension_net,
         sum(fl.pe_net)         as pe_net,
         sum(fl.individual_net) as individual_net
  from daily_flow fl
  join stocks s on s.code = fl.code and s.security_type = 'STOCK'
  join v_stock_sector vs on vs.code = fl.code and vs.sector is not null
  where fl.trade_date >= '2025-09-01'
  group by vs.sector, fl.trade_date
)
select sector, trade_date, foreign_net, inst_net, fin_inv_net, inv_trust_net,
       pension_net, pe_net, individual_net,
       sum(foreign_net)    over w as foreign_cum,
       sum(inst_net)       over w as inst_cum,
       sum(fin_inv_net)    over w as fin_inv_cum,
       sum(inv_trust_net)  over w as inv_trust_cum,
       sum(pension_net)    over w as pension_cum,
       sum(pe_net)         over w as pe_cum,
       sum(individual_net) over w as individual_cum
from d
window w as (partition by sector order by trade_date rows unbounded preceding);


-- ── anon(브라우저) 읽기 권한 ────────────────────────────────────────────────
do $$
begin
  grant select on v_stock_sector, v_sector_stocks, v_screener, v_stock_summary,
                  v_sector_flow, v_sector_flow_daily to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;
