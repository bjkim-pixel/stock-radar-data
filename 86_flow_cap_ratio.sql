-- ============================================================================
-- STOCK RADAR · 종목별 "외+기 누적 순매수 ÷ 그날 시가총액" (3개월/1개월/1주 전 시점)
-- ============================================================================
-- 종목상세 "이 종목의 수급주체별 순매수 거래대금" 표의 [외+기]·[순매수/시총] 열과 같은 정의를
-- 종목후보 표(전 종목)에서 쓰기 위한 사전 계산 테이블입니다.
--   · 누적 순매수 = 종목의 첫 시세일 이후 ~ 기준일까지 (외국인+기관합계 순매수) 합계 — "수급 주체별 누적" 차트와 동일(첫 행 기준 0)
--   · 기준일 = 오늘 기준 N거래일 전: 3개월 60, 1개월 20, 1주 5   (표의 기간 정의와 동일)
--   · 순매수/시총 (2026-10-25 방식 변경) = 일별 (순매수 주식수 ÷ 그날 상장주식수)의 누적합 × 100 (%)
--       순매수 주식수 = 외+기 순매수대금 × 거래량 ÷ 거래대금 (= 대금 ÷ 당일 평균가), 상장주식수 = 시가총액 ÷ 종가
--       → 누적 '원'을 그날 시총으로 나누던 옛 방식은 주가가 급락한 종목이 비율이 부풀려 보였음(가격 효과 제거)
-- 화면은 이 테이블(종목당 1행)만 읽으므로 v_screener 쪽 부하가 늘지 않습니다.
-- 86_flow_cap_ratio.py가 매 거래일 계산 후(Compute 워크플로 완료 직후) refresh_flow_cap_ratio()를 호출합니다.
-- ============================================================================

create table if not exists flow_cap_ratio (
  code    text primary key,
  as_of   date,
  a_3m    bigint, a_1m bigint, a_1w bigint,        -- 누적 순매수 (원)
  r_3m    numeric(12,4), r_1m numeric(12,4), r_1w numeric(12,4)   -- 순매수/시총 (%)
);

create or replace function refresh_flow_cap_ratio() returns integer
language plpgsql as $fn$
declare d0 date; d5 date; d20 date; d60 date; n integer;
begin
  select max(trade_date) filter (where ago = 0),  max(trade_date) filter (where ago = 5),
         max(trade_date) filter (where ago = 20), max(trade_date) filter (where ago = 60)
    into d0, d5, d20, d60
    from (select trade_date, row_number() over (order by trade_date desc) - 1 as ago
            from (select distinct trade_date from daily_price) t) x;
  truncate flow_cap_ratio;
  insert into flow_cap_ratio (code, as_of, a_3m, a_1m, a_1w, r_3m, r_1m, r_1w)
  with fst as (select p.code, min(p.trade_date) as f from daily_price p
                join stocks st on st.code = p.code and st.security_type = 'STOCK'   -- ETF·ETN 제외(화면에는 일반 종목만 나옴)
                where p.close > 0 group by p.code),
  d as (
    select fl.code, fl.trade_date,
           coalesce(fl.foreign_net,0) + coalesce(fl.inst_net,0) as amt,
           case when p.trade_amount > 0 and p.market_cap > 0 and p.close > 0 and p.volume > 0
                then (coalesce(fl.foreign_net,0) + coalesce(fl.inst_net,0))::numeric * p.volume / p.trade_amount
                     / (p.market_cap::numeric / p.close)
                else 0 end as frac
    from daily_flow fl
    join fst on fst.code = fl.code and fl.trade_date > fst.f
    join daily_price p on p.code = fl.code and p.trade_date = fl.trade_date),
  cum as (
    select code,
      sum(amt)  filter (where trade_date <= d60) as c60,
      sum(amt)  filter (where trade_date <= d20) as c20,
      sum(amt)  filter (where trade_date <= d5)  as c5,
      sum(frac) filter (where trade_date <= d60) as f60,
      sum(frac) filter (where trade_date <= d20) as f20,
      sum(frac) filter (where trade_date <= d5)  as f5
    from d group by code)
  select code, d0, c60, c20, c5,
         round(f60 * 100, 4), round(f20 * 100, 4), round(f5 * 100, 4)
  from cum;
  get diagnostics n = row_count;
  return n;
end $fn$;

-- RLS: 읽기만 공개 (78번 원칙)
alter table public.flow_cap_ratio enable row level security;
drop policy if exists "public read" on public.flow_cap_ratio;
create policy "public read" on public.flow_cap_ratio for select using (true);
revoke insert, update, delete, truncate, trigger, references on public.flow_cap_ratio from anon, authenticated;
grant select on public.flow_cap_ratio to anon, authenticated;
revoke execute on function refresh_flow_cap_ratio() from public, anon, authenticated;
