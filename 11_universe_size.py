# -*- coding: utf-8 -*-
"""
STOCK RADAR · 종목 유니버스 축소 검토 (1회성, 읽기 전용)
============================================================
2026-08-18 기준 시가총액 상위 500/600/1000개로 추적 종목을 줄이면
전체 종목 수가 얼마나 줄고, 각 컷오프 경계 종목(500등/600등/1000등)이
무엇인지 확인합니다. 데이터는 전혀 건드리지 않습니다.

사용법
  python 11_universe_size.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

CUTOFFS = [500, 600, 1000]
CAP_THRESHOLDS_EOK = [30000, 10000, 5000, 3000]  # 3조/1조/5천억/3천억
AS_OF = "2026-08-18"


def main():
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:

        cur.execute("SELECT count(*) FROM stocks WHERE security_type='STOCK'")
        total_stocks = cur.fetchone()[0]
        print(f"현재 stocks(STOCK) 전체: {total_stocks:,}개")

        cur.execute("""
            SELECT count(*) FROM daily_price p
            JOIN stocks s ON s.code = p.code
            WHERE s.security_type='STOCK' AND p.trade_date = %s
              AND p.market_cap > 0
        """, (AS_OF,))
        ranked_n = cur.fetchone()[0]
        print(f"{AS_OF} 기준 market_cap>0으로 순위 매길 수 있는 종목: {ranked_n:,}개\n")

        cur.execute("""
            SELECT s.code, s.name, s.market, p.market_cap,
                   row_number() OVER (ORDER BY p.market_cap DESC) AS rnk
            FROM daily_price p
            JOIN stocks s ON s.code = p.code
            WHERE s.security_type='STOCK' AND p.trade_date = %s
              AND p.market_cap > 0
            ORDER BY p.market_cap DESC
        """, (AS_OF,))
        rows = cur.fetchall()

        by_rank = {r[4]: r for r in rows}

        print(f"── 상위 10개 (참고) ──")
        for r in rows[:10]:
            mkt = r[2] or "-"
            print(f"  {r[4]:>5}위  {r[0]}  {r[1]:<12}  {mkt:<7}  시총 {r[3]/1e8:,.0f}억")

        print(f"\n── 컷오프별 결과 ──")
        for c in CUTOFFS:
            if c > len(rows):
                print(f"  상위 {c}개: 전체가 {len(rows)}개뿐이라 사실상 전종목")
                continue
            boundary = by_rank[c]
            next_out = by_rank.get(c + 1)
            print(f"  상위 {c:>4}개  →  {total_stocks:,}개 → {c:,}개로 감소 "
                  f"(전체 대비 {c/total_stocks*100:.1f}%)")
            print(f"           {c}등 경계 종목: {boundary[0]} {boundary[1]} "
                  f"({boundary[2] or '-'})  시총 {boundary[3]/1e8:,.0f}억원")
            if next_out:
                print(f"           바로 밖({c+1}등, 탈락 1호): {next_out[0]} {next_out[1]} "
                      f"({next_out[2] or '-'})  시총 {next_out[3]/1e8:,.0f}억원")

        print(f"\n── 시총 기준선별 몇 등부터 걸리는지 ──")
        for eok in CAP_THRESHOLDS_EOK:
            won = eok * 1e8
            above = [r for r in rows if r[3] >= won]
            n = len(above)
            if n == 0:
                print(f"  시총 {eok:,}억 이상: 0개 (전 종목이 이보다 작음)")
                continue
            last = above[-1]  # 그 기준선 이상인 것 중 가장 낮은 순위
            print(f"  시총 {eok:>6,}억 이상  →  {n:,}개 (전체 대비 {n/total_stocks*100:.1f}%)  "
                  f"경계: {n}등 {last[0]} {last[1]} (시총 {last[3]/1e8:,.0f}억)")

        print(f"\n── 하위 20개 (참고용 — 시총이 얼마나 작은 종목까지 지금 추적 중인지) ──")
        for r in rows[-20:]:
            mkt = r[2] or "-"
            print(f"  {r[4]:>5}위  {r[0]}  {r[1]:<12}  {mkt:<7}  시총 {r[3]/1e8:,.0f}억")

    print("\n✅ 조회 완료")


if __name__ == "__main__":
    main()
