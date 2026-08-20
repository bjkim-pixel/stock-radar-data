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
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

WORKERS  = 10   # 동시 처리 워커 수
MAX_RPS  = 18   # 전역 최대 API 호출 속도 (KIS 한도 20/초의 90%)
BATCH    = 500
FLOW_UNIT = 1_000_000   # KIS 수급 금액은 '백만원' 단위 → 원으로 변환

# ── 전역 속도 제한기 (토큰 버킷) ──────────────────────────────────────────────
class RateLimiter:
    """모든 워커가 공유하는 속도 제한기 — 전체 호출이 MAX_RPS를 넘지 않도록 제어"""
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

# ── 입력 파싱 ─────────────────────────────────────────────────────────────────
DEBUG_MODE  = False
DEBUG_CODE  = None
PARTIAL     = False   # --partial: 장중 스냅샷(당일 미확정 시세) — is_partial=True로 적재
TARGET_DATE = datetime.date.today().strftime("%Y%m%d")

_args = [a for a in sys.argv[1:] if a != "--partial"]
if "--partial" in sys.argv[1:]:
    PARTIAL = True
if len(_args) >= 1:
    if _args[0] == "--debug":
        DEBUG_MODE = True
        DEBUG_CODE = _args[1] if len(_args) > 1 else "005930"
    elif _args[0].isdigit() and len(_args[0]) == 8:
        TARGET_DATE = _args[0]

TARGET_DATE_ISO = f"{TARGET_DATE[:4]}-{TARGET_DATE[4:6]}-{TARGET_DATE[6:]}"

# ── 환경변수 체크 ─────────────────────────────────────────────────────────────
if not KIS_KEY or not KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

print(f"▶ 수집 날짜: {TARGET_DATE_ISO}  (워커: {WORKERS}개, 최대 {MAX_RPS}건/초)")

# ── 유틸 ──────────────────────────────────────────────────────────────────────
def safe_int(v, default=0):
    try:
        s = str(v).replace(",", "").strip()
        if s in ("", "-", "None"):
            return default
        return int(float(s))
    except:
        return default

def safe_float(v, default=0.0):
    try:
        s = str(v).replace(",", "").strip()
        return float(s) if s not in ("", "-") else default
    except:
        return default


def pick(row, *names):
    """후보 키를 순서대로 찾아 첫 번째로 존재하는 값을 반환.
    KIS 응답의 키 이름이 엔드포인트/문서마다 달라서 하나만 하드코딩하면
    조용히 0이 저장됩니다. 후보를 나열해 두면 어느 쪽이 와도 잡힙니다."""
    if not row:
        return None
    for n in names:
        if n in row and str(row[n]).strip() not in ("", "-"):
            return row[n]
    return None

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
    # KIS는 앱키당 토큰 발급을 1분에 1회로 제한합니다. 같은 워크플로 안에서
    # 다른 스크립트가 이미 발급받은 토큰이 있으면(KIS_ACCESS_TOKEN 환경변수)
    # 그걸 재사용해 재발급 시도로 인한 403을 피합니다.
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
    d = r.json()
    print(f"  토큰 발급 완료 (만료: {d.get('access_token_token_expired', '?')})")
    return d["access_token"]

# ── KIS: 주식 현재가 조회 ─────────────────────────────────────────────────────
def fetch_price(token, code):
    _rate.acquire()   # 전역 속도 제한
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
def fetch_investor(token, code, date_str):
    _rate.acquire()   # 전역 속도 제한
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
        headers=kis_headers(token, "FHPTJ04160001"),
        params={
            # 2026-08-19 진단으로 확정된 파라미터.
            # MKSC_SHRN_ISCD / STRT_BSNS_DT 계열은 이 엔드포인트가 받지 않습니다
            # (rt_cd=2 "NOT FOUND [FID_COND_MRKT_DIV_CODE]" 로 조용히 실패했었음).
            "FID_COND_MRKT_DIV_CODE": "J",
            "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": date_str,   # 기준일 → 과거 30거래일 반환
            "FID_ORG_ADJ_PRC": "0",
            "FID_ETC_CLS_CODE": "0",
        },
        timeout=10
    )
    if r.status_code != 200:
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        return None
    rows = [x for x in (d.get("output2") or []) if x]
    if not rows:
        return None
    # 첫 행이 기준일. 혹시 어긋나면 날짜가 일치하는 행을 찾습니다.
    if str(rows[0].get("stck_bsop_date", "")).strip() == date_str:
        return rows[0]
    for r0 in rows:
        if str(r0.get("stck_bsop_date", "")).strip() == date_str:
            return r0
    return None

# ── DB: 종목 목록 조회 ────────────────────────────────────────────────────────
def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code FROM stocks WHERE security_type = 'STOCK' ORDER BY code")
        return [r[0] for r in cur.fetchall()]

