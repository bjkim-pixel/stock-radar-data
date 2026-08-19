# -*- coding: utf-8 -*-
"""
STOCK RADAR · 일회성 진단 스크립트
====================================
2026-01-22 이후 매수 신호(TREND_START/NEW_HIGH_BREAK/TREND_CONTINUE)가
전혀 나오지 않는 것으로 보이는 문제를 원인 규명하기 위한 진단 쿼리 모음.

사용법
  python 06_diagnose.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")


def q(cur, title, sql):
    print(f"\n── {title} " + "─" * max(0, 60 - len(title)))
    cur.execute(sql)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    print("  " + " | ".join(cols))
    for r in rows[:40]:
        print("  " + " | ".join(str(v) for v in r))
    if len(rows) > 40:
        print(f"  ... ({len(rows)}행 중 40행만 표시)")
    if not rows:
        print("  (결과 없음)")


def main():
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:

        q(cur, "daily_price 날짜 커버리지",
          "SELECT min(trade_date), max(trade_date), count(distinct trade_date) "
          "FROM daily_price")

        q(cur, "daily_flow 날짜 커버리지",
          "SELECT min(trade_date), max(trade_date), count(distinct trade_date) "
          "FROM daily_flow")

        q(cur, "daily_price 월별 거래일수 & 종목수",
          "SELECT date_trunc('month', trade_date)::date AS month, "
          "count(distinct trade_date) AS days, count(distinct code) AS codes, count(*) AS rows "
          "FROM daily_price GROUP BY 1 ORDER BY 1")

        q(cur, "daily_flow 월별 거래일수 & 종목수 (수급 데이터 끊김 확인)",
          "SELECT date_trunc('month', trade_date)::date AS month, "
          "count(distinct trade_date) AS days, count(distinct code) AS codes, count(*) AS rows "
          "FROM daily_flow GROUP BY 1 ORDER BY 1")

        q(cur, "market_daily market별 행수 & 기간",
          "SELECT market, count(*), min(trade_date), max(trade_date) "
          "FROM market_daily GROUP BY market ORDER BY market")

        q(cur, "daily_metrics 월별 ma_aligned / above_ma20 / smart_cum5_cap_pct NULL 비율",
          "SELECT date_trunc('month', trade_date)::date AS month, "
          "count(*) AS rows, "
          "count(*) FILTER (WHERE ma_aligned) AS ma_aligned_true, "
          "count(*) FILTER (WHERE above_ma20) AS above_ma20_true, "
          "count(*) FILTER (WHERE smart_cum5_cap_pct IS NULL) AS flow_null, "
          "count(*) FILTER (WHERE smart_cum5 > 0) AS smart5_pos "
          "FROM daily_metrics GROUP BY 1 ORDER BY 1")

        q(cur, "TREND_START 조건 중 above_ma20 첫 진입일(prev_above_ma20=false) 월별 건수 "
               "(percentile/거래대금 게이트 적용 전, raw 후보)",
          """
          WITH d AS (
            SELECT trade_date, code, ma_aligned, above_ma20,
                   lag(above_ma20) OVER (PARTITION BY code ORDER BY trade_date) AS prev_above_ma20,
                   amt_ratio20, smart_cum5
            FROM daily_metrics
          )
          SELECT date_trunc('month', trade_date)::date AS month, count(*) AS raw_candidates
          FROM d
          WHERE ma_aligned AND above_ma20 AND coalesce(prev_above_ma20, false) = false
          GROUP BY 1 ORDER BY 1
          """)

        q(cur, "signals 유형별 마지막 발생일",
          "SELECT signal_type, grade, count(*), min(trade_date), max(trade_date) "
          "FROM signals GROUP BY signal_type, grade ORDER BY 1, 2")

        q(cur, "월별 signal 건수 (유형 불문, TREND_START/NEW_HIGH_BREAK/TREND_CONTINUE만)",
          "SELECT date_trunc('month', trade_date)::date AS month, signal_type, count(*) "
          "FROM signals WHERE signal_type IN ('TREND_START','NEW_HIGH_BREAK','TREND_CONTINUE') "
          "GROUP BY 1, 2 ORDER BY 1, 2")

        q(cur, "1월 22일 이후 ma_aligned+above_ma20 첫 진입 후보가 실제 존재하는지 (샘플 5건)",
          """
          WITH d AS (
            SELECT trade_date, code, ma_aligned, above_ma20,
                   lag(above_ma20) OVER (PARTITION BY code ORDER BY trade_date) AS prev_above_ma20
            FROM daily_metrics WHERE trade_date > '2026-01-22'
          )
          SELECT trade_date, code FROM d
          WHERE ma_aligned AND above_ma20 AND coalesce(prev_above_ma20, false) = false
          ORDER BY trade_date LIMIT 5
          """)

    print("\n✅ 진단 완료")


if __name__ == "__main__":
    main()
