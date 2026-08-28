# -*- coding: utf-8 -*-
"""
STOCK RADAR · 미분류 종목 탐지 (sector_override 누락 종목)
===========================================================
SectorSnapshot GitHub Actions 워크플로에서 호출됩니다.

sector_override 테이블에 행이 없는 종목 = 화면에서 sector_krx(KRX 29분류)로
fallback 표시되는 종목입니다. 신규 종목이 추가됐을 때 분류가 누락되지 않도록
목록을 reports/sector_unclassified.csv 로 내보냅니다.

이 스크립트 자체는 DB를 바꾸지 않습니다 — SELECT 전용.

사용법
  python 46_sector_unclassified_check.py [출력경로.csv]

환경변수
  SUPABASE_DB_URL
"""
import os, sys, csv
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

OUT_PATH = sys.argv[1] if len(sys.argv) > 1 else "sector_unclassified.csv"

SQL = """
SELECT s.code, s.name, s.market,
       p.market_cap,
       s.sector_krx,
       s.sector_kis,
       s.sector_kis_lcls
FROM stocks s
LEFT JOIN sector_override so ON so.code = s.code
LEFT JOIN LATERAL (
  SELECT dp.market_cap FROM daily_price dp
  WHERE dp.code = s.code ORDER BY dp.trade_date DESC LIMIT 1
) p ON true
WHERE s.security_type = 'STOCK'
  AND so.code IS NULL          -- sector_override 없는 종목만
ORDER BY p.market_cap DESC NULLS LAST
"""


def main():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute(SQL)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()

    with open(OUT_PATH, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)

    if rows:
        print(f"⚠️  미분류 종목 {len(rows):,}개 → {OUT_PATH}")
        print("   아래 종목은 sector_override 미설정 → 화면에서 sector_krx(KRX 29분류)로 표시됩니다:")
        for r in rows[:10]:
            code, name, market, mcap = r[0], r[1], r[2], r[3]
            mcap_str = f"{mcap/1e8:,.0f}억" if mcap else "시총미상"
            print(f"   {code} {name} ({market}) {mcap_str}")
        if len(rows) > 10:
            print(f"   ... 외 {len(rows)-10}개 (CSV 참조)")
        # 미분류 종목이 있으면 exit code 2로 종료해 Actions에서 경고 표시
        # (실패가 아닌 '주의' 수준 — workflow는 계속 진행됩니다)
        # exit(2) ← 워크플로를 멈추고 싶지 않으면 주석 유지
    else:
        print(f"✅ 미분류 종목 없음 — 모든 종목에 sector_override가 설정되어 있습니다.")


if __name__ == "__main__":
    main()