# ── DB: UPSERT ────────────────────────────────────────────────────────────────
PRICE_SQL = """
INSERT INTO daily_price
  (trade_date, code, open, high, low, close, volume,
   trade_amount, market_cap, listed_shares, change_pct, source, is_partial)
VALUES %s
ON CONFLICT (trade_date, code) DO UPDATE SET
  open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
  close=EXCLUDED.close, volume=EXCLUDED.volume,
  trade_amount=EXCLUDED.trade_amount, market_cap=EXCLUDED.market_cap,
  listed_shares=EXCLUDED.listed_shares, change_pct=EXCLUDED.change_pct,
  source=EXCLUDED.source, is_partial=EXCLUDED.is_partial,
  collected_at=now()
"""
FLOW_SQL = """
INSERT INTO daily_flow
  (trade_date, code, foreign_net, inst_net,
   fin_inv_net, inv_trust_net, pe_net, pension_net,
   individual_net, source, is_partial)
VALUES %s
ON CONFLICT (trade_date, code) DO UPDATE SET
  foreign_net=EXCLUDED.foreign_net, inst_net=EXCLUDED.inst_net,
  fin_inv_net=EXCLUDED.fin_inv_net, inv_trust_net=EXCLUDED.inv_trust_net,
  pe_net=EXCLUDED.pe_net, pension_net=EXCLUDED.pension_net,
  individual_net=EXCLUDED.individual_net,
  source=EXCLUDED.source, is_partial=EXCLUDED.is_partial,
  collected_at=now()
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
    """반환: (price_row | None, flow_row | None, status)"""
    try:
        pi  = fetch_price(token, code)    # _rate.acquire() 내장
        inv = fetch_investor(token, code, TARGET_DATE)  # _rate.acquire() 내장

        if pi is None and inv is None:
            return None, None, "skip"

        # ── daily_price ────────────────────────────────────────────────
        mktcap_man = safe_int(pick(pi, "hts_avls"))
        market_cap = mktcap_man * 100_000_000   # 억원 → 원

        price_row = (
            TARGET_DATE_ISO, code,
            safe_int(pick(pi, "stck_oprc")),
            safe_int(pick(pi, "stck_hgpr")),
            safe_int(pick(pi, "stck_lwpr")),
            safe_int(pick(pi, "stck_prpr", "stck_clpr")),
            safe_int(pick(pi, "acml_vol")),
            safe_int(pick(pi, "acml_tr_pbmn")),
            market_cap,
            safe_int(pick(pi, "lstn_stcn")),
            safe_float(pick(pi, "prdy_ctrt")),
            "KIS",
            PARTIAL,
        ) if pi else None

        # ── daily_flow ─────────────────────────────────────────────────
        # 2026-08-19 실제 응답으로 확정된 필드명. 금액은 모두 '백만원' 단위라
        # ×1,000,000 해야 원이 됩니다 (KRX 실측과 오차 0.01% 미만 확인).
        # 외국인은 등록/미등록이 나뉘며, KRX '외국인'과 같은 건 등록(frgn_reg)입니다.
        def amt(key):
            return safe_int(pick(inv, key)) * FLOW_UNIT

        flow_row = (
            TARGET_DATE_ISO, code,
            amt("frgn_reg_ntby_pbmn"),      # 외국인(등록)
            amt("orgn_ntby_tr_pbmn"),       # 기관합계
            amt("scrt_ntby_tr_pbmn"),       # 금융투자
            amt("ivtr_ntby_tr_pbmn"),       # 투신
            amt("pe_fund_ntby_tr_pbmn"),    # 사모
            amt("fund_ntby_tr_pbmn"),       # 연기금·기금
            amt("prsn_ntby_tr_pbmn"),       # 개인
            # corp_other_net·foreign_net_vol·inst_net_vol은 2026-08 용량 정리 때
            # 컬럼 삭제 (신호 엔진 미사용, 실제 값은 있었지만 공간 절감 우선).
            "KIS",
            PARTIAL,
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
    est_min = (n_total * 2 / MAX_RPS) / 60
    print(f"   {n_total:,}개 종목 → 예상 소요시간 약 {est_min:.0f}분")

    price_rows, flow_rows = [], []
    ok = skip = err = 0
    done = 0

    print(f"③ KIS API 수집 중... (워커 {WORKERS}개 / 최대 {MAX_RPS}건/초)")

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

                if len(price_rows) >= BATCH:
                    upsert_batch(price_rows, flow_rows)
                    price_rows, flow_rows = [], []
                    elapsed = int(time.time() - t_start)
                    print(f"   [{done:4d}/{n_total}] 적재중... ok={ok:,}  ({elapsed}초 경과)")
            else:
                err += 1
                if err <= 10:
                    print(f"   ⚠ [{code}] {status}")

    if price_rows or flow_rows:
        upsert_batch(price_rows, flow_rows)

    duration_ms = int((time.time() - t_start) * 1000)

    holiday = (skip / n_total >= 0.9) if n_total else False
    if holiday:
        status_str = "SKIP_HOLIDAY"
        print(f"\n📅 장 없는 날로 판단 (데이터 없음 {skip:,}/{n_total:,})")
    else:
        status_str = "SUCCESS" if err == 0 else ("FAIL" if ok == 0 else "PARTIAL")
        print(f"\n✅ 완료: 성공 {ok:,} / 스킵 {skip:,} / 오류 {err:,}  ({duration_ms//1000}초)")

    log_result("price", status_str, ok, duration_ms, f"ok={ok} skip={skip} err={err}")
    log_result("flow",  status_str, ok, duration_ms, f"ok={ok} skip={skip} err={err}")

    if err > 0 and not holiday:
        sys.exit(1)

# ── 진입점 ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if DEBUG_MODE:
        run_debug()
    else:
        main()
