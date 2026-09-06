# -*- coding: utf-8 -*-
"""
STOCK RADAR · 단일 종목 추가 스크립트
======================================
신규 종목 1개를 stocks 테이블에 등록하고 전체 기간을 백필합니다.

사용법
  python add_single_stock.py 419530 SAMG엔터 KOSDAQ
  python add_single_stock.py 419530 SAMG엔터 KOSDAQ --start 20240101
  python add_single_stock.py 419530 SAMG엔터 KOSDAQ --sector 오락·문화

환경변수
  KIS_APP_KEY / KIS_APP_SECRET / SUPABASE_DB_URL
"""
import os, sys, time, datetime, threading, re
import requests, psycopg2
from psycopg2.extras import execute_values

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

MAX_RPS  = 18
BATCH    = 500
ANCHOR_STEP_DAYS = 40
FLOW_UNIT = 1_000_000   # 백만원 → 원

# ── 인자 파싱 ─────────────────────────────────────────────────────────────────
args_raw = sys.argv[1:]
positional = [a for a in args_raw if not a.startswith("--")]

if len(positional) < 3:
    sys.exit("사용법: python add_single_stock.py <종목코드> <종목명> <시장> [--start YYYYMMDD] [--sector 업종]")

CODE   = positional[0].strip().zfill(6)
NAME   = positional[1].strip()
MARKET = positional[2].strip().upper()  # KOSDAQ | KOSPI | KONEX

# 선택 옵션
START_DATE = (datetime.date.today() - datetime.timedelta(days=365 * 2)).strftime("%Y%m%d")
SECTOR_KRX = None
for i, a in enumerate(args_raw):
    if a == "--start" and i + 1 < len(args_raw):
        START_DATE = args_raw[i + 1]
    if a == "--sector" and i + 1 < len(args_raw):
        SECTOR_KRX = args_raw[i + 1]

END_DATE = (datetime.date.today() - datetime.timedelta(1)).strftime("%Y%m%d")

print(f"\n▶ 대상 종목  : {CODE} {NAME} ({MARKET})")
print(f"▶ 백필 범위  : {START_DATE} ~ {END_DATE}")
print(f"▶ 업종(sector_krx): {SECTOR_KRX or '(미지정)'}")

if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")
if not KIS_KEY or not KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")

# ── 유틸 ──────────────────────────────────────────────────────────────────────
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
_DATE_RE = re.compile(r"^20\d{6}$")

def safe_int(v, d=0):
    try:
        s = str(v).replace(",", "").strip()
        return d if s in ("", "-", "None") else int(float(s))
    except:
        return d

def safe_float(v, d=0.0):
    try:
        s = str(v).replace(",", "").strip()
        return d if s in ("", "-", "None") else float(s)
    except:
        return d

def find_date(row):
    v = row.get("stck_bsop_date")
    if v and _DATE_RE.match(str(v).strip()):
        return str(v).strip()
    for k, x in row.items():
        if _DATE_RE.match(str(x).strip()):
            return str(x).strip()
    return None

def iso(d): return f"{d[:4]}-{d[4:6]}-{d[6:]}"
def ymd(d): return d.strftime("%Y%m%d")
def dt(s):  return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:]))

def anchors(start_str, end_str, step=ANCHOR_STEP_DAYS):
    s, e = dt(start_str), dt(end_str)
    out, cur = [], e
    while True:
        out.append(ymd(cur))
        if cur <= s:
            break
        cur -= datetime.timedelta(step)
    return out

ANCHORS = anchors(START_DATE, END_DATE)

# ── KIS API ───────────────────────────────────────────────────────────────────
def kis_hdr(token, tr_id):
    return {"Content-Type": "application/json; charset=utf-8",
            "authorization": f"Bearer {token}",
            "appkey": KIS_KEY, "appsecret": KIS_SECRET,
            "tr_id": tr_id, "custtype": "P"}

def get_token():
    r = requests.post(f"{KIS_BASE}/oauth2/tokenP",
                      json={"grant_type": "client_credentials",
                            "appkey": KIS_KEY, "appsecret": KIS_SECRET},
                      timeout=15)
    r.raise_for_status()
    print("  KIS 토큰 발급 완료")
    return r.json()["access_token"]

def fetch_listed_shares(token, code):
    """현재 상장주식수 조회 (lstn_stcn)"""
    _rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price",
        headers=kis_hdr(token, "FHKST01010100"),
        params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code},
        timeout=10)
    if r.status_code != 200:
        print(f"  ⚠ 상장주식수 조회 HTTP {r.status_code}")
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        print(f"  ⚠ 상장주식수 조회 실패: {d.get('msg1','')}")
        return None
    sh = safe_int(d.get("output", {}).get("lstn_stcn"))
    return sh if sh > 0 else None

