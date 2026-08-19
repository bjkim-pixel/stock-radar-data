# -*- coding: utf-8 -*-
"""
STOCK RADAR · 유니버스를 시총 상위 300개로 고정 축소 (1회성, 파괴적 작업)
================================================================================
2026-08-18 기준 시가총액 상위 300개(STOCK, market_cap>0)를 계산해 그 코드만
남기고, 나머지 STOCK 종목은 stocks에서 DELETE합니다.

stocks.code를 FK로 참조하는 daily_price/daily_flow/daily_metrics/signals는
전부 ON DELETE CASCADE라 자동으로 함께 정리됩니다. kiwoom_holder_stats는
FK가 없어 별도로 지웁니다.

ETF(998개)·PREF(105개)는 이번 정리 대상이 아닙니다 — 이미
03_daily_collect.py/04_backfill.py의 "WHERE security_type='STOCK'" 필터로
평소 수집 대상에서 빠져 있고, 이번 "시총 상위 300" 논의도 STOCK 유니버스에
한정된 것이었기 때문입니다. 다르게 원하시면 알려주세요.

앞으로 daily_collect.py/backfill.py는 load_stocks()가 stocks 테이블에서
직접 종목 목록을 읽으므로, 여기서 지워진 종목은 별도 조치 없이도 자동으로
수집 대상에서 빠집니다(다시 추가하려면 stocks에 수동으로 넣어야 함).

⚠ 파괴적 작업입니다 — 상위 300 밖 종목의 시세·수급·지표·신호 이력이
영구 삭제됩니다. 재수집(KIS 백필)하면 시세/수급은 복구되지만, 그 사이 계산된
daily_metrics/signals는 다시 계산해야 합니다.

사용법
  python 15_shrink_universe.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

AS_OF = "2026-08-18"
KEEP_N = 300

TABLES = ["daily_price", "daily_flow", "daily_metrics", "signals", "kiwoom_holder_stats"]


def sizes(cur, label):
    cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
    print(f"\n{label} — DB 전체: {cur.fetchone()[0]}")
    cur.execute("""
        SELECT relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup
        FROM pg_stat_user_tables
        WHERE relname = ANY(%s)
        ORDER BY pg_total_relation_size(relid) DESC
    """, (TABLES + ["stocks"],))
    for row in cur.fetchall():
        print(f"  {row[0]:<16} {row[1]:>10}   rows={row[2]:,}")


def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")

        sizes(cur, "▶ 정리 전")

        cur.execute("""
            SELECT s.code, s.name, p.market_cap,
                   row_number() OVER (ORDER BY p.market_cap DESC) AS rnk
            FROM daily_price p
            JOIN stocks s ON s.code = p.code
            WHERE s.security_type='STOCK' AND p.trade_date = %s AND p.market_cap > 0
            ORDER BY p.market_cap DESC
            LIMIT %s
        """, (AS_OF, KEEP_N))
        keep_rows = cur.fetchall()
        keep_codes = [r[0] for r in keep_rows]

        if len(keep_codes) < KEEP_N:
            print(f"\n⚠ {AS_OF} 기준 market_cap>0인 STOCK이 {len(keep_codes)}개뿐입니다 "
                  f"(목표 {KEEP_N}개보다 적음). 있는 만큼만 keep list로 사용합니다.")

        boundary = keep_rows[-1]
        print(f"\n▶ 유지 리스트: {len(keep_codes):,}개 (300등 경계: {boundary[0]} {boundary[1]}, "
              f"시총 {boundary[2]/1e8:,.0f}억원)")

        cur.execute("SELECT count(*) FROM stocks WHERE security_type='STOCK'")
        before_stock_n = cur.fetchone()[0]

        print(f"\n[1/3] stocks에서 STOCK 유형 중 상위 {KEEP_N}개 제외 삭제 "
              f"(daily_price/daily_flow/daily_metrics/signals는 CASCADE)...")
        cur.execute("""
            DELETE FROM stocks
            WHERE security_type = 'STOCK' AND NOT (code = ANY(%s))
        """, (keep_codes,))
        print(f"  ✅ stocks {cur.rowcount:,}개 삭제 (STOCK {before_stock_n:,} → "
              f"{before_stock_n - cur.rowcount:,})")

        print(f"\n[2/3] kiwoom_holder_stats 중 stocks에 더는 없는 코드 정리...")
        cur.execute("""
            DELETE FROM kiwoom_holder_stats k
            WHERE NOT EXISTS (SELECT 1 FROM stocks s WHERE s.code = k.code)
        """)
        print(f"  ✅ {cur.rowcount:,}행 삭제")

        print(f"\n[3/3] VACUUM (죽은 행 공간 회수)...")
        for t in TABLES:
            cur.execute(f"VACUUM (ANALYZE) {t}")
        cur.execute("VACUUM (ANALYZE) stocks")
        print("  ✅ 완료")

        sizes(cur, "▶ 정리 후")

    conn.close()
    print(f"\n✅ 전체 완료 ({time.time()-t0:.0f}초)")
    print("   ⚠ 다음 daily_collect.py/backfill.py 실행부터는 이 300개만 대상이 됩니다.")
    print("   ⚠ VACUUM FULL 전까진 heap 공간 일부가 아직 회수 안 됐을 수 있습니다.")


if __name__ == "__main__":
    main()
