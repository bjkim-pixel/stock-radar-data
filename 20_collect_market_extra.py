# -*- coding: utf-8 -*-
"""
STOCK RADAR · 프로그램매매 · 미국증시 일별 수집
=======================================================
GitHub Actions에서 03_daily_collect.py 이후 매 거래일 자동 실행됩니다.

수집 항목
  1) 프로그램매매 종합현황(일별) — KIS comp-program-trade-daily (tr_id FHPPG04600001)
     KOSPI·KOSDAQ 각각 조회해 program_trade_daily 테이블에 적재
  2) 미국 증시 4대 지수 — Yahoo Finance 비공식 차트 API
     나스닥종합(^IXIC) · S&P500(^GSPC) · 다우(^DJI) · 필라델피아반도체(^SOX)
     us_market_daily 테이블에 적재

  신용거래 융자잔고는 포함하지 않습니다 (KIS에 시장 전체 집계 API 없음 — 종목별 조회만 가능).

필요 환경변수
  KIS_APP_KEY       KIS Open API 앱키
  KIS_APP_SECRET    KIS Open API 앱시크릿
  SUPABASE_DB_URL   Supabase Session pooler URI

사용법
  python 20_collect_market_extra.py                  # 오늘 수집
  python 20_collect_market_extra.py 20260815          # 특정 날짜 재수집
  python 20_collect_market_extra.py --debug           # API 원본 응답 확인 (필드명 검증)
"""
import os, sys, json, datetime
import requests, psycopg2

# ── 설정 ──────────────────────────────────────────────────────────────────────
KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

YAHOO_SYMBOLS = {
    "NASDAQ": "%5EIXIC",   # 나스닥종합
    "SP500":  "%5EGSPC",   # S&P500
    "DOW":    "%5EDJI",    # 다우존스
    "SOX":    "%5ESOX",    # 필라델피아반도체
}

DEBUG_MODE  = "--debug" in sys.argv
TARGET_DATE = datetime.date.today().strftime("%Y%m%d")
for a in sys.argv[1:]:
    if a.isdigit() and len(a) == 8:
        TARGET_DATE = a
TARGET_DATE_ISO = f"{TARGET_DATE[:4]}-{TARGET_DATE[4:6]}-{TARGET_DATE[6:]}"

if not KIS_KEY or not KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

print(f"▶ 수집 날짜: {TARGET_DATE_ISO}")


# ── 유틸 ──────────────────────────────────────────────────────────────────────
def safe_int(v, default=0):
    try:
        s = str(v).replace(",", "").strip()
        if s in ("", "-", "None"):
            return default
        return int(float(s))
    except Exception:
        return default


def safe_float(v, default=None):
    try:
        s = str(v).replace(",", "").strip()
        return float(s) if s not in ("", "-") else default
    except Exception:
        return default


# ── KIS 공통 ──────────────────────────────────────────────────────────────────
def get_token():
    # KIS는 앱키당 토큰 발급을 1분에 1회로 제한합니다. 같은 워크플로에서
    # 03_daily_collect.py가 방금 발급받은 토큰을 재사용해 재발급 403을 피합니다.
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


def kis_headers(token, tr_id):
    return {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": f"Bearer {token}",
        "appkey": KIS_KEY,
        "appsecret": KIS_SECRET,
        "tr_id": tr_id,
        "custtype": "P",
    }


# ── KIS: 프로그램매매 종합현황(일별) ───────────────────────────────────────────
def fetch_program_trade(token, mrkt_cls):
    """mrkt_cls: 'K'(코스피) | 'Q'(코스닥). 최신일이 포함되도록 오늘 기준 range 조회."""
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/comp-program-trade-daily",
        headers=kis_headers(token, "FHPPG04600001"),
        params={
            "FID_COND_MRKT_DIV_CODE": "J",
            "FID_MRKT_CLS_CODE": mrkt_cls,
            "FID_INPUT_DATE_1": TARGET_DATE,
            "FID_INPUT_DATE_2": TARGET_DATE,
        },
        timeout=10
    )
    if r.status_code != 200:
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        return None
    rows = [x for x in (d.get("output") or []) if x]
    if not rows:
        return None
    # 기준일과 정확히 일치하는 행을 찾습니다 (없으면 첫 행 사용).
    for row in rows:
        if str(row.get("stck_bsop_date", "")).strip() == TARGET_DATE:
            return row
    return rows[0]


# ── Yahoo Finance: 지수 시세 (비공식 차트 API) ─────────────────────────────────
def fetch_yahoo_index(symbol_enc):
    """range=5d로 조회해 휴장일 뒤에도 직전 거래일 종가를 확실히 확보합니다."""
    r = requests.get(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol_enc}",
        params={"range": "5d", "interval": "1d"},
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=10
    )
    if r.status_code != 200:
        return None
    d = r.json()
    try:
        result = d["chart"]["result"][0]
        closes = result["indicators"]["quote"][0]["close"]
        timestamps = result["timestamp"]
    except (KeyError, IndexError, TypeError):
        return None
    # None 값(휴장일 등) 제외하고 뒤에서부터 유효한 종가 2개를 뽑습니다.
    pairs = [(t, c) for t, c in zip(timestamps, closes) if c is not None]
    if len(pairs) < 1:
        return None
    last_ts, last_close = pairs[-1]
    prev_close = pairs[-2][1] if len(pairs) >= 2 else None
    change_pct = None
    if prev_close:
        change_pct = (last_close - prev_close) / prev_close * 100
    trade_date = datetime.datetime.utcfromtimestamp(last_ts).strftime("%Y-%m-%d")
    return {"close": last_close, "change_pct": change_pct, "trade_date": trade_date}


