# -*- coding: utf-8 -*-
"""
STOCK RADAR · KIS API 백필 (날짜 범위 재수집 + KRX 비교)
=========================================================
사용법
  python 04_backfill.py                        # 2026-01-02 ~ 어제
  python 04_backfill.py 20260102 20260814      # 날짜 범위 지정
  python 04_backfill.py --compare-only         # 재수집 없이 KRX vs KIS 비교만

환경변수
  KIS_APP_KEY / KIS_APP_SECRET / SUPABASE_DB_URL
"""
import os, sys, time, datetime, json, threading
import requests, psycopg2
from psycopg2.extras import execute_values
from concurrent.futures import ThreadPoolExecutor, as_completed

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

WORKERS    = 10     # 동시 처리 워커 수
MAX_RPS    = 18     # 전역 최대 API 호출 속도 (KIS 한도 20/초의 90%)
BATCH      = 500
# KIS API는 한 번에 최대 ~100일치 반환 → 90일 단위로 청크
CHUNK_DAYS = 90

# ── 전역 속도 제한기 (토큰 버킷, 모든 워커가 공유) ─────────────────────────────
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

# ── 날짜 파싱 ─────────────────────────────────────────────────────────────────
COMPARE_ONLY = "--compare-only" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]

if len(args) >= 2:
    START_DATE, END_DATE = args[0], args[1]
elif len(args) == 1:
    START_DATE, END_DATE = args[0], (datetime.date.today() - datetime.timedelta(1)).strftime("%Y%m%d")
else:
    START_DATE = "20260102"
    END_DATE   = (datetime.date.today() - datetime.timedelta(1)).strftime("%Y%m%d")

def iso(d): return f"{d[:4]}-{d[4:6]}-{d[6:]}"
def ymd(d): return d.strftime("%Y%m%d")

print(f"▶ 백필 범위: {iso(START_DATE)} ~ {iso(END_DATE)}  (워커: {WORKERS}개, 최대 {MAX_RPS}건/초)")

if not COMPARE_ONLY:
    if not KIS_KEY or not KIS_SECRET:
        sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 설정 필요")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 설정 필요")

# ── 날짜 범위 → 90일 청크 목록 ───────────────────────────────────────────────
def date_chunks(start_str, end_str, chunk=CHUNK_DAYS):
    s = datetime.date(int(start_str[:4]), int(start_str[4:6]), int(start_str[6:]))
    e = datetime.date(int(end_str[:4]),   int(end_str[4:6]),   int(end_str[6:]))
    chunks = []
    cur = s
    while cur <= e:
        nxt = min(cur + datetime.timedelta(chunk - 1), e)
        chunks.append((ymd(cur), ymd(nxt)))
        cur = nxt + datetime.timedelta(1)
    return chunks

CHUNKS = date_chunks(START_DATE, END_DATE)
print(f"   → {len(CHUNKS)}개 청크 ({CHUNK_DAYS}일 단위)")

# ── 유틸 ──────────────────────────────────────────────────────────────────────
def safe_int(v, d=0):
    try:
        s = str(v).replace(",","").strip()
        return int(s) if s not in ("","-","0") else d
    except: return d

def safe_float(v, d=0.0):
    try:
        s = str(v).replace(",","").strip()
        return float(s) if s not in ("","-") else d
    except: return d

# ── KIS ───────────────────────────────────────────────────────────────────────
def kis_hdr(token, tr_id):
    return {"Content-Type":"application/json; charset=utf-8",
            "authorization":f"Bearer {token}",
            "appkey":KIS_KEY,"appsecret":KIS_SECRET,
            "tr_id":tr_id,"custtype":"P"}

def get_token():
    r = requests.post(f"{KIS_BASE}/oauth2/tokenP",
        json={"grant_type":"client_credentials","appkey":KIS_KEY,"appsecret":KIS_SECRET},
        timeout=15)
    r.raise_for_status()
    print(f"  토큰 발급 완료")
    return r.json()["access_token"]

# FHKST03010100: 일별 시세 (OHLCV) — 날짜 범위
def fetch_price_hist(token, code, s, e):
    _rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        headers=kis_hdr(token, "FHKST03010100"),
        params={"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,
                "FID_INPUT_DATE_1":s,"FID_INPUT_DATE_2":e,
                "FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"},
        timeout=15)
    if r.status_code != 200: return []
    d = r.json()
    if d.get("rt_cd") != "0": return []
    return d.get("output2") or []

# FHPTJ04160001: 일별 투자자 순매수 — 날짜 범위
def fetch_investor_hist(token, code, s, e):
    _rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
        headers=kis_hdr(token, "FHPTJ04160001"),
        params={"MKSC_SHRN_ISCD":code,"STRT_BSNS_DT":s,"END_BSNS_DT":e,
                "HLDN_QTY_SMTN_ICDC_YN":"N"},
        timeout=15)
    if r.status_code != 200: return []
    d = r.json()
    if d.get("rt_cd") != "0": return []
    return d.get("output2") or []

