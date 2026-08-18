# -*- coding: utf-8 -*-
"""
STOCK RADAR · KIS API 일별 데이터 수집
=======================================
GitHub Actions에서 매 거래일 16:05 KST(07:05 UTC)에 자동 실행됩니다.

필요 환경변수
  KIS_APP_KEY       KIS Open API 앱키
  KIS_APP_SECRET    KIS Open API 앱시크릿
  SUPABASE_DB_URL   Supabase Session pooler URI

사용법
  python 03_daily_collect.py                  # 오늘 수집
  python 03_daily_collect.py 20260815         # 특정 날짜 재수집
  python 03_daily_collect.py --debug 005930   # 삼성전자 API 응답 확인 (필드명 검증)
"""
import os, sys, time, datetime, json, threading
import requests, psycopg2
from psycopg2.extras import execute_values
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── 설정 ──────────────────────────────────────────────────────────────────────
KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"   # 실전투자
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

INTERVAL   = 0.1    # 워커당 API 호출 간 sleep (초)
WORKERS    = 5      # 동시 처리 워커 수 (5×2÷0.8s ≈ 12.5건/초 < 한도 20건/초)
BATCH      = 500

# ── 입력 파싱 ─────────────────────────────────────────────────────────────────
DEBUG_MODE  = False
DEBUG_CODE  = None
TARGET_DATE = datetime.date.today().strftime("%Y%m%d")

if len(sys.argv) >= 2:
    if sys.argv[1] == "--debug":
        DEBUG_MODE = True
        DEBUG_CODE = sys.argv[2] if len(sys.argv) > 2 else "005930"
    elif sys.argv[1].isdigit() and len(sys.argv[1]) == 8:
        TARGET_DATE = sys.argv[1]

TARGET_DATE_ISO = f"{TARGET_DATE[:4]}-{TARGET_DATE[4:6]}-{TARGET_DATE[6:]}"

# ── 환경변수 체크 ─────────────────────────────────────────────────────────────
if not KIS_KEY or not KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

print(f"▶ 수집 날짜: {TARGET_DATE_ISO}  (워커: {WORKERS}개)")

# ── 유틸 ──────────────────────────────────────────────────────────────────────
def safe_int(v, default=0):
    try:
        s = str(v).replace(",", "").strip()
        return int(s) if s not in ("", "-", "0") else default
    except:
        return default

def safe_float(v, default=0.0):
    try:
        s = str(v).replace(",", "").strip()
        return float(s) if s not in ("", "-") else default
    except:
        return default

# ── KIS 공통 ──────────────────────────────────────────────────────────────────
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

# ── KIS: 주식 현재가 조회 ─────────────────────────────────────────────────────
# FHKST01010100 — 장 종료 후 호출하면 당일 종가 데이터 반환
def fetch_price(token, code):
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
    return d.get("output")

# ── KIS: 일별 투자자별 순매수 ─────────────────────────────────────────────────
# FHPTJ04160001 — 외국인·기관 7개 카테고리 순매수 금액
def fetch_investor(token, code, date_str):
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
        headers=kis_headers(token, "FHPTJ04160001"),
        params={
            "MKSC_SHRN_ISCD": code,
            "STRT_BSNS_DT": date_str,
            "END_BSNS_DT": date_str,
            "HLDN_QTY_SMTN_ICDC_YN": "N",
        },
        timeout=10
    )
    if r.status_code != 200:
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        return None
    rows = d.get("output2") or []
    return rows[0] if rows else None

# ── DB: 종목 목록 조회 ────────────────────────────────────────────────────────
def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code FROM stocks WHERE security_type = 'STOCK' ORDER BY code")
        return [r[0] for r in cur.fetchall()]