# ── DB ────────────────────────────────────────────────────────────────────────
PROGRAM_SQL = """
INSERT INTO program_trade_daily (trade_date, market, arb_net_amount, nonarb_net_amount, source)
VALUES %s
ON CONFLICT (trade_date, market) DO UPDATE SET
  arb_net_amount=EXCLUDED.arb_net_amount,
  nonarb_net_amount=EXCLUDED.nonarb_net_amount,
  source=EXCLUDED.source
"""
US_SQL = """
INSERT INTO us_market_daily (trade_date, symbol, close, change_pct, source)
VALUES %s
ON CONFLICT (trade_date, symbol) DO UPDATE SET
  close=EXCLUDED.close,
  change_pct=EXCLUDED.change_pct,
  source=EXCLUDED.source
"""


def upsert(sql, rows):
    if not rows:
        return
    from psycopg2.extras import execute_values
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        execute_values(cur, sql, rows, page_size=100)
        c.commit()


def log_result(job, status, row_count, message=""):
    try:
        with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
            cur.execute("""
                INSERT INTO ingest_log (job, trade_date, status, row_count, message)
                VALUES (%s, %s, %s, %s, %s)
            """, (job, TARGET_DATE_ISO, status, row_count, message))
            c.commit()
    except Exception as ex:
        print(f"  ⚠ ingest_log 기록 실패: {ex}")


# ── 디버그 모드 ────────────────────────────────────────────────────────────────
def run_debug():
    print(f"\n=== DEBUG 모드 ({TARGET_DATE}) ===\n")
    token = get_token()

    print("[1] comp-program-trade-daily (코스피) 응답:")
    row = fetch_program_trade(token, "K")
    print(json.dumps(row, ensure_ascii=False, indent=2) if row else "  (데이터 없음)")
    print("""
→ 위 필드명을 보고 확인하세요 (단위는 다른 KIS 수급 API처럼 백만원일 가능성이 있습니다 —
  daily_flow 실측치와 대조해 FLOW_UNIT 배율을 확정한 뒤 아래를 조정하세요):
   arbt_entm_ntby_tr_pbmn   (차익 위탁 순매수 거래대금)
   nabt_entm_ntby_tr_pbmn   (비차익 위탁 순매수 거래대금)
""")

    print("[2] Yahoo Finance 나스닥(^IXIC) 응답:")
    y = fetch_yahoo_index(YAHOO_SYMBOLS["NASDAQ"])
    print(json.dumps(y, ensure_ascii=False, indent=2) if y else "  (데이터 없음)")


# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    program_rows = []
    us_rows = []
    errors = []

    print("① KIS 토큰 발급...")
    try:
        token = get_token()
    except Exception as ex:
        sys.exit(f"❌ 토큰 발급 실패: {ex}")

    print("② 프로그램매매 종합현황(일별) 수집...")
    for market, cls in [("KOSPI", "K"), ("KOSDAQ", "Q")]:
        try:
            row = fetch_program_trade(token, cls)
            if row is None:
                errors.append(f"program:{market} 데이터 없음")
                continue
            # KIS 수급 금액 필드는 일반적으로 백만원 단위 (03_daily_collect.py FLOW_UNIT과 동일 관례).
            # 최초 실행 후 --debug로 daily_flow 실측치와 대조해 배율을 확정하세요.
            arb    = safe_int(row.get("arbt_entm_ntby_tr_pbmn")) * 1_000_000
            nonarb = safe_int(row.get("nabt_entm_ntby_tr_pbmn")) * 1_000_000
            program_rows.append((TARGET_DATE_ISO, market, arb, nonarb, "KIS"))
            print(f"   {market}: 차익 {arb/1e8:,.1f}억 · 비차익 {nonarb/1e8:,.1f}억")
        except Exception as ex:
            errors.append(f"program:{market} 오류 {ex}")

    print("③ 미국 증시 4대 지수 수집 (Yahoo Finance)...")
    for name, sym in YAHOO_SYMBOLS.items():
        try:
            y = fetch_yahoo_index(sym)
            if y is None:
                errors.append(f"us:{name} 데이터 없음")
                continue
            us_rows.append((y["trade_date"], name, y["close"], y["change_pct"], "YAHOO"))
            print(f"   {name}: {y['close']:,.2f} ({y['change_pct']:+.2f}%)" if y["change_pct"] is not None
                  else f"   {name}: {y['close']:,.2f}")
        except Exception as ex:
            errors.append(f"us:{name} 오류 {ex}")

    print("④ DB 적재...")
    upsert(PROGRAM_SQL, program_rows)
    upsert(US_SQL, us_rows)

    status = "SUCCESS" if not errors else ("FAIL" if not program_rows and not us_rows else "PARTIAL")
    msg = f"program={len(program_rows)} us={len(us_rows)}" + (f" errors={errors}" if errors else "")
    log_result("market_extra", status, len(program_rows) + len(us_rows), msg)

    print(f"\n✅ 완료: 프로그램매매 {len(program_rows)}건 · 미국증시 {len(us_rows)}건")
    if errors:
        print("⚠ 오류:")
        for e in errors:
            print(f"   - {e}")
        if not program_rows and not us_rows:
            sys.exit(1)


if __name__ == "__main__":
    if DEBUG_MODE:
        run_debug()
    else:
        main()