# ── DB ────────────────────────────────────────────────────────────────────────
def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code, listed_shares FROM stocks WHERE security_type='STOCK' ORDER BY code")
        return {r[0]: r[1] or 0 for r in cur.fetchall()}

PRICE_SQL = """
INSERT INTO daily_price
  (trade_date,code,open,high,low,close,volume,trade_amount,
   market_cap,listed_shares,change_pct,is_partial)
VALUES %s
ON CONFLICT (trade_date,code) DO UPDATE SET
  open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
  close=EXCLUDED.close,volume=EXCLUDED.volume,
  trade_amount=EXCLUDED.trade_amount,market_cap=EXCLUDED.market_cap,
  listed_shares=EXCLUDED.listed_shares,change_pct=EXCLUDED.change_pct,
  is_partial=EXCLUDED.is_partial
"""
FLOW_SQL = """
INSERT INTO daily_flow
  (trade_date,code,foreign_net,inst_net,
   fin_inv_net,inv_trust_net,pe_net,pension_net,corp_other_net,is_partial)
VALUES %s
ON CONFLICT (trade_date,code) DO UPDATE SET
  foreign_net=EXCLUDED.foreign_net,inst_net=EXCLUDED.inst_net,
  fin_inv_net=EXCLUDED.fin_inv_net,inv_trust_net=EXCLUDED.inv_trust_net,
  pe_net=EXCLUDED.pe_net,pension_net=EXCLUDED.pension_net,
  corp_other_net=EXCLUDED.corp_other_net,is_partial=EXCLUDED.is_partial
"""

def upsert(price_rows, flow_rows):
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        if price_rows: execute_values(cur, PRICE_SQL, price_rows, page_size=BATCH)
        if flow_rows:  execute_values(cur, FLOW_SQL,  flow_rows,  page_size=BATCH)
        c.commit()

# ── 종목 1개 × 1청크 수집 (워커 함수) ─────────────────────────────────────────
def collect_stock_chunk(token, code, listed_sh, cs, ce):
    """반환: (price_rows: list, flow_rows: list, status: 'ok'|'skip'|'err:...')"""
    try:
        ph = fetch_price_hist(token, code, cs, ce)
        ih = fetch_investor_hist(token, code, cs, ce)

        if not ph and not ih:
            return [], [], "skip"

        price_rows = []
        for r in ph:
            dt = r.get("stck_bsns_date", "")
            if len(dt) != 8: continue
            close_p = safe_int(r.get("stck_clpr"))
            mktcap  = close_p * listed_sh if close_p and listed_sh else 0
            price_rows.append((
                iso(dt), code,
                safe_int(r.get("stck_oprc")),
                safe_int(r.get("stck_hgpr")),
                safe_int(r.get("stck_lwpr")),
                close_p,
                safe_int(r.get("acml_vol")),
                safe_int(r.get("acml_tr_pbmn")),
                mktcap,
                listed_sh,
                safe_float(r.get("prdy_ctrt")),
                False,
            ))

        flow_rows = []
        for r in ih:
            dt = r.get("stck_bsns_date", "")
            if len(dt) != 8: continue
            flow_rows.append((
                iso(dt), code,
                safe_int(r.get("frgn_ntby_tr_pbmn")),
                safe_int(r.get("orgn_ntby_tr_pbmn")),
                safe_int(r.get("fnnc_invt_ntby_tr_pbmn")),
                safe_int(r.get("invt_trst_ntby_tr_pbmn")),
                safe_int(r.get("pe_fund_ntby_tr_pbmn")),
                safe_int(r.get("pgnn_ntby_tr_pbmn")),
                safe_int(r.get("etc_corp_ntby_tr_pbmn")),
                False,
            ))

        return price_rows, flow_rows, "ok"

    except Exception as ex:
        return [], [], f"err:{ex}"

