# -*- coding: utf-8 -*-
"""
STOCK RADAR · NXT(넥스트레이드) 애프터마켓 마감 시세 수집
==========================================================================
GitHub Actions에서 매 거래일 20:10 KST(11:10 UTC, NXT 애프터마켓 종료
20:00 이후)에 자동 실행됩니다. "종가베팅2" 전략(06_signals.sql)이 쓰는
daily_price.nxt_close / nxt_change_pct 두 컬럼만 채웁니다.

⚠ 사전 준비: 69_nxt_price_columns.sql을 먼저 Supabase SQL Editor에서
  실행해서 두 컬럼을 만들어둬야 합니다(Claude는 DB 스키마 변경 권한이 없어
  대신 실행할 수 없습니다).

⚠ market_div="NX" 파라미터는 relay-server(server.js stageNxt())와
  66_intraday_candidates.py가 이미 쓰고 있는 것과 동일하지만, 실거래
  응답으로 검증된 적은 없습니다(그 두 곳 주석 참고). 이 스크립트도 같은
  가정을 그대로 씁니다 — 최초 실행 로그(수집 성공/스킵 건수, --debug
  옵션의 원본 응답)로 정상 동작하는지 확인하세요.

필요 환경변수
  KIS_APP_KEY / KIS_APP_SECRET   KIS Open API 앱키·시크릿
  KIS_ACCESS_TOKEN               (선택) 같은 워크플로 안에서 이미 발급받은
                                  토큰 재사용 — 없으면 새로 발급
  SUPABASE_DB_URL                Supabase Session pooler URI

사용법
  python 70_nxt_collect.py                  # 오늘 수집
  python 70_nxt_collect.py 20260911         # 특정 날짜 재수집
  python 70_nxt_collect.py --debug 005930   # 삼성전자 API 원본 응답 확인
"""
import os, sys, time, datetime
import requests, psycopg2
from psycopg2.extras import execute_values

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

MAX_RPS = 14   # relay-server(server.js) KIS_REST_RATE_MIN_INTERVAL_MS=70ms와 동급
BATCH   = 500

DEBUG_MODE  = False
DEBUG_CODE  = None
TARGET_DATE = datetime.date.today().strftime("%Y%m%d")

_args = sys.argv[1:]
if _args:
    if _args[0] == "--debug":
        DEBUG_MODE = True
        DEBUG_CODE = _args[1] if len(_args) > 1 else "005930"
    elif _args[0].isdigit() and len(_args[0]) == 8:
        TARGET_DATE = _args[0]

TARGET_DATE_ISO = f"{TARGET_DATE[:4]}-{TARGET_DATE[4:6]}-{TARGET_DATE[6:]}"

if not KIS_KEY or not KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

print(f"▶ NXT 마감 시세 수집: {TARGET_DATE_ISO}")


def safe_num(v, default=None):
    try:
        s = str(v).replace(",", "").strip()
        return float(s) if s not in ("", "-", "None") else default
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
    reuse = os.environ.get("KIS_ACCESS_TOKEN", "")
    if reuse:
        print("  기존 토큰 재사용 (KIS_ACCESS_TOKEN 환경변수)")
        return reuse
    r = requests.post(
        f"{KIS_BASE}/oauth2/tokenP",
        json={"grant_type": "client_credentials",
              "appkey": KIS_KEY, "appsecret": KIS_SECRET},
        timeout=15
    )
    r.raise_for_status()
    return r.json()["access_token"]


_last_call = 0.0
def rate_throttle():
    global _last_call
    wait = (1.0 / MAX_RPS) - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()


def fetch_nxt_price(token, code):
    """FHKST01010100, market_div=NX — NXT 애프터마켓 현재가(=마감 후엔 마감가) 조회.
    실패(비거래·상장폐지 등)하면 None."""
    rate_throttle()
    try:
        r = requests.get(
            f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price",
            headers=kis_headers(token, "FHKST01010100"),
            params={"FID_COND_MRKT_DIV_CODE": "NX", "FID_INPUT_ISCD": code},
            timeout=10
        )
    except Exception:
        return None
    if r.status_code != 200:
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        return None
    return d.get("output")


def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code FROM stocks WHERE security_type = 'STOCK' ORDER BY code")
        return [r[0] for r in cur.fetchall()]


NXT_SQL = """
INSERT INTO daily_price (trade_date, code, nxt_close, nxt_change_pct)
VALUES %s
ON CONFLICT (trade_date, code) DO UPDATE SET
  nxt_close=EXCLUDED.nxt_close, nxt_change_pct=EXCLUDED.nxt_change_pct
"""


def upsert_batch(rows):
    if not rows:
        return
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        execute_values(cur, NXT_SQL, rows, page_size=BATCH)
        c.commit()


def main():
    t0 = time.time()
    token = get_token()

    if DEBUG_MODE:
        out = fetch_nxt_price(token, DEBUG_CODE)
        print(f"[NXT 원본 응답] {DEBUG_CODE}: {out}")
        return

    codes = load_stocks()
    print(f"▶ 대상 {len(codes):,}종목, 최대 {MAX_RPS}건/초")

    rows, ok, skip = [], 0, 0
    for i, code in enumerate(codes, 1):
        out = fetch_nxt_price(token, code)
        if not out:
            skip += 1
            continue
        close = safe_num(out.get("stck_prpr"))
        chg   = safe_num(out.get("prdy_ctrt"))
        if close is None:
            skip += 1
            continue
        rows.append((TARGET_DATE_ISO, code, int(close), chg))
        ok += 1
        if i % 50 == 0:
            print(f"  진행 {i}/{len(codes)} (성공 {ok}, 스킵 {skip})")

    upsert_batch(rows)
    print(f"✅ 완료 — 성공 {ok}건, 스킵 {skip}건, 저장 {len(rows)}건 ({time.time()-t0:.0f}초)")


if __name__ == "__main__":
    main()