# ── DB: UPSERT ────────────────────────────────────────────────────────────────
PRICE_SQL = """
INSERT INTO daily_price
  (trade_date, code, open, high, low, close, volume,
   trade_amount, market_cap, listed_shares, change_pct, is_partial)
VALUES %s
ON CONFLICT (trade_date, code) DO UPDATE SET
  open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
  close=EXCLUDED.close, volume=EXCLUDED.volume,
  trade_amount=EXCLUDED.trade_amount, market_cap=EXCLUDED.market_cap,
  listed_shares=EXCLUDED.listed_shares, change_pct=EXCLUDED.change_pct,
  is_partial=EXCLUDED.is_partial, updated_at=now()
"""

FLOW_SQL = """
INSERT INTO daily_flow
  (trade_date, code, foreign_net, inst_net,
   fin_inv_net, inv_trust_net, pe_net, pension_net, corp_other_net, is_partial)
VALUES %s
ON CONFLICT (trade_date, code) DO UPDATE SET
  foreign_net=EXCLUDED.foreign_net, inst_net=EXCLUDED.inst_net,
  fin_inv_net=EXCLUDED.fin_inv_net, inv_trust_net=EXCLUDED.inv_trust_net,
  pe_net=EXCLUDED.pe_net, pension_net=EXCLUDED.pension_net,
  corp_other_net=EXCLUDED.corp_other_net,
  is_partial=EXCLUDED.is_partial, updated_at=now()
"""

def upsert_batch(price_rows, flow_rows):
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        if price_rows:
            execute_values(cur, PRICE_SQL, price_rows, page_size=BATCH)
        if flow_rows:
            execute_values(cur, FLOW_SQL, flow_rows, page_size=BATCH)
        c.commit()

