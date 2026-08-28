# -*- coding: utf-8 -*-
"""
STOCK RADAR · 업종 분류 스냅샷 CSV 내보내기 (읽기 전용)
=========================================================
"참고 사이트(스탁이지)의 테마형 대분류(반도체/2차전지/K-컬처 등 15~20개)에 맞춰
업종 분류를 전면 개편하고 싶다"는 요청의 1차 조사 자료입니다.

지금 화면에 실제 노출되는 업종(=sector_override가 있으면 그 값, 없으면
sector_krx — 28_sector_override.sql의 v_stock_sector 로직과 동일)과,
21_sector_kis_refresh.py가 KIS 주식기본조회로 채워둔 sector_kis/sector_kis_lcls를
나란히 CSV로 뽑아, 종목별로 어느 값이 스탁이지 스타일 테마명에 가장 가까운지
사람이(또는 Claude가) 검토할 수 있게 합니다.

이 스크립트 자체는 DB를 전혀 바꾸지 않습니다 — SELECT만 합니다.

사용법
  python 44_sector_snapshot_export.py [출력경로.csv]   (기본: sector_snapshot.csv)

환경변수
  SUPABASE_DB_URL
"""
import os, sys, csv
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

OUT_PATH = sys.argv[1] if len(sys.argv) > 1 else "sector_snapshot.csv"

# daily_price에서 종목별 "가장 최근" market_cap 한 행만 LATERAL로 뽑습니다
# (전체 조인 후 그룹핑보다 종목 수(수백개) 기준으로 훨씬 가볍습니다).
SQL = """
SELECT s.code, s.name, s.market,
       p.market_cap,
       s.sector_krx,
       so.sector_override,
       coalesce(so.sector_override, s.sector_krx) AS sector_display,
       s.sector_kis, s.sector_kis_lcls
FROM stocks s
LEFT JOIN sector_override so ON so.code = s.code
LEFT JOIN LATERAL (
  SELECT dp.market_cap FROM daily_price dp
  WHERE dp.code = s.code ORDER BY dp.trade_date DESC LIMIT 1
) p ON true
WHERE s.security_type = 'STOCK'
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

    n_kis = sum(1 for r in rows if r[7] or r[8])
    n_override = sum(1 for r in rows if r[5])
    print(f"✅ {len(rows):,}개 종목 → {OUT_PATH}")
    print(f"   sector_kis 확보: {n_kis:,}개 · sector_override 적용: {n_override:,}개")


if __name__ == "__main__":
    main()
