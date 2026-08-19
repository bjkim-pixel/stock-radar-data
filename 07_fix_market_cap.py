# -*- coding: utf-8 -*-
"""
STOCK RADAR · market_cap 일괄 보정 (1회성)
==============================================
근본 원인: stocks.listed_shares가 처음부터 한 번도 채워진 적이 없어서
(02_migrate.py의 migrate_stocks()가 이 컬럼을 아예 INSERT하지 않음),
04_backfill.py가 market_cap = close * listed_shares 를 계산할 때
listed_shares가 항상 0이었고, 그 결과 daily_price.market_cap이
전체의 약 99.97%에서 0으로 깔려 있었습니다.

이 스크립트는:
  1) KIS "주식현재가 시세" API로 전 종목의 현재 상장주식수(lstn_stcn)를 1회 조회
  2) stocks.listed_shares 를 채움
  3) daily_price에서 market_cap이 비어 있는(NULL 또는 0) 행만
     market_cap = close * listed_shares 로 일괄 재계산

전체 과거 시세를 다시 수집하는 게 아니라 "현재 상장주식수 1회 조회 + SQL
UPDATE"만 하므로 몇 분이면 끝납니다. 상장주식수는 증자·분할이 없는 한
거의 안 바뀌므로, 현재 값을 과거 전체에 적용해도 근사 오차는 미미합니다.

실행 후에는 05_compute.py를 전체 기간으로 다시 돌려야
daily_metrics.smart_cum5_cap_pct와 신호가 올바르게 재계산됩니다.

필요 환경변수
  KIS_APP_KEY, KIS_APP_SECRET, SUPABASE_DB_URL
"""
import os, sys, time, threading
import requests, psycopg2
from psycopg2.extras import execute_values
from concurrent.futures import ThreadPoolExecutor, as_completed

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

WORKERS  = 10
MAX_RPS  = 18
BATCH    = 500

if not KIS_KEY or not KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")


class RateLimiter:
    def __init__(self, max_rps):
        self.min_interval = 1.0 / max_rps
        self.lock = threading.Lock()
        self.last_call = 0.0

    def acquire(self):
        with self.lock:
            now = time.time()
            wait = self.min_interval - (now - self.last_call)
            if wait > 0:
                time.sleep(wait)
            self.last_call = time.time()

_rate = RateLimiter(MAX_RPS)


def safe_int(v, default=0):
    try:
        s = str(v).replace(",", "").strip()
        if s in ("", "-", "None"):
            return default
        return int(float(s))
    except Exception:
        return default


def kis_headers(token, tr_id):
    return {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": f"Bearer {token}",
        "appkey": KIS_KEY,
        "appsecret": KIS_SECRET,
        "tr_id": tr_id,
        "custtype": "P",
    }


def get_token():
    r = requests.post(
        f"{KIS_BASE}/oauth2/tokenP",
        json={"grant_type": "client_credentials",
              "appkey": KIS_KEY, "appsecret": KIS_SECRET},
        timeout=15
    )
    r.raise_for_status()
    d = r.json()
    print(f"  토큰 발급 완료 (만료: {d.get('access_token_token_expired', '?')})")
    return d["access_token"]


def fetch_listed_shares(token, code):
    """현재 상장주식수(lstn_stcn) 1건 조회. 실패 시 None."""
    _rate.acquire()
    try:
        r = requests.get(
            f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price",
            headers=kis_headers(token, "FHKST01010100"),
            params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code},
            timeout=10
        )
        if r.status_code != 200:
            return None
        d = r.json()
        if d.get("rt_cd") != "0":
            return None
        out = d.get("output") or {}
        sh = safe_int(out.get("lstn_stcn"))
        return sh if sh > 0 else None
    except Exception:
        return None


def load_codes():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code FROM stocks WHERE security_type = 'STOCK' ORDER BY code")
        return [r[0] for r in cur.fetchall()]


def main():
    t0 = time.time()
    codes = load_codes()
    print(f"▶ 대상 종목: {len(codes):,}개")

    token = get_token()

    results = {}
    ok = fail = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_listed_shares, token, c): c for c in codes}
        for i, fut in enumerate(as_completed(futs), 1):
            code = futs[fut]
            sh = fut.result()
            if sh:
                results[code] = sh
                ok += 1
            else:
                fail += 1
            if i % 500 == 0:
                print(f"  진행 {i:,}/{len(codes):,} (성공 {ok:,} · 실패 {fail:,})")

    print(f"✅ 상장주식수 조회 완료: 성공 {ok:,} · 실패 {fail:,} ({time.time()-t0:.0f}초)")

    if not results:
        sys.exit("❌ 조회된 상장주식수가 없습니다 — API 응답/자격증명을 확인하세요.")

    # ── stocks.listed_shares 갱신 ────────────────────────────────────────────
    rows = list(results.items())  # (code, shares)
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:
        execute_values(cur, """
            UPDATE stocks AS s SET listed_shares = v.shares
            FROM (VALUES %s) AS v(code, shares)
            WHERE s.code = v.code
        """, rows, page_size=BATCH)
        conn.commit()
        print(f"✅ stocks.listed_shares 갱신: {len(rows):,}건")

        # ── daily_price.market_cap 일괄 재계산 (비어 있는 행만) ──────────────
        cur.execute("SET statement_timeout = '10min'")
        cur.execute("""
            UPDATE daily_price p
            SET market_cap = p.close::bigint * s.listed_shares,
                listed_shares = s.listed_shares
            FROM stocks s
            WHERE s.code = p.code
              AND s.listed_shares > 0
              AND (p.market_cap IS NULL OR p.market_cap <= 0)
        """)
        fixed = cur.rowcount
        conn.commit()
        print(f"✅ daily_price.market_cap 재계산: {fixed:,}행")

    print(f"\n✅ 전체 완료 ({time.time()-t0:.0f}초)")
    print("   ⚠ 다음 단계: 05_compute.py를 전체 기간으로 다시 돌려서 "
          "daily_metrics/signals를 재계산하세요.")


if __name__ == "__main__":
    main()
