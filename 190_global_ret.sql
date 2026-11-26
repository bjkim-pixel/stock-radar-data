-- 글로벌 상승률 순위용 뷰 (2026-11-27) — 우리 DB의 모든 종목·ETF(레버리지·인버스 포함)를 한 표로.
--   한국 종목 = daily_price+stocks(ETF 마스터에 있는 코드는 제외) · 한국 ETF = etf_daily+etf_master · 해외 = us_daily+us_master
--   상승률은 종목마다 "자기 거래일" 기준 N거래일 전 종가 대비(%). r1=오늘 r5=1주 r21=1개월 r63=3개월
--   p* = 하루 전 기준 같은 값(순위 변화 표시용). 거래대금은 원화 환산(해외는 us_master.krw_rate, 엔화 100엔당이면 /100)
--   거래량 0인 행(장 시작 전 미리 채운 행·거래정지일)은 계산에서 뺍니다.
--   security_invoker: 원 테이블의 읽기 권한(로그인 주인 잠금)을 그대로 따릅니다. 여러 번 실행해도 안전.
create or replace view public.v_global_ret with (security_invoker = true) as
with kr as (
  select 'KR'::text mkt, case when s.security_type = 'STOCK' then 'STOCK' else s.security_type end kind,
         d.code, s.name, coalesce(s.sector_kis, s.sector_krx) sub, null::text lev, 'KRW'::text ccy,
         d.trade_date, d.close::numeric close, d.trade_amount::numeric amt_krw
  from public.daily_price d join public.stocks s on s.code = d.code
  where d.trade_date >= (select max(trade_date) from public.daily_price) - 130
    and coalesce(s.is_active, true) and d.close > 0 and coalesce(d.volume, 0) > 0
    and not exists (select 1 from public.etf_master e where e.code = d.code)
), ke as (
  select 'KR', 'ETF', d.code, m.name, coalesce(m.subfield, m.field) sub,
         case when m.flags ~ '인버스' or m.name ~ '인버스|곱버스' then 'I'
              when m.flags ~ '레버리지' or m.name ~ '레버리지|2X|3X' then 'L' end,
         'KRW', d.trade_date, d.close::numeric, d.amount::numeric
  from public.etf_daily d join public.etf_master m on m.code = d.code
  where d.trade_date >= (select max(trade_date) from public.etf_daily where volume > 0) - 130 and d.close > 0 and coalesce(d.volume, 0) > 0
), us as (
  select case when m.kis_excd in ('NAS','NYS','AMS') then 'US' when m.kis_excd = 'HKS' then 'HK'
              when m.kis_excd = 'TSE' then 'JP' else 'CN' end,
         case when m.is_etf then 'ETF' else 'STOCK' end, d.code, coalesce(m.name_ko, m.name_en, d.code),
         case when m.is_etf then null else m.sector end,
         case when (m.info->'si'->>'etp_chas_erng_rt_dbnb') ~ '^-?[0-9.]+$' and (m.info->'si'->>'etp_chas_erng_rt_dbnb')::numeric < 0 then 'I'
              when coalesce(m.name_en, '') ~* '(BEAR|INVERSE|SHORT)' then 'I'
              when (m.info->'si'->>'etp_chas_erng_rt_dbnb') ~ '^-?[0-9.]+$' and (m.info->'si'->>'etp_chas_erng_rt_dbnb')::numeric > 1 then 'L'
              when m.info->'si'->>'sgle_item_lvrg_etp_yn' = 'Y' or coalesce(m.name_en, '') ~* '(BULL|ULTRA|2X|3X)' then 'L' end,
         m.ccy, d.trade_date, d.close::numeric,
         d.amount * case when m.ccy = 'JPY' and m.krw_rate > 50 then m.krw_rate / 100 else m.krw_rate end
  from public.us_daily d join public.us_master m on m.code = d.code
  where d.trade_date >= (select max(trade_date) from public.us_daily) - 130 and d.close > 0 and coalesce(d.volume, 0) > 0
), u as (select * from kr union all select * from ke union all select * from us),
w as (select u.*, row_number() over (partition by mkt, code order by trade_date desc) rn from u),
g as (
  select mkt, kind, code, max(name) name, max(sub) sub, max(lev) lev, max(ccy) ccy,
         max(trade_date) filter (where rn = 1) last_date, count(*) n,
         max(close) filter (where rn = 1) k1,  max(close) filter (where rn = 2) k2,  max(close) filter (where rn = 3) k3,
         max(close) filter (where rn = 6) k6,  max(close) filter (where rn = 7) k7,
         max(close) filter (where rn = 22) k22, max(close) filter (where rn = 23) k23,
         max(close) filter (where rn = 64) k64, max(close) filter (where rn = 65) k65,
         max(amt_krw) filter (where rn = 1) amt, avg(amt_krw) filter (where rn <= 20) amt20
  from w where rn <= 65 group by mkt, kind, code
), mx as (select mkt, max(last_date) d from g group by mkt)
select g.mkt, g.kind, g.code, g.name, g.sub, g.lev, g.ccy, g.last_date, g.k1 as close,
       round((g.k1 / nullif(g.k2, 0) - 1) * 100, 2)  r1,  round((g.k2 / nullif(g.k3, 0) - 1) * 100, 2)  p1,
       round((g.k1 / nullif(g.k6, 0) - 1) * 100, 2)  r5,  round((g.k2 / nullif(g.k7, 0) - 1) * 100, 2)  p5,
       round((g.k1 / nullif(g.k22, 0) - 1) * 100, 2) r21, round((g.k2 / nullif(g.k23, 0) - 1) * 100, 2) p21,
       round((g.k1 / nullif(g.k64, 0) - 1) * 100, 2) r63, round((g.k2 / nullif(g.k65, 0) - 1) * 100, 2) p63,
       round(g.amt) amt, round(g.amt20) amt20, g.n
from g join mx on mx.mkt = g.mkt
where g.last_date >= mx.d - 7;   -- 거래정지·상장폐지 등으로 일주일 넘게 시세가 없는 종목 제외
grant select on public.v_global_ret to anon, authenticated;
notify pgrst, 'reload schema';