def log_result(job, status, row_count, duration_ms, message=""):
    try:
        with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
            cur.execute("""
                INSERT INTO ingest_log
                  (job, trade_date, status, row_count, duration_ms, message)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (job, TARGET_DATE_ISO, status, row_count, duration_ms, message))
            c.commit()
    except Exception as ex:
        print(f"  ⚠ ingest_log 기록 실패: {ex}")

# ── 종목 1개 수집 (워커 함수) ──────────────────────────────────────────────────
def collect_stock(token, code):
    """
    반환: (price_row | None, flow_row | None, status)
    status: 'ok' | 'skip' | 'err:...'
    """
    try:
        pi = fetch_price(token, code)
        time.sleep(INTERVAL)
        inv = fetch_investor(token, code, TARGET_DATE)
        time.sleep(INTERVAL)

        if pi is None and inv is None:
            return None, None, "skip"

        # ── daily_price ────────────────────────────────────────────────
        # hts_avls: 억원 단위 → ×1억 = 원
        mktcap_man = safe_int(pi.get("hts_avls", 0)) if pi else 0
        market_cap = mktcap_man * 100_000_000

        price_row = (
            TARGET_DATE_ISO,
            code,
            safe_int(pi.get("stck_oprc"))    if pi else 0,
            safe_int(pi.get("stck_hgpr"))    if pi else 0,
            safe_int(pi.get("stck_lwpr"))    if pi else 0,
            safe_int(pi.get("stck_prpr"))    if pi else 0,   # 현재가 = 종가
            safe_int(pi.get("acml_vol"))     if pi else 0,
            safe_int(pi.get("acml_tr_pbmn")) if pi else 0,
            market_cap,
            safe_int(pi.get("lstn_stcn"))    if pi else 0,
            safe_float(pi.get("prdy_ctrt"))  if pi else 0.0,
            pi is None,  # is_partial
        ) if pi else None

        # ── daily_flow ─────────────────────────────────────────────────
        flow_row = (
            TARGET_DATE_ISO,
            code,
            safe_int(inv.get("frgn_ntby_tr_pbmn")),
            safe_int(inv.get("orgn_ntby_tr_pbmn")),
            safe_int(inv.get("fnnc_invt_ntby_tr_pbmn")),
            safe_int(inv.get("invt_trst_ntby_tr_pbmn")),
            safe_int(inv.get("pe_fund_ntby_tr_pbmn")),
            safe_int(inv.get("pgnn_ntby_tr_pbmn")),
            safe_int(inv.get("etc_corp_ntby_tr_pbmn")),
            False,
        ) if inv else None

        return price_row, flow_row, "ok"

    except Exception as ex:
        return None, None, f"err:{ex}"

# ── 디버그 모드 ────────────────────────────────────────────────────────────────
def run_debug():
    print(f"\n=== DEBUG 모드: {DEBUG_CODE} ({TARGET_DATE}) ===\n")
    token = get_token()

    print("[1] inquire-price (FHKST01010100) 응답:")
    pi = fetch_price(token, DEBUG_CODE)
    print(json.dumps(pi, ensure_ascii=False, indent=2) if pi else "  (데이터 없음)")

    time.sleep(INTERVAL)

    print(f"\n[2] investor-trade-by-stock-daily (FHPTJ04160001) 응답 ({TARGET_DATE}):")
    inv = fetch_investor(token, DEBUG_CODE, TARGET_DATE)
    print(json.dumps(inv, ensure_ascii=False, indent=2) if inv else "  (데이터 없음)")

    print("""
→ 위 필드명을 보고 아래 항목이 맞는지 확인하세요:
   [price] stck_oprc / stck_hgpr / stck_lwpr / stck_prpr / acml_vol / acml_tr_pbmn
           hts_avls (시가총액, 단위 확인!) / lstn_stcn / prdy_ctrt (등락률)
   [flow]  frgn_ntby_tr_pbmn / orgn_ntby_tr_pbmn
           fnnc_invt_ntby_tr_pbmn / invt_trst_ntby_tr_pbmn
           pe_fund_ntby_tr_pbmn / pgnn_ntby_tr_pbmn / etc_corp_ntby_tr_pbmn
""")

# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    t_start = time.time()

    print("① KIS 토큰 발급...")
    token = get_token()

    print("② 종목 목록 조회...")
    stocks = load_stocks()
    n_total = len(stocks)
    print(f"   {n_total:,}개 종목 → {WORKERS}개 워커로 병렬 수집")

    price_rows, flow_rows = [], []
    ok = skip = err = 0
    done = 0

    print(f"③ KIS API 수집 중...")

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(collect_stock, token, code): code for code in stocks}

        for future in as_completed(futures):
            code = futures[future]
            done += 1

            try:
                price_row, flow_row, status = future.result()
            except Exception as ex:
                err += 1
                if err <= 10:
                    print(f"   ⚠ [{code}] future 예외: {ex}")
                continue

            if status == "skip":
                skip += 1
            elif status == "ok":
                ok += 1
                if price_row: price_rows.append(price_row)
                if flow_row:  flow_rows.append(flow_row)

                # 배치 적재
                if len(price_rows) >= BATCH:
                    upsert_batch(price_rows, flow_rows)
                    price_rows, flow_rows = [], []
                    elapsed = int(time.time() - t_start)
                    print(f"   [{done:4d}/{n_total}] 적재중... ok={ok:,}  ({elapsed}초 경과)")
            else:
                err += 1
                if err <= 10:
                    print(f"   ⚠ [{code}] {status}")

    # 마지막 배치
    if price_rows or flow_rows:
        upsert_batch(price_rows, flow_rows)

    duration_ms = int((time.time() - t_start) * 1000)

    # 공휴일 판정
    holiday = (skip / n_total >= 0.9) if n_total else False
    if holiday:
        status = "SKIP_HOLIDAY"
        print(f"\n📅 장 없는 날로 판단 (데이터 없음 {skip:,}/{n_total:,})")
    else:
        status = "SUCCESS" if err == 0 else ("FAIL" if ok == 0 else "PARTIAL")
        print(f"\n✅ 완료: 성공 {ok:,} / 스킵 {skip:,} / 오류 {err:,}  ({duration_ms//1000}초)")

    log_result("price", status, ok, duration_ms, f"ok={ok} skip={skip} err={err}")
    log_result("flow",  status, ok, duration_ms, f"ok={ok} skip={skip} err={err}")

    if err > 0 and not holiday:
        sys.exit(1)


# ── 진입점 ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if DEBUG_MODE:
        run_debug()
    else:
        main()