def fetch_daily(token, code, anchor, retries=2):
    """기준일 기준 과거 30거래일 시세+수급 조회"""
    for attempt in range(retries + 1):
        _rate.acquire()
        try:
            r = requests.get(
                f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
                headers=kis_hdr(token, "FHPTJ04160001"),
                params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
                        "FID_INPUT_DATE_1": anchor, "FID_ORG_ADJ_PRC": "0",
                        "FID_ETC_CLS_CODE": "0"},
                timeout=15)
        except Exception as ex:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            return []
        if r.status_code == 200:
            d = r.json()
            if d.get("rt_cd") == "0":
                return [x for x in (d.get("output2") or []) if x]
            return []
        if attempt < retries and r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))
            continue
        return []
    return []

def fetch_program_daily(token, code, anchor, retries=2):
    """기준일 기준 과거 30거래일 프로그램매매 조회"""
    for attempt in range(retries + 1):
        _rate.acquire()
        try:
            r = requests.get(
                f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-program-trade",
                headers=kis_hdr(token, "FHPPG04650100"),
                params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
                        "FID_INPUT_DATE_1": anchor, "FID_ORG_ADJ_PRC": "0",
                        "FID_ETC_CLS_CODE": "0"},
                timeout=15)
        except Exception as ex:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            return []
        if r.status_code == 200:
            d = r.json()
            if d.get("rt_cd") == "0":
                return [x for x in (d.get("output2") or []) if x]
            return []
        if attempt < retries and r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))
            continue
        return []
    return []

# ── 파싱 ──────────────────────────────────────────────────────────────────────
def parse_price(r, date_str, code, listed_sh, prev_close):
    close  = safe_int(r.get("stck_clpr"))
    open_  = safe_int(r.get("stck_oprc"))
    high   = safe_int(r.get("stck_hgpr"))
    low    = safe_int(r.get("stck_lwpr"))
    vol    = safe_int(r.get("acml_vol"))
    amount = safe_int(r.get("acml_tr_pbmn"))  # 원 단위
    sh     = safe_int(r.get("lstn_stcn")) or listed_sh
    mktcap = close * sh if close and sh else 0
    chg_pct = safe_float(r.get("prdy_ctrt")) or (
        round((close - prev_close) / prev_close * 100, 4) if prev_close and close else 0.0)
    if not close:
        return None, prev_close
    return (
        iso(date_str), code,
        open_, high, low, close, vol, amount, mktcap, sh, chg_pct, "KIS", False
    ), close

def amt(r, key):
    return safe_int(r.get(key)) * FLOW_UNIT

def parse_flow(r, date_str, code):
    return (
        iso(date_str), code,
        amt(r, "frgn_reg_ntby_tr_pbmn"),  # 외국인(등록)
        amt(r, "orgn_ntby_tr_pbmn"),        # 기관합계
        amt(r, "ivtr_ntby_tr_pbmn"),        # 금융투자
        amt(r, "trus_ntby_tr_pbmn"),        # 투신
        amt(r, "priv_fnd_ntby_tr_pbmn"),    # 사모
        amt(r, "pnsn_ntby_tr_pbmn"),        # 연기금
        amt(r, "prsn_ntby_tr_pbmn"),        # 개인
        amt(r, "etc_corp_ntby_tr_pbmn"),    # 기타법인
        "KIS", False,
    )

def parse_program(r, date_str, code):
    buy  = safe_int(r.get("whol_smtn_shnu_tr_pbmn"))
    sell = safe_int(r.get("whol_smtn_seln_tr_pbmn"))
    net  = safe_int(r.get("whol_smtn_ntby_tr_pbmn"))
    if net == 0 and (buy != 0 or sell != 0):
        net = buy - sell
    return (
        iso(date_str), code,
        buy, sell, net,
        safe_int(r.get("whol_smtn_shnu_vol")),
        safe_int(r.get("whol_smtn_seln_vol")),
        safe_int(r.get("whol_smtn_ntby_qty")),
        "KIS",
    )

# ── SQL ───────────────────────────────────────────────────────────────────────
PRICE_SQL = """
INSERT INTO daily_price
  (trade_date,code,open,high,low,close,volume,trade_amount,
   market_cap,listed_shares,change_pct,source,is_partial)
VALUES %s
ON CONFLICT (trade_date,code) DO UPDATE SET
  open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
  close=EXCLUDED.close,volume=EXCLUDED.volume,
  trade_amount=EXCLUDED.trade_amount,market_cap=EXCLUDED.market_cap,
  listed_shares=EXCLUDED.listed_shares,change_pct=EXCLUDED.change_pct,
  source=EXCLUDED.source,is_partial=EXCLUDED.is_partial
"""
FLOW_SQL = """
INSERT INTO daily_flow
  (trade_date,code,foreign_net,inst_net,fin_inv_net,inv_trust_net,
   pe_net,pension_net,individual_net,corp_other_net,source,is_partial)
VALUES %s
ON CONFLICT (trade_date,code) DO UPDATE SET
  foreign_net=EXCLUDED.foreign_net,inst_net=EXCLUDED.inst_net,
  fin_inv_net=EXCLUDED.fin_inv_net,inv_trust_net=EXCLUDED.inv_trust_net,
  pe_net=EXCLUDED.pe_net,pension_net=EXCLUDED.pension_net,
  individual_net=EXCLUDED.individual_net,corp_other_net=EXCLUDED.corp_other_net,
  source=EXCLUDED.source,is_partial=EXCLUDED.is_partial
"""
PROGRAM_SQL = """
INSERT INTO daily_program
  (trade_date,code,pgtr_buy_amt,pgtr_sell_amt,pgtr_net_amt,
   pgtr_buy_qty,pgtr_sell_qty,pgtr_net_qty,source)
VALUES %s
ON CONFLICT (trade_date,code) DO UPDATE SET
  pgtr_buy_amt=EXCLUDED.pgtr_buy_amt,pgtr_sell_amt=EXCLUDED.pgtr_sell_amt,
  pgtr_net_amt=EXCLUDED.pgtr_net_amt,
  pgtr_buy_qty=EXCLUDED.pgtr_buy_qty,pgtr_sell_qty=EXCLUDED.pgtr_sell_qty,
  pgtr_net_qty=EXCLUDED.pgtr_net_qty,
  source=EXCLUDED.source,collected_at=now()
"""

# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    t0 = time.time()

    print("\n① KIS 토큰 발급...")
    token = get_token()

    # ── STEP 1: stocks 테이블에 UPSERT ────────────────────────────────────────
    print(f"\n② stocks 테이블에 {CODE} {NAME} 등록...")
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("""
            INSERT INTO stocks (code, name, market, security_type, sector_krx, is_active, first_seen, last_seen)
            VALUES (%s, %s, %s, 'STOCK', %s, true, CURRENT_DATE, CURRENT_DATE)
            ON CONFLICT (code) DO UPDATE SET
              name        = EXCLUDED.name,
              market      = EXCLUDED.market,
              sector_krx  = COALESCE(EXCLUDED.sector_krx, stocks.sector_krx),
              is_active   = true,
              last_seen   = CURRENT_DATE,
              updated_at  = now()
        """, (CODE, NAME, MARKET, SECTOR_KRX))
        c.commit()
    print(f"   ✅ stocks 등록 완료")

    # ── STEP 2: 상장주식수 조회 + 업데이트 ───────────────────────────────────
    print(f"\n③ 상장주식수 조회 (KIS inquire-price)...")
    listed_sh = fetch_listed_shares(token, CODE)
    if listed_sh:
        with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
            cur.execute("UPDATE stocks SET listed_shares = %s WHERE code = %s",
                        (listed_sh, CODE))
            c.commit()
        print(f"   ✅ listed_shares = {listed_sh:,}주")
    else:
        listed_sh = 0
        print(f"   ⚠ 상장주식수 조회 실패 — 0으로 설정 (시총 계산 불가)")

    # ── STEP 3: 과거 데이터 수집 ──────────────────────────────────────────────
    print(f"\n④ 과거 데이터 수집 중 ({len(ANCHORS)}개 기준일)...")
    raw, raw_prog = {}, {}
    for i, anchor in enumerate(ANCHORS):
        rows = fetch_daily(token, CODE, anchor)
        for r in rows:
            d = find_date(r)
            if d:
                raw[d] = r
        prog_rows = fetch_program_daily(token, CODE, anchor)
        for r in prog_rows:
            d = find_date(r)
            if d:
                raw_prog[d] = r
        print(f"   [{i+1}/{len(ANCHORS)}] 기준일 {anchor} → 시세 {len(raw)}일 / 프로그램 {len(raw_prog)}일")

    if not raw:
        print("   ⚠ 수집된 데이터 없음 — 종목코드를 확인하세요")
        return

    # ── STEP 4: 파싱 ──────────────────────────────────────────────────────────
    price_rows, flow_rows, program_rows = [], [], []
    prev_close = None
    for d in sorted(raw):
        r = raw[d]
        prow, prev_close = parse_price(r, d, CODE, listed_sh, prev_close)
        if d < START_DATE or d > END_DATE:
            continue
        if prow:
            price_rows.append(prow)
            flow_rows.append(parse_flow(r, d, CODE))
            pr = raw_prog.get(d)
            if pr:
                program_rows.append(parse_program(pr, d, CODE))

    print(f"\n⑤ 파싱 결과: price {len(price_rows)}행 / flow {len(flow_rows)}행 / program {len(program_rows)}행")

    # ── STEP 5: DB 저장 ────────────────────────────────────────────────────────
    print("⑥ DB 저장 중...")
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        if price_rows:
            execute_values(cur, PRICE_SQL, price_rows, page_size=BATCH)
        if flow_rows:
            execute_values(cur, FLOW_SQL, flow_rows, page_size=BATCH)
        if program_rows:
            execute_values(cur, PROGRAM_SQL, program_rows, page_size=BATCH)
        c.commit()

    elapsed = time.time() - t0
    print(f"\n✅ 완료 ({elapsed:.0f}초)")
    print(f"   daily_price  : {len(price_rows):,}행")
    print(f"   daily_flow   : {len(flow_rows):,}행")
    print(f"   daily_program: {len(program_rows):,}행")
    print(f"\n다음 단계: python 05_compute.py {END_DATE}")
    print(f"  → daily_metrics·signals 재계산 (오늘 날짜 1일치)")

if __name__ == "__main__":
    main()
