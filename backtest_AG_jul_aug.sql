-- ============================================================================
-- A~G 전략 7~8월(2026-07-01~08-29) 전용 백테스트 — 읽기 전용(SELECT만)
-- 시가총액 구간별 매수금액(1천/2천/3천만원) 반영해 실제 원화 손익까지 계산.
-- 종목당 최초 신호 1건만 진입, 고점(당일 고가) 대비 -7%/-10% 트레일링 손절.
-- ============================================================================
with
prices_lag as (
  select code, trade_date, close,
         lag(close, 20) over (partition by code order by trade_date) as close_20d_ago
  from daily_price
  where trade_date between '2026-04-01' and '2026-08-29'
),
stock_ret20 as (
  select p.code, p.trade_date,
         (p.close::numeric / p.close_20d_ago - 1) * 100 as ret20
  from prices_lag p
  join stocks s on s.code = p.code
  where p.close_20d_ago is not null
    and s.security_type = 'STOCK' and s.is_active
    and coalesce(s.is_admin_issue,false) = false
),
mkt_ret20 as (
  select sr.trade_date, avg(sr.ret20) as mkt_ret20
  from stock_ret20 sr
  join daily_price p on p.code = sr.code and p.trade_date = sr.trade_date
  where p.market_cap >= 1000000000000
  group by sr.trade_date
),
stock_rs as (
  select sr.code, sr.trade_date, sr.ret20 - mr.mkt_ret20 as rs20_vs_mkt
  from stock_ret20 sr
  join mkt_ret20 mr on mr.trade_date = sr.trade_date
),
base as (
  select m.trade_date, m.code, s.name,
         m.data_span_days, m.weight_rank,
         m.ma5, m.ma10, m.ma20, m.ma60,
         m.is_new_high_all, m.vol_ratio20_prev, m.foreign_cum5,
         p.close, p.high, p.low, p.change_pct, p.market_cap, p.trade_amount,
         case when p.high > p.low
              then round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1)
         end as close_pos_pct,
         coalesce(rs.rs20_vs_mkt, 0) as rs20_vs_mkt,
         coalesce(df.foreign_net, 0) as foreign_net_today
  from daily_metrics m
  join daily_price p on p.trade_date = m.trade_date and p.code = m.code
  join stocks s on s.code = m.code
  left join stock_rs rs on rs.code = m.code and rs.trade_date = m.trade_date
  left join daily_flow df on df.code = m.code and df.trade_date = m.trade_date
  where m.trade_date between '2026-07-01' and '2026-08-29'   -- ★ 6월 제외
    and s.security_type = 'STOCK' and s.is_active
    and coalesce(s.is_admin_issue,false) = false
    and coalesce(s.is_trade_halt,false) = false
    and p.market_cap >= 1000000000000
    and p.trade_amount >= 50000000000
    and m.weight_rank <= 50
),

