# -*- coding: utf-8 -*-
"""
STOCK RADAR · VACUUM (디스크 풀 대응)
========================================
07_fix_market_cap.py가 daily_price 622,951행을 UPDATE하면서 쌓인 dead
tuple + 반복된 05_compute.py 재실행(UPSERT)으로 인한 bloat 때문에
"No space left on device"가 났습니다.

일반 VACUUM은 락을 걸지 않고, 디스크를 새로 늘리지 않은 채 기존 파일
안의 dead tuple 공간을 "재사용 가능"으로 표시만 하므로 디스크가 거의
꽉 찬 상태에서도 보통 실행됩니다(VACUUM FULL과 다름 — FULL은 테이블을
통째로 재작성해서 추가 공간이 필요하므로 여기선 쓰지 않습니다).

사용법
  python 08_vacuum.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

TABLES = [
    "daily_price", "daily_flow", "daily_metrics",
    "market_daily", "sector_daily", "signals",
]


def main():
    # VACUUM은 자체 트랜잭션 안에서 실행할 수 없어서 autocommit 필요.
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True

    with conn.cursor() as cur:
        cur.execute("""
            SELECT relname,
                   pg_size_pretty(pg_total_relation_size(relid)) AS total,
                   n_dead_tup, n_live_tup
            FROM pg_stat_user_tables
            WHERE relname = ANY(%s)
            ORDER BY pg_total_relation_size(relid) DESC
        """, (TABLES,))
        print("── VACUUM 전 테이블 크기 / dead tuple ──")
        for row in cur.fetchall():
            print(f"  {row[0]:<16} {row[1]:>10}   dead={row[2]:,} live={row[3]:,}")

    for t in TABLES:
        t0 = time.time()
        with conn.cursor() as cur:
            print(f"\n▶ VACUUM {t} ...")
            cur.execute(f"VACUUM (VERBOSE, ANALYZE) {t}")
        print(f"  ✅ {t} 완료 ({time.time()-t0:.1f}초)")

    with conn.cursor() as cur:
        cur.execute("""
            SELECT relname,
                   pg_size_pretty(pg_total_relation_size(relid)) AS total,
                   n_dead_tup, n_live_tup
            FROM pg_stat_user_tables
            WHERE relname = ANY(%s)
            ORDER BY pg_total_relation_size(relid) DESC
        """, (TABLES,))
        print("\n── VACUUM 후 테이블 크기 / dead tuple ──")
        for row in cur.fetchall():
            print(f"  {row[0]:<16} {row[1]:>10}   dead={row[2]:,} live={row[3]:,}")

        cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
        print(f"\n  DB 전체 크기: {cur.fetchone()[0]}")

    conn.close()
    print("\n✅ VACUUM 완료")


if __name__ == "__main__":
    main()