# ── KRX vs KIS 비교 ────────────────────────────────────────────────────────────
def compare_krx_kis():
    print("\n" + "="*60)
    print("KRX vs KIS 비교 (업서트 전후 값 차이)")
    print("="*60)
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("""
            SELECT
              count(*) as rows,
              count(*) filter (where close > 0) as has_close,
              count(*) filter (where trade_amount > 0) as has_amount,
              count(*) filter (where market_cap > 0) as has_mktcap,
              round(avg(abs(change_pct))::numeric,4) as avg_change_pct
            FROM daily_price
            WHERE trade_date BETWEEN %s AND %s
        """, (iso(START_DATE), iso(END_DATE)))
        row = cur.fetchone()
        print(f"\n[daily_price] {iso(START_DATE)} ~ {iso(END_DATE)}")
        print(f"  총 행수       : {row[0]:,}")
        print(f"  종가 있음      : {row[1]:,}")
        print(f"  거래대금 있음  : {row[2]:,}")
        print(f"  시가총액 있음  : {row[3]:,}")
        print(f"  평균 등락률    : {row[4]}%")

        cur.execute("""
            SELECT
              count(*) as rows,
              count(*) filter (where foreign_net != 0) as has_foreign,
              count(*) filter (where inst_net != 0) as has_inst,
              count(*) filter (where fin_inv_net != 0) as has_fininv,
              count(*) filter (where pension_net != 0) as has_pension
            FROM daily_flow
            WHERE trade_date BETWEEN %s AND %s
        """, (iso(START_DATE), iso(END_DATE)))
        row = cur.fetchone()
        print(f"\n[daily_flow] {iso(START_DATE)} ~ {iso(END_DATE)}")
        print(f"  총 행수       : {row[0]:,}")
        print(f"  외국인 있음    : {row[1]:,}")
        print(f"  기관합계 있음  : {row[2]:,}")
        print(f"  금융투자 있음  : {row[3]:,}")
        print(f"  연기금 있음    : {row[4]:,}")

        cur.execute("""
            SELECT p.trade_date, p.close, p.change_pct, p.trade_amount,
                   f.foreign_net, f.inst_net, f.pension_net
            FROM daily_price p
            LEFT JOIN daily_flow f ON f.trade_date=p.trade_date AND f.code=p.code
            WHERE p.code='005930'
              AND p.trade_date BETWEEN %s AND %s
            ORDER BY p.trade_date DESC LIMIT 5
        """, (iso(START_DATE), iso(END_DATE)))
        rows = cur.fetchall()
        print(f"\n[삼성전자 005930] 최근 5일")
        print(f"{'날짜':<12} {'종가':>8} {'등락%':>7} {'거래대금(억)':>12} {'외국인(억)':>10} {'기관(억)':>9} {'연기금(억)':>9}")
        for r in rows:
            print(f"{str(r[0]):<12} {r[1]:>8,} {r[2]:>7.2f} "
                  f"{(r[3]or 0)//100_000_000:>12,} "
                  f"{(r[4]or 0)//100_000_000:>10,} "
                  f"{(r[5]or 0)//100_000_000:>9,} "
                  f"{(r[6]or 0)//100_000_000:>9,}")

# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    if COMPARE_ONLY:
        compare_krx_kis()
        return

    print("\n① KIS 토큰 발급...")
    token = get_token()

    print("② 종목 목록 조회...")
    stocks = load_stocks()
    codes  = list(stocks.keys())
    n      = len(codes)
    est_min = (n * 2 / MAX_RPS * len(CHUNKS)) / 60
    print(f"   {n:,}개 종목 × {len(CHUNKS)}개 청크 → 예상 소요시간 약 {est_min:.0f}분")

    total_price = total_flow = 0

    for ci, (cs, ce) in enumerate(CHUNKS, 1):
        t_chunk = time.time()
        print(f"\n③ 청크 [{ci}/{len(CHUNKS)}] {iso(cs)} ~ {iso(ce)}  (워커 {WORKERS}개)")
        price_rows, flow_rows = [], []
        ok = skip = err = 0
        done = 0

        with ThreadPoolExecutor(max_workers=WORKERS) as executor:
            futures = {
                executor.submit(collect_stock_chunk, token, code, stocks.get(code, 0), cs, ce): code
                for code in codes
            }

            for future in as_completed(futures):
                code = futures[future]
                done += 1

                try:
                    p_rows, f_rows, status = future.result()
                except Exception as ex:
                    err += 1
                    if err <= 5: print(f"   ⚠ [{code}] future 예외: {ex}")
                    continue

                if status == "skip":
                    skip += 1
                elif status == "ok":
                    ok += 1
                    price_rows.extend(p_rows)
                    flow_rows.extend(f_rows)

                    if len(price_rows) >= BATCH * 10:
                        upsert(price_rows, flow_rows)
                        total_price += len(price_rows)
                        total_flow  += len(flow_rows)
                        price_rows, flow_rows = [], []
                        elapsed = int(time.time() - t_chunk)
                        print(f"   [{done:4d}/{n}] 적재중... price={total_price:,} flow={total_flow:,}  ({elapsed}초 경과)")
                else:
                    err += 1
                    if err <= 5: print(f"   ⚠ [{code}] {status}")

        if price_rows or flow_rows:
            upsert(price_rows, flow_rows)
            total_price += len(price_rows)
            total_flow  += len(flow_rows)

        chunk_sec = int(time.time() - t_chunk)
        print(f"   청크 완료: ok={ok:,} skip={skip:,} err={err:,}  ({chunk_sec}초)")

    print(f"\n✅ 백필 완료: price {total_price:,}행 / flow {total_flow:,}행")
    print("\n아래 비교 결과를 확인하세요:")
    compare_krx_kis()


if __name__ == "__main__":
    main()
