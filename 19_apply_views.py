# -*- coding: utf-8 -*-
"""
STOCK RADAR · 웹 조회용 뷰 적용
==================================
19_web_views.sql을 Supabase에 적용합니다. 전부 create or replace / drop-create라
여러 번 실행해도 안전합니다.

사용법
  python 19_apply_views.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

SQL_FILE = "19_web_views.sql"
VIEWS = ["v_market_overview", "v_sector_rank", "v_sector_flow", "v_sector_stocks",
         "v_screener", "v_stock_chart", "v_stock_summary"]


def main():
    t0 = time.time()
    if not os.path.exists(SQL_FILE):
        sys.exit(f"❌ {SQL_FILE}을 찾을 수 없습니다.")
    sql = open(SQL_FILE, encoding="utf-8").read()

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")
        print("▶ 뷰 생성 중...")
        cur.execute(sql)
        print("  ✅ 적용 완료")

        print("\n── 생성 확인 · 행수 ──")
        for v in VIEWS:
            try:
                cur.execute(f"SELECT count(*) FROM {v}")
                print(f"  {v:<20} {cur.fetchone()[0]:>8,}행")
            except Exception as ex:
                print(f"  {v:<20} ❌ {ex}")

        # anon 권한 확인 — 브라우저에서 읽으려면 이게 있어야 합니다.
        cur.execute("""
            SELECT table_name FROM information_schema.role_table_grants
            WHERE grantee = 'anon' AND privilege_type = 'SELECT'
              AND table_name = ANY(%s)
            ORDER BY table_name
        """, (VIEWS,))
        ok = [r[0] for r in cur.fetchall()]
        print(f"\n  anon 읽기 권한: {len(ok)}/{len(VIEWS)}")
        missing = set(VIEWS) - set(ok)
        if missing:
            print(f"  ⚠ 권한 없음: {', '.join(sorted(missing))}")

    conn.close()
    print(f"\n✅ 완료 ({time.time()-t0:.0f}초)")
    print("   다음 단계: web/index.html 상단 CFG.key 에 Supabase anon public 키를 넣으세요.")


if __name__ == "__main__":
    main()
