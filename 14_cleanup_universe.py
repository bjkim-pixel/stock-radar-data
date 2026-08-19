# -*- coding: utf-8 -*-
"""
STOCK RADAR · 종목 유니버스 정리 (GARBAGE 삭제 + ETF 재분류)
==================================================================
13_null_market_triage.py와 동일한 규칙으로 market NULL STOCK 333개를
분류해서:
  - GARBAGE   (날짜-문자열 코드, 실거래 0)  → stocks에서 DELETE
  - LIKELY_ETF(ETF 브랜드/전략 이름인데 STOCK으로 분류됨) → security_type을 ETF로 UPDATE
  - REAL_GAP  (그 외, 진짜 종목 추정)       → 그대로 둠 (변경 없음)

ETF로 재분류되면 03_daily_collect.py/04_backfill.py의 기존
"WHERE security_type='STOCK'" 필터에 의해 자동으로 일별 수집·신호 계산
대상에서 빠집니다 — 이 스크립트가 직접 수집을 막는 게 아니라 분류만
바로잡는 것입니다.

실행 전/후 stocks 유형별 카운트를 찍고, 13_null_market_triage.py 때 본
숫자(GARBAGE 65 · LIKELY_ETF 93)와 크게 다르면 경고합니다(그 사이 데이터가
바뀌었을 수 있으니 실행 전 확인용).

사용법
  python 14_cleanup_universe.py

환경변수
  SUPABASE_DB_URL
"""
import os, re, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

DATE_CODE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
ETF_HINT_RE = re.compile(
    "KODEX|TIGER|KBSTAR|ACE|SOL|HANARO|KoAct|ARIRANG|KINDEX|TIMEFOLIO|"
    "WON|PLUS|RISE|1Q|IBK|마이다스|파워|삼성|미래에셋|한국투자|신한|우리|"
    "액티브|TOP\\s?\\d|밸류체인|코어|배당|성장주|채권혼합|파킹|머니마켓|MMF",
    re.IGNORECASE
)

EXPECTED = {"GARBAGE": 65, "LIKELY_ETF": 93, "REAL_GAP": 175}


def classify(code, name):
    if DATE_CODE_RE.match(code) or DATE_CODE_RE.match(name or ""):
        return "GARBAGE"
    if name and ETF_HINT_RE.search(name):
        return "LIKELY_ETF"
    return "REAL_GAP"


def type_counts(cur):
    cur.execute("SELECT security_type, count(*) FROM stocks GROUP BY security_type ORDER BY 2 DESC")
    return cur.fetchall()


def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True

    with conn.cursor() as cur:
        print("── 정리 전 security_type 분포 ──")
        for row in type_counts(cur):
            print(f"  {row[0]:<10} {row[1]:>6,}개")

        cur.execute("""
            SELECT code, name FROM stocks
            WHERE security_type = 'STOCK' AND market IS NULL
        """)
        rows = cur.fetchall()

        garbage, likely_etf, real_gap = [], [], []
        for code, name in rows:
            bucket = classify(code, name)
            {"GARBAGE": garbage, "LIKELY_ETF": likely_etf, "REAL_GAP": real_gap}[bucket].append(code)

        print(f"\n분류 결과: GARBAGE={len(garbage):,} · LIKELY_ETF={len(likely_etf):,} · "
              f"REAL_GAP={len(real_gap):,} (총 {len(rows):,})")
        for label, actual in (("GARBAGE", len(garbage)), ("LIKELY_ETF", len(likely_etf))):
            if abs(actual - EXPECTED[label]) > max(5, EXPECTED[label] * 0.1):
                print(f"  ⚠ {label} 개수가 지난 진단({EXPECTED[label]})과 크게 다릅니다 "
                      f"({actual}) — 그 사이 데이터가 바뀐 것 같습니다. 계속 진행합니다.")

        if garbage:
            print(f"\n[1/2] GARBAGE {len(garbage):,}개 stocks에서 삭제...")
            cur.execute("DELETE FROM stocks WHERE code = ANY(%s)", (garbage,))
            print(f"  ✅ {cur.rowcount:,}개 삭제 (daily_price/daily_flow는 CASCADE로 함께 정리됨)")
        else:
            print("\n[1/2] GARBAGE 없음 — 건너뜀")

        if likely_etf:
            print(f"\n[2/2] LIKELY_ETF {len(likely_etf):,}개 security_type을 ETF로 변경...")
            cur.execute("""
                UPDATE stocks SET security_type = 'ETF', updated_at = now()
                WHERE code = ANY(%s)
            """, (likely_etf,))
            print(f"  ✅ {cur.rowcount:,}개 재분류")
        else:
            print("\n[2/2] LIKELY_ETF 없음 — 건너뜀")

        print("\n── 정리 후 security_type 분포 ──")
        for row in type_counts(cur):
            print(f"  {row[0]:<10} {row[1]:>6,}개")

        # 재분류/삭제된 코드가 daily_price/daily_flow/daily_metrics/signals에
        # 남아있는 과거 행이 있는지 참고용으로 확인 (지우진 않음 — 원본 이력 보존)
        if likely_etf:
            cur.execute("SELECT count(*) FROM daily_price WHERE code = ANY(%s)", (likely_etf,))
            n_price = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM daily_metrics WHERE code = ANY(%s)", (likely_etf,))
            n_metrics = cur.fetchone()[0]
            print(f"\n  참고: ETF로 재분류된 종목들의 기존 daily_price {n_price:,}행 / "
                  f"daily_metrics {n_metrics:,}행은 그대로 남아있습니다 (삭제 안 함). "
                  f"앞으로의 신규 수집·신호 계산 대상에서만 빠집니다.")

    conn.close()
    print(f"\n✅ 전체 완료 ({time.time()-t0:.0f}초)")
    print("   다음 단계: 11_universe_size.py를 다시 돌려서 ETF 빠진 정확한 "
          "시총 500/600/1000 컷오프를 확인하세요.")


if __name__ == "__main__":
    main()
