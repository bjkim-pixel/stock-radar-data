# -*- coding: utf-8 -*-
"""
STOCK RADAR · DB 용량 상세 진단
==================================
500MB 무료 한도(현재 710MB)를 줄이기 전에, 테이블별 heap/index/toast
크기를 뜯어봐서 어디를 손대야 효과가 큰지 확인합니다. 데이터는 전혀
건드리지 않는 순수 조회 스크립트입니다.

사용법
  python 09_size_audit.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")


def main():
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:

        cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
        print(f"DB 전체 크기: {cur.fetchone()[0]}\n")

        print("── 테이블별 heap / index / toast 크기 ──")
        cur.execute("""
            SELECT relname,
                   pg_size_pretty(pg_relation_size(relid))                              AS heap,
                   pg_size_pretty(pg_indexes_size(relid))                               AS idx,
                   pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid) - pg_indexes_size(relid)) AS toast,
                   pg_size_pretty(pg_total_relation_size(relid))                        AS total,
                   n_live_tup
            FROM pg_stat_user_tables
            ORDER BY pg_total_relation_size(relid) DESC
        """)
        for row in cur.fetchall():
            print(f"  {row[0]:<20} heap={row[1]:>9}  idx={row[2]:>9}  "
                  f"toast={row[3]:>9}  total={row[4]:>9}  rows={row[5]:,}")

        print("\n── 인덱스별 크기 (daily_price / daily_flow / daily_metrics) ──")
        cur.execute("""
            SELECT relname AS table_name, indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
            FROM pg_stat_user_indexes
            WHERE relname IN ('daily_price','daily_flow','daily_metrics','signals')
            ORDER BY pg_relation_size(indexrelid) DESC
        """)
        for row in cur.fetchall():
            print(f"  {row[0]:<16} {row[1]:<28} {row[2]:>10}")

        print("\n── daily_price 평균 row 크기 추정 (컬럼별 평균 바이트) ──")
        cur.execute("""
            SELECT pg_column_size(t.*) FROM daily_price t LIMIT 1000
        """)
        sizes = [r[0] for r in cur.fetchall()]
        if sizes:
            print(f"  샘플 1000행 평균 pg_column_size: {sum(sizes)/len(sizes):.0f} bytes/행 (인덱스 제외 heap 추정치)")

        print("\n── daily_flow 미사용 컬럼(bank_net/insurance_net/corp_other_net/"
              "foreign_net_vol/inst_net_vol) NULL 아닌 값 비율 ──")
        # 2026-08 용량 정리(10_reduce_size.py) 이후엔 이 컬럼들이 삭제되어 있을 수
        # 있으므로, 없으면 조용히 건너뜁니다.
        try:
            cur.execute("""
                SELECT count(*),
                       count(*) FILTER (WHERE bank_net IS NOT NULL AND bank_net <> 0),
                       count(*) FILTER (WHERE insurance_net IS NOT NULL AND insurance_net <> 0),
                       count(*) FILTER (WHERE corp_other_net IS NOT NULL AND corp_other_net <> 0),
                       count(*) FILTER (WHERE foreign_net_vol IS NOT NULL AND foreign_net_vol <> 0),
                       count(*) FILTER (WHERE inst_net_vol IS NOT NULL AND inst_net_vol <> 0)
                FROM daily_flow
            """)
            r = cur.fetchone()
            print(f"  전체 {r[0]:,}행 중 값 있는 행: bank_net={r[1]:,} insurance_net={r[2]:,} "
                  f"corp_other_net={r[3]:,} foreign_net_vol={r[4]:,} inst_net_vol={r[5]:,}")
        except psycopg2.errors.UndefinedColumn:
            conn.rollback()
            print("  (컬럼이 이미 삭제됨 — 용량 정리가 완료된 상태)")

        print("\n── daily_price 연도 × source 별 행수/추정 heap 용량 ──")
        cur.execute("""
            SELECT extract(year from trade_date)::int AS yr, source, count(*),
                   round(avg(pg_column_size(t.*)))::bigint AS avg_bytes,
                   pg_size_pretty(count(*) * round(avg(pg_column_size(t.*)))::bigint) AS est_heap
            FROM daily_price t
            GROUP BY 1, 2 ORDER BY 1, 2
        """)
        for row in cur.fetchall():
            print(f"  {row[0]} · {row[1]:<8} rows={row[2]:>8,}  avg={row[3]:>5}B/행  추정heap={row[4]:>10}")

        print("\n── daily_flow 연도 × source 별 행수/추정 heap 용량 ──")
        cur.execute("""
            SELECT extract(year from trade_date)::int AS yr, source, count(*),
                   round(avg(pg_column_size(t.*)))::bigint AS avg_bytes,
                   pg_size_pretty(count(*) * round(avg(pg_column_size(t.*)))::bigint) AS est_heap
            FROM daily_flow t
            GROUP BY 1, 2 ORDER BY 1, 2
        """)
        for row in cur.fetchall():
            print(f"  {row[0]} · {row[1]:<8} rows={row[2]:>8,}  avg={row[3]:>5}B/행  추정heap={row[4]:>10}")

        print("\n── EXCEL 소스 데이터가 KIS 수집 범위와 겹치는지 (날짜 범위 비교) ──")
        cur.execute("""
            SELECT source, min(trade_date), max(trade_date), count(*)
            FROM daily_price GROUP BY source ORDER BY source
        """)
        for row in cur.fetchall():
            print(f"  daily_price  source={row[0]:<8} {row[1]} ~ {row[2]}  ({row[3]:,}행)")
        cur.execute("""
            SELECT source, min(trade_date), max(trade_date), count(*)
            FROM daily_flow GROUP BY source ORDER BY source
        """)
        for row in cur.fetchall():
            print(f"  daily_flow   source={row[0]:<8} {row[1]} ~ {row[2]}  ({row[3]:,}행)")

        print("\n── kiwoom_holder_stats 크기/행수 ──")
        cur.execute("""
            SELECT count(*), pg_size_pretty(pg_total_relation_size('kiwoom_holder_stats'))
            FROM kiwoom_holder_stats
        """)
        r = cur.fetchone()
        print(f"  {r[0]:,}행, {r[1]}")

    print("\n✅ 진단 완료")


if __name__ == "__main__":
    main()
