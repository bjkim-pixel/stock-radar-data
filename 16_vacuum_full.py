# -*- coding: utf-8 -*-
"""
STOCK RADAR · VACUUM FULL (실제 디스크 공간 회수)
======================================================
15_shrink_universe.py가 STOCK을 2,777→300개로 줄이면서 daily_price/
daily_flow/daily_metrics/signals의 행 수는 85%+ 줄었지만, 일반 VACUUM은
그 공간을 파일 안에서 재사용 가능하게만 표시할 뿐 디스크에 돌려주지
않습니다(DB 전체 크기 710MB 그대로였던 이유). 컬럼 삭제(10_reduce_size.py)
때도 동일한 이유로 공간이 아직 안 돌아왔습니다.

VACUUM FULL은 테이블을 압축된 새 파일로 통째로 재작성해서 실제로 디스크
공간을 돌려줍니다. ACCESS EXCLUSIVE 락이 걸리지만(그 테이블 한정, 짧은
시간) 동시접속자가 없는 개인 프로젝트라 문제 없습니다.

테이블을 하나씩 순서대로 처리해서, 한 시점에 필요한 여유 공간을
"그 테이블의 새(압축된) 크기" 정도로만 최소화합니다(전체 테이블을 한 번에
하지 않음). 실패해도 이미 끝난 테이블은 그대로 반영되어 있습니다.

사용법
  python 16_vacuum_full.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

# 큰 것부터 vs 작은 것부터는 안전성에 큰 차이 없음. 가장 공간을 많이 차지하는
# 순서로 처리해 초반에 최대한 여유 공간을 확보합니다.
TABLES = ["daily_price", "daily_flow", "daily_metrics", "signals",
          "stocks", "kiwoom_holder_stats", "sector_daily", "market_daily"]


def db_size(cur):
    cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
    return cur.fetchone()[0]


def table_size(cur, t):
    cur.execute("SELECT pg_size_pretty(pg_total_relation_size(%s))", (t,))
    return cur.fetchone()[0]


def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True  # VACUUM은 트랜잭션 밖에서만 실행 가능

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")
        print(f"▶ 시작 — DB 전체: {db_size(cur)}\n")

        for t in TABLES:
            before = table_size(cur, t)
            t1 = time.time()
            try:
                cur.execute(f"VACUUM FULL ANALYZE {t}")
                after = table_size(cur, t)
                print(f"  {t:<18} {before:>10} → {after:>10}  ({time.time()-t1:.1f}초)")
            except Exception as ex:
                print(f"  {t:<18} ❌ 실패: {ex}")

        print(f"\n▶ 완료 — DB 전체: {db_size(cur)}")

    conn.close()
    print(f"\n✅ 전체 완료 ({time.time()-t0:.0f}초)")


if __name__ == "__main__":
    main()
