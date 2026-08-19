# -*- coding: utf-8 -*-
"""
STOCK RADAR · market NULL 종목 333개 전수 분류 (읽기 전용)
================================================================
12_stock_type_audit.py에서 발견된 market NULL STOCK 333개를 세 유형으로
규칙 기반 분류합니다.

  GARBAGE      코드가 날짜 문자열 패턴(YYYY-MM-DD ...) — 파싱 버그로 생긴
               완전 쓰레기 데이터. 삭제 후보.
  LIKELY_ETF   이름에 ETF 브랜드 접두사(KODEX/TIGER/KBSTAR/ACE/SOL/HANARO/
               KoAct/ARIRANG/KINDEX/TIMEFOLIO/WON/PLUS/RISE/1Q/IBK 등) 또는
               펀드 전략 어휘(액티브/TOP30/밸류체인 등)가 있음 — ETF 재분류 후보.
  REAL_GAP     그 외. 마스터 파일에 없었을 뿐 실제 종목일 가능성 — 이름·시장
               보강 후보 (삭제/재분류 대상 아님).

사용법
  python 13_null_market_triage.py

환경변수
  SUPABASE_DB_URL
"""
import os, re, sys
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

AS_OF = "2026-08-18"

DATE_CODE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
ETF_HINT_RE = re.compile(
    "KODEX|TIGER|KBSTAR|ACE|SOL|HANARO|KoAct|ARIRANG|KINDEX|TIMEFOLIO|"
    "WON|PLUS|RISE|1Q|IBK|마이다스|파워|삼성|미래에셋|한국투자|신한|우리|"
    "액티브|TOP\\s?\\d|밸류체인|코어|배당|성장주|채권혼합|파킹|머니마켓|MMF",
    re.IGNORECASE
)


def main():
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT s.code, s.name, s.first_seen, s.last_seen,
                   p.market_cap, p.volume, p.trade_amount
            FROM stocks s
            LEFT JOIN daily_price p ON p.code = s.code AND p.trade_date = %s
            WHERE s.security_type = 'STOCK' AND s.market IS NULL
            ORDER BY s.code
        """, (AS_OF,))
        rows = cur.fetchall()

    buckets = {"GARBAGE": [], "LIKELY_ETF": [], "REAL_GAP": []}
    for code, name, first_seen, last_seen, mcap, vol, amt in rows:
        if DATE_CODE_RE.match(code) or DATE_CODE_RE.match(name or ""):
            buckets["GARBAGE"].append((code, name, mcap, vol))
        elif name and ETF_HINT_RE.search(name):
            buckets["LIKELY_ETF"].append((code, name, mcap, vol))
        else:
            buckets["REAL_GAP"].append((code, name, mcap, vol))

    print(f"market NULL STOCK 총 {len(rows):,}개 분류 결과\n")
    for label, items in buckets.items():
        traded = sum(1 for _, _, _, v in items if v and v > 0)
        cap_sum = sum((m or 0) for _, _, m, _ in items)
        print(f"── {label}: {len(items):,}개 (그중 {AS_OF} 실거래={traded:,}, "
              f"합산 시총={cap_sum/1e8:,.0f}억) ──")
        for code, name, mcap, vol in items[:15]:
            cap_s = f"{mcap/1e8:,.0f}억" if mcap else "-"
            print(f"    {code:<10} {name or '(없음)':<20} 시총={cap_s:<10} 거래량={vol or 0:,}")
        if len(items) > 15:
            print(f"    ... 외 {len(items)-15:,}개")
        print()

    print("✅ 분류 완료 — REAL_GAP 중 실거래(volume>0)인 항목이 진짜 살려야 할 종목입니다.")


if __name__ == "__main__":
    main()