-- A: 기존 기준선(신고가돌파 + 정배열)
cand_a as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap, 'A_신고가_정배열' as variant
  from base
  where close_pos_pct >= 70 and change_pct < 12 and is_new_high_all
    and data_span_days >= 20 and ma5 > ma10 and ma10 > ma20 and ma20 > ma60
),
-- B: 완만한 우상향 + 외국인 5일 누적
cand_b as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap, 'B_완만한우상향_외국인누적' as variant
  from base
  where close_pos_pct >= 55 and change_pct < 8 and vol_ratio20_prev < 180
    and ma5 > ma10 and ma10 > ma20 and ma20 > ma60
    and coalesce(foreign_cum5,0) > 0 and data_span_days >= 20
),
-- C: 신고가 제거 + 개별RS>0
cand_c as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap, 'C_정배열_개별RS' as variant
  from base
  where close_pos_pct >= 70 and change_pct < 12 and data_span_days >= 20
    and ma5 > ma10 and ma10 > ma20 and ma20 > ma60 and rs20_vs_mkt > 0
),
-- D: C + 외국인 5일 누적
cand_d as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap, 'D_정배열_개별RS_외국인5일' as variant
  from base
  where close_pos_pct >= 70 and change_pct < 12 and data_span_days >= 20
    and ma5 > ma10 and ma10 > ma20 and ma20 > ma60 and rs20_vs_mkt > 0
    and coalesce(foreign_cum5,0) > 0
),
-- E: C + 소멸형 배제(등락률<10, 거래량비<180)
cand_e as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap, 'E_개별RS_소멸형배제' as variant
  from base
  where close_pos_pct >= 70 and change_pct < 10 and vol_ratio20_prev < 180
    and data_span_days >= 20 and ma5 > ma10 and ma10 > ma20 and ma20 > ma60
    and rs20_vs_mkt > 0
),
-- F: 조용한 우상향 + 당일 외국인 + 군집과열 배제(같은날 후보 3종목 이하)
cand_f_raw as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap,
         count(*) over (partition by trade_date) as day_candidate_count
  from base
  where close_pos_pct >= 50 and change_pct between -1 and 7
    and vol_ratio20_prev < 150 and data_span_days >= 20
    and ma5 > ma10 and ma10 > ma20 and ma20 > ma60
    and rs20_vs_mkt > 0 and foreign_net_today > 0
),
cand_f as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap,
         'F_조용한우상향_당일외국인_과열배제' as variant
  from cand_f_raw where day_candidate_count <= 3
),
-- G: E + 등락률 12% 원복 + 당일 외국인
cand_g as (
  select trade_date, code, name, close, high, low, change_pct, close_pos_pct,
         rs20_vs_mkt, foreign_net_today, foreign_cum5, vol_ratio20_prev,
         is_new_high_all, data_span_days, market_cap, 'G_최종안_당일외국인' as variant
  from base
  where close_pos_pct >= 70 and change_pct < 12 and vol_ratio20_prev < 180
    and data_span_days >= 20 and ma5 > ma10 and ma10 > ma20 and ma20 > ma60
    and rs20_vs_mkt > 0 and foreign_net_today > 0
),

all_cand as (
  select * from cand_a union all select * from cand_b union all select * from cand_c
  union all select * from cand_d union all select * from cand_e
  union all select * from cand_f union all select * from cand_g
),
first_signal as (
  select distinct on (variant, code) variant, code, name, trade_date as entry_date,
         close as entry_price, market_cap
  from all_cand
  order by variant, code, trade_date asc
),
walk as (
  select f.variant, f.code, f.name, f.entry_date, f.entry_price, f.market_cap,
         p.trade_date, p.close, p.high,
         max(p.high) over (partition by f.variant, f.code order by p.trade_date
                            rows between unbounded preceding and current row) as running_peak,
         row_number() over (partition by f.variant, f.code order by p.trade_date) as rn
  from first_signal f
  join daily_price p on p.code = f.code and p.trade_date >= f.entry_date and p.trade_date <= '2026-08-29'
),
with_dd as (
  select *, (close::numeric / running_peak - 1) as dd from walk
),
exit_pick as (
  select distinct on (variant, code) variant, code, trade_date as exit_date, close as exit_price,
         case when dd <= -0.10 then 'CRASH_STOP_10' else 'TRAIL_STOP_7' end as exit_reason
  from with_dd
  where rn > 1 and dd <= -0.07
  order by variant, code, trade_date asc
),
last_close as (
  select distinct on (code) code, trade_date as last_date, close as last_close
  from daily_price where trade_date <= '2026-08-29'
  order by code, trade_date desc
),
sized as (
  select f.variant, f.name, f.code, f.entry_date, f.entry_price,
         coalesce(e.exit_date, lc.last_date)   as exit_date,
         coalesce(e.exit_price, lc.last_close) as exit_price,
         case when e.exit_date is null then 'OPEN' else 'CLOSED' end as status,
         coalesce(e.exit_reason, 'OPEN') as exit_reason,
         case when f.market_cap >= 10000000000000 then 30000000
              when f.market_cap >= 5000000000000  then 20000000
              else 10000000 end as entry_amount
  from first_signal f
  left join exit_pick e on e.variant = f.variant and e.code = f.code
  left join last_close lc on lc.code = f.code
)
select variant, name, code, entry_date, entry_price, exit_date, exit_price, exit_reason, status,
       (entry_amount / entry_price)::int as quantity,
       (entry_amount / entry_price)::int * entry_price as invested,
       round(
         (entry_amount / entry_price)::int * exit_price
         - (entry_amount / entry_price)::int * entry_price
         - ((entry_amount / entry_price)::int * exit_price
            + (entry_amount / entry_price)::int * entry_price) * 0.0012
       )::int as realized_pnl,
       round((exit_price::numeric / entry_price - 1) * 100, 2) as return_pct
from sized
order by variant, entry_date;
