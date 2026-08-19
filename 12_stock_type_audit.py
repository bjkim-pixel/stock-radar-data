# -*- coding: utf-8 -*-
"""
STOCK RADAR · 종목 유형 분석 (읽기 전용)
============================================
하위 종목들을 보니 이름이 코드 숫자 그대로("217910"처럼)이고 시장구분도
없는 종목이 많아 뭔가 이상합니다. 유니버스 축소(500/600/1000) 결정 전에
stocks 테이블에 실제로 어떤 유형들이 섞여 있는지부터 정리합니다.

사용법
  python 12_stock_type_audit.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

AS_OF = "2026-08-18"


def main():
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:

        print("── security_type 분포 ──")
        cur.execute("""
            SELECT security_type, count(*),
                   count(*) FILTER (WHERE market IS NULL) AS market_null,
                   count(*) FILTER (WHERE name = code) AS name_eq_code
            FROM stocks GROUP BY security_type ORDER BY 2 DESC
        """)
        for row in cur.fetchall():
            print(f"  {row[0]:<10} {row[1]:>6,}개   market NULL={row[2]:>5,}   name=code(마스터 미등록)={row[3]:>5,}")

        print("\n── STOCK 유형 중 market IS NULL (마스터 미등록 추정) 샘플 20개 ──")
        cur.execute("""
            SELECT s.code, s.name, s.market, s.first_seen, s.last_seen,
                   p.market_cap, p.trade_amount, p.volume
            FROM stocks s
            LEFT JOIN daily_price p ON p.code = s.code AND p.trade_date = %s
            WHERE s.security_type = 'STOCK' AND s.market IS NULL
            ORDER BY s.code
            LIMIT 20
        """, (AS_OF,))
        for r in cur.fetchall():
            cap = f"{r[5]/1e8:,.0f}억" if r[5] else "-"
            amt = f"{r[6]/1e8:,.1f}억" if r[6] else "-"
            print(f"  {r[0]}  이름={r[1]:<10}  시총={cap:<8}  {AS_OF}거래대금={amt:<10}  거래량={r[7] or 0:,}")

        print(f"\n── market IS NULL 종목의 {AS_OF} 실제 거래 여부 ──")
        cur.execute("""
            SELECT count(*) AS total_null_market,
                   count(*) FILTER (WHERE p.trade_date IS NOT NULL) AS has_price_row,
                   count(*) FILTER (WHERE p.volume > 0) AS actually_traded,
                   count(*) FILTER (WHERE p.market_cap > 0) AS has_market_cap
            FROM stocks s
            LEFT JOIN daily_price p ON p.code = s.code AND p.trade_date = %s
            WHERE s.security_type = 'STOCK' AND s.market IS NULL
        """, (AS_OF,))
        r = cur.fetchone()
        print(f"  market NULL 종목: {r[0]:,}개 중 {AS_OF}에 시세행 존재={r[1]:,} · "
              f"실제 거래량>0={r[2]:,} · 시총>0={r[3]:,}")

        print("\n── 이름 패턴으로 본 비-보통주 추정 (우선주/신주인수권/기타) ──")
        cur.execute("""
            SELECT
              count(*) FILTER (WHERE name ~ '[0-9]?우[A-Z]?$') AS pref_like,
              count(*) FILTER (WHERE name ~ '신주인수권|워런트|WR$') AS rights_like,
              count(*) FILTER (WHERE name ~ '스팩|SPAC') AS spac_like,
              count(*) FILTER (WHERE name ~ '리츠|REIT') AS reit_like,
              count(*)
            FROM stocks WHERE security_type='STOCK'
        """)
        r = cur.fetchone()
        print(f"  우선주 추정(이름에 '우'): {r[0]:,} · 신주인수권/워런트: {r[1]:,} · "
              f"스팩: {r[2]:,} · 리츠: {r[3]:,}  (STOCK 전체 {r[4]:,})")

        print("\n── market이 있는 STOCK만 놓고 봤을 때 KOSPI/KOSDAQ/KONEX/기타 분포 ──")
        cur.execute("""
            SELECT market, count(*) FROM stocks
            WHERE security_type='STOCK' AND market IS NOT NULL
            GROUP BY market ORDER BY 2 DESC
        """)
        for row in cur.fetchall():
            print(f"  {row[0]:<10} {row[1]:>6,}개")

        print(f"\n── 하위 시총 20개 중 실제로 {AS_OF}에 거래(volume>0)된 종목이 몇 개인지 ──")
        cur.execute("""
            WITH ranked AS (
              SELECT s.code, s.name, s.market, p.market_cap, p.volume,
                     row_number() OVER (ORDER BY p.market_cap DESC) AS rnk
              FROM daily_price p
              JOIN stocks s ON s.code = p.code
              WHERE s.security_type='STOCK' AND p.trade_date = %s AND p.market_cap > 0
            )
            SELECT count(*), count(*) FILTER (WHERE volume > 0)
            FROM ranked WHERE rnk > (SELECT count(*) - 20 FROM ranked)
        """, (AS_OF,))
        r = cur.fetchone()
        print(f"  하위 20개 중 거래량>0: {r[1]}/{r[0]}")

    print("\n✅ 분석 완료")


if __name__ == "__main__":
    main()
