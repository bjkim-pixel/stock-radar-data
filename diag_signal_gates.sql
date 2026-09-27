-- 진단용: 특정 종목·날짜가 추세추종/종가베팅 3단계(가상매수) 조건 중
-- 정확히 어디서 걸렸는지 확인. 06_signals.sql의 base/scored CTE를 그대로
-- 재현하되 특정 종목만 봅니다. 실제 DB에 아무것도 쓰지 않는 조회 전용입니다.

WITH base AS (
  SELECT m.trade_date, m.code, s.name,
         m.vol_ratio20_prev, m.pct_from_high, m.near_high,
         m.ma5, m.ma10, m.ma20, m.ma60, m.rs20_vs_mkt, m.weight_rank, m.cap_rank, m.pick_score,
         p.close, p.high, p.low, p.change_pct, p.market_cap, p.trade_amount,
         CASE WHEN p.high > p.low
              THEN round((p.close - p.low)::numeric / (p.high - p.low) * 100, 1)
              WHEN p.high = p.low AND p.high > 0 THEN 100
         END AS close_pos_pct,
         f.foreign_net, f.inst_net, pg.pgtr_net_amt,
         sd.rs_rank,
         max(m.weight_rank) OVER (PARTITION BY m.trade_date) AS day_n
  FROM daily_metrics m
  JOIN daily_price p ON p.trade_date = m.trade_date AND p.code = m.code
  JOIN stocks s ON s.code = m.code
  JOIN v_stock_sector vs ON vs.code = m.code
  LEFT JOIN sector_daily sd ON sd.trade_date = m.trade_date AND sd.sector = vs.sector AND sd.market='ALL'
  LEFT JOIN daily_flow f ON f.trade_date = m.trade_date AND f.code = m.code
  LEFT JOIN daily_program pg ON pg.trade_date = m.trade_date AND pg.code = m.code
  WHERE m.trade_date = '2026-09-23'
    AND m.code IN ('005935','096770','003490')   -- 삼성전자우 · SK이노베이션 · 대한항공
),
scored AS (
  SELECT base.*,
    row_number() OVER (ORDER BY pick_score ASC, code ASC) AS pick_rank_trend,
    rank() OVER (ORDER BY rs20_vs_mkt DESC NULLS LAST) AS rs20_rank
  FROM base
)
SELECT code, name, close, change_pct, close_pos_pct,
       market_cap >= 1000000000000 AS ok_cap, trade_amount >= 50000000000 AS ok_amt,
       pick_rank_trend, (pick_rank_trend <= 40) AS ok_pick_rank,
       ma5>ma10 AND ma10>ma20 AND ma20>ma60 AS ok_align,
       vol_ratio20_prev, (vol_ratio20_prev BETWEEN 105 AND 250) AS ok_vol_band,
       rs20_vs_mkt, (rs20_vs_mkt > 0) AS ok_rs_positive,
       (near_high OR pct_from_high >= -15) AS ok_near_high_trend,
       (close_pos_pct >= 85 AND change_pct >= 1 AND change_pct < 8) AS ok_trend3_price,
       rs_rank, (rs_rank <= 8) AS ok_sector_rs,
       (pct_from_high >= -5) AS ok_near_high_closebet3,
       foreign_net, inst_net, pgtr_net_amt,
       (coalesce(foreign_net,0)>0 AND coalesce(inst_net,0)>0 AND coalesce(pgtr_net_amt,0)>0) AS ok_closebet3_flow
FROM scored
ORDER BY code;
