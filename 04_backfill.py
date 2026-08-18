# -*- coding: utf-8 -*-
"""
STOCK RADAR · KIS API 백필 (날짜 범위 재수집 + KRX 비교)
=========================================================
사용법
  python 04_backfill.py                        # 2026-01-02 ~ 어제
  python 04_backfill.py 20260102 20260813      # 날짜 범위 지정
  python 04_backfill.py --compare-only         # 재수집 없이 KRX vs KIS 비교만
  python 04_backfill.py --debug                # 삼성전자 응답 원문 출력 (필드명 확인)

환경변수
  KIS_APP_KEY / KIS_APP_SECRET / SUPABASE_DB_URL

※ 필드명을 하드코딩하지 않습니다.
  KIS 응답의 키 이름은 엔드포인트마다 다르고 문서와도 어긋나는 경우가 있어,
  날짜 필드는 "값이 8자리 20XXXXXX인 키"를 스캔해서 찾고,
  나머지 항목은 후보 이름을 순서대로 시도합니다(pick 함수).
  실행 첫 종목의 실제 키 목록을 로그에 찍어 두므로, 로그만 봐도 검증됩니다.
"""
import os, sys, time, datetime, json, threading, re
import requests, psycopg2
from psycopg2.extras import execute_values
from concurrent.futures import ThreadPoolExecutor, as_completed

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

WORKERS    = 10
MAX_RPS    = 18
BATCH      = 500
CHUNK_DAYS = 90
# 청크 경계에서 등락률을 계산하려면 앞쪽으로 며칠 겹쳐서 받아야 합니다.
OVERLAP_DAYS = 10


# ── 전역 속도 제한기 ──────────────────────────────────────────────────────────
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

# 첫 종목 응답의 키를 한 번만 출력하기 위한 플래그
_dumped = {"price": False, "flow": False}
_dump_lock = threading.Lock()

# ── 입력 파싱 ─────────────────────────────────────────────────────────────────
COMPARE_ONLY = "--compare-only" in sys.argv
DEBUG_MODE   = "--debug" in sys.argv
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


def date_chunks(start_str, end_str, chunk=CHUNK_DAYS):
    s = datetime.date(int(start_str[:4]), int(start_str[4:6]), int(start_str[6:]))
    e = datetime.date(int(end_str[:4]),   int(end_str[4:6]),   int(end_str[6:]))
    chunks, cur = [], s
    while cur <= e:
        nxt = min(cur + datetime.timedelta(chunk - 1), e)
        # API 호출은 앞으로 OVERLAP_DAYS 만큼 더 받아서 등락률 계산에 씁니다
        api_start = max(s - datetime.timedelta(OVERLAP_DAYS), cur - datetime.timedelta(OVERLAP_DAYS))
        chunks.append((ymd(api_start), ymd(nxt), ymd(cur)))
        cur = nxt + datetime.timedelta(1)
    return chunks


CHUNKS = date_chunks(START_DATE, END_DATE)
print(f"   → {len(CHUNKS)}개 청크 ({CHUNK_DAYS}일 단위, 경계 {OVERLAP_DAYS}일 중첩)")


# ── 값 파싱 유틸 ──────────────────────────────────────────────────────────────
def safe_int(v, d=0):
    try:
        s = str(v).replace(",", "").strip()
        if s in ("", "-", "None"):
            return d
        return int(float(s))
    except Exception:
        return d


def safe_float(v, d=0.0):
    try:
        s = str(v).replace(",", "").strip()
        if s in ("", "-", "None"):
            return d
        return float(s)
    except Exception:
        return d


def pick(row, *names):
    """후보 키를 순서대로 찾아 첫 번째로 존재하는 값을 반환"""
    for n in names:
        if n in row and str(row[n]).strip() not in ("", "-"):
            return row[n]
    return None


_DATE_RE = re.compile(r"^20\d{6}$")


def find_date(row):
    """값이 8자리 날짜(20XXXXXX)인 키를 찾아 그 값을 반환 — 키 이름에 의존하지 않음"""
    for k, v in row.items():
        if _DATE_RE.match(str(v).strip()):
            return str(v).strip()
    return None


_warned = {}


def warn_once(kind, msg):
    """같은 종류의 경고는 3번까지만 출력 (2,935종목 × 반복이라 로그가 터집니다)"""
    with _dump_lock:
        n = _warned.get((kind, msg), 0)
        if n >= 3:
            return
        _warned[(kind, msg)] = n + 1
        print(f"   ⚠ [{kind}] {msg}")


def dump_keys(kind, rows):
    """첫 응답의 키/샘플을 한 번만 로그에 남깁니다 (필드명 자가검증용)"""
    with _dump_lock:
        if _dumped[kind] or not rows:
            return
        _dumped[kind] = True
        print(f"\n   ── [{kind}] 응답 필드 확인 (첫 종목 1행) ──")
        print("   " + json.dumps(rows[0], ensure_ascii=False)[:1200])
        print(f"   → 감지된 날짜 필드값: {find_date(rows[0])}\n")


# ── KIS ───────────────────────────────────────────────────────────────────────
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
    print("  토큰 발급 완료")
    return r.json()["access_token"]


def fetch_price_hist(token, code, s, e):
    """FHKST03010100 · 일별 시세(OHLCV) — 날짜 범위"""
    _rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        headers=kis_hdr(token, "FHKST03010100"),
        params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
                "FID_INPUT_DATE_1": s, "FID_INPUT_DATE_2": e,
                "FID_PERIOD_DIV_CODE": "D", "FID_ORG_ADJ_PRC": "0"},
        timeout=15)
    if r.status_code != 200:
        warn_once("price", f"HTTP {r.status_code}")
        return []
    d = r.json()
    if d.get("rt_cd") != "0":
        warn_once("price", f"rt_cd={d.get('rt_cd')} msg={str(d.get('msg1','')).strip()}")
        return []
    rows = d.get("output2") or []
    rows = [x for x in rows if x]           # KIS는 빈 dict를 섞어 보냅니다
    dump_keys("price", rows)
    return rows


def fetch_investor_hist(token, code, s, e):
    """FHPTJ04160001 · 일별 투자자 순매수 — 날짜 범위"""
    _rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
        headers=kis_hdr(token, "FHPTJ04160001"),
        params={"MKSC_SHRN_ISCD": code, "STRT_BSNS_DT": s, "END_BSNS_DT": e,
                "HLDN_QTY_SMTN_ICDC_YN": "N"},
        timeout=15)
    if r.status_code != 200:
        warn_once("flow", f"HTTP {r.status_code}")
        return []
    d = r.json()
    if d.get("rt_cd") != "0":
        # 조용히 넘기지 않고 KIS 메시지를 한 번은 로그에 남깁니다.
        warn_once("flow", f"rt_cd={d.get('rt_cd')} msg={str(d.get('msg1','')).strip()}")
        return []
    rows = d.get("output2") or []
    rows = [x for x in rows if x]
    if not rows:
        warn_once("flow", f"rt_cd=0 이지만 output2가 비어 있음 ({s}~{e})")
    dump_keys("flow", rows)
    return rows


# ── DB ────────────────────────────────────────────────────────────────────────
def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code, listed_shares FROM stocks WHERE security_type='STOCK' ORDER BY code")
        return {r[0]: r[1] or 0 for r in cur.fetchall()}


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
  (trade_date,code,foreign_net,inst_net,
   fin_inv_net,inv_trust_net,pe_net,pension_net,
   corp_other_net,individual_net,source,is_partial)
VALUES %s
ON CONFLICT (trade_date,code) DO UPDATE SET
  foreign_net=EXCLUDED.foreign_net,inst_net=EXCLUDED.inst_net,
  fin_inv_net=EXCLUDED.fin_inv_net,inv_trust_net=EXCLUDED.inv_trust_net,
  pe_net=EXCLUDED.pe_net,pension_net=EXCLUDED.pension_net,
  corp_other_net=EXCLUDED.corp_other_net,individual_net=EXCLUDED.individual_net,
  source=EXCLUDED.source,is_partial=EXCLUDED.is_partial
"""


def upsert(price_rows, flow_rows):
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        if price_rows:
            execute_values(cur, PRICE_SQL, price_rows, page_size=BATCH)
        if flow_rows:
            execute_values(cur, FLOW_SQL, flow_rows, page_size=BATCH)
        c.commit()


# ── 종목 1개 × 1청크 수집 ─────────────────────────────────────────────────────
def collect_stock_chunk(token, code, listed_sh, api_s, api_e, keep_from):
    """반환: (price_rows, flow_rows, status)"""
    try:
        ph = fetch_price_hist(token, code, api_s, api_e)
        ih = fetch_investor_hist(token, code, api_s, api_e)

        if not ph and not ih:
            return [], [], "skip"

        # ── 시세 ─────────────────────────────────────────────────────────────
        parsed = []
        for r in ph:
            dt = find_date(r)
            if not dt:
                continue
            parsed.append((dt, r))
        parsed.sort(key=lambda x: x[0])     # 날짜 오름차순 → 등락률 계산 가능

        price_rows = []
        prev_close = None
        for dt, r in parsed:
            close_p = safe_int(pick(r, "stck_clpr", "stck_prpr", "clpr"))
            if close_p <= 0:
                prev_close = None
                continue

            # 등락률: 응답에 있으면 그대로, 없으면 직전 종가로 계산
            ctrt = pick(r, "prdy_ctrt", "flng_cls_code_ctrt")
            if ctrt is not None:
                change_pct = safe_float(ctrt)
            elif prev_close:
                change_pct = (close_p - prev_close) / prev_close * 100
            else:
                change_pct = 0.0

            if dt >= keep_from:            # 중첩 구간은 계산에만 쓰고 저장하지 않음
                mktcap = close_p * listed_sh if listed_sh else 0
                price_rows.append((
                    iso(dt), code,
                    safe_int(pick(r, "stck_oprc", "oprc")),
                    safe_int(pick(r, "stck_hgpr", "hgpr")),
                    safe_int(pick(r, "stck_lwpr", "lwpr")),
                    close_p,
                    safe_int(pick(r, "acml_vol", "cntg_vol")),
                    safe_int(pick(r, "acml_tr_pbmn", "acml_tr_pbm")),
                    mktcap, listed_sh,
                    round(change_pct, 4),
                    "KIS", False,
                ))
            prev_close = close_p

        # ── 수급 ─────────────────────────────────────────────────────────────
        flow_rows = []
        for r in ih:
            dt = find_date(r)
            if not dt or dt < keep_from:
                continue
            flow_rows.append((
                iso(dt), code,
                safe_int(pick(r, "frgn_ntby_tr_pbmn", "frgn_ntby_amt")),
                safe_int(pick(r, "orgn_ntby_tr_pbmn", "orgn_ntby_amt")),
                safe_int(pick(r, "fnnc_invt_ntby_tr_pbmn", "scrt_ntby_tr_pbmn", "scrt_ntby_amt")),
                safe_int(pick(r, "invt_trst_ntby_tr_pbmn", "ivtr_ntby_tr_pbmn", "ivtr_ntby_amt")),
                safe_int(pick(r, "pe_fund_ntby_tr_pbmn", "pe_fund_ntby_amt", "prvt_fund_ntby_tr_pbmn")),
                safe_int(pick(r, "pgnn_ntby_tr_pbmn", "fund_ntby_tr_pbmn", "pnsn_ntby_tr_pbmn")),
                safe_int(pick(r, "etc_corp_ntby_tr_pbmn", "etc_orgt_ntby_tr_pbmn")),
                safe_int(pick(r, "prsn_ntby_tr_pbmn", "prsn_ntby_amt")),
                "KIS", False,
            ))

        return price_rows, flow_rows, "ok"

    except Exception as ex:
        return [], [], f"err:{ex}"


# ── 디버그 모드 ────────────────────────────────────────────────────────────────
def probe(token, label, path, tr_id, params):
    """엔드포인트를 호출하고 rt_cd/msg1/행수/첫 행을 그대로 출력합니다.
    실패해도 조용히 넘어가지 않고 KIS가 준 메시지를 그대로 보여줍니다."""
    print(f"\n── {label}")
    print(f"   tr_id={tr_id}  params={params}")
    try:
        _rate.acquire()
        r = requests.get(f"{KIS_BASE}{path}", headers=kis_hdr(token, tr_id),
                         params=params, timeout=15)
    except Exception as ex:
        print(f"   ❌ 요청 실패: {ex}")
        return []

    print(f"   HTTP {r.status_code}")
    if r.status_code != 200:
        print(f"   본문: {r.text[:300]}")
        return []

    d = r.json()
    print(f"   rt_cd={d.get('rt_cd')}  msg_cd={d.get('msg_cd')}  msg1={str(d.get('msg1','')).strip()}")

    got = []
    for key in ("output", "output1", "output2"):
        v = d.get(key)
        if isinstance(v, list):
            v = [x for x in v if x]
            print(f"   {key}: 리스트 {len(v)}행")
            if v:
                print(f"     첫행: {json.dumps(v[0], ensure_ascii=False)[:600]}")
                print(f"     날짜감지: {find_date(v[0])}")
                got = got or v
        elif isinstance(v, dict) and v:
            print(f"   {key}: dict — {json.dumps(v, ensure_ascii=False)[:600]}")
            got = got or [v]
    if not got:
        print("   (데이터 없음)")
    return got


_MISSING_RE = re.compile(r"NOT FOUND\s*\[([A-Z0-9_]+)\]")


def guess_value(field, code, s, e):
    """KIS가 '이 필드가 없다'고 알려준 파라미터에 넣을 값을 규칙으로 결정"""
    f = field.upper()
    if "MRKT_DIV_CODE" in f:            # FID_COND_MRKT_DIV_CODE, ..._1, ..._2
        return "J"
    if "ISCD" in f:                     # FID_INPUT_ISCD, FID_INPUT_ISCD_1
        return code
    if f.endswith("DATE_1") or "STRT" in f or "BEGIN" in f:
        return s
    if f.endswith("DATE_2") or f.startswith("FID_INPUT_DATE") or "END" in f:
        return e
    if "PERIOD_DIV" in f:
        return "D"
    if "ORG_ADJ" in f:
        return "0"
    if f.endswith("_YN"):
        return "N"
    return "0"


def probe_auto(token, label, path, tr_id, base, code, s, e, max_rounds=8):
    """
    KIS 에러 메시지(ERROR INPUT FIELD NOT FOUND [X])를 읽어
    빠진 파라미터를 자동으로 채워 넣으며 재시도합니다.
    필드명을 추측하지 않고 API가 알려주는 대로 맞춰갑니다.
    """
    print(f"\n{'='*70}\n{label}\n  path={path}  tr_id={tr_id}")
    params = dict(base)

    for rnd in range(1, max_rounds + 1):
        try:
            _rate.acquire()
            r = requests.get(f"{KIS_BASE}{path}", headers=kis_hdr(token, tr_id),
                             params=params, timeout=15)
        except Exception as ex:
            print(f"  [{rnd}] 요청 실패: {ex}")
            return None, params

        if r.status_code != 200:
            print(f"  [{rnd}] HTTP {r.status_code} · {r.text[:200]}")
            return None, params

        d = r.json()
        rt, msg = d.get("rt_cd"), str(d.get("msg1", "")).strip()
        print(f"  [{rnd}] rt_cd={rt}  msg={msg}")
        print(f"       params={params}")

        if rt == "0":
            rows = None
            for key in ("output", "output1", "output2"):
                v = d.get(key)
                if isinstance(v, list):
                    v = [x for x in v if x]
                    if v:
                        print(f"       ✅ {key}: {len(v)}행")
                        print(f"          첫행: {json.dumps(v[0], ensure_ascii=False)[:700]}")
                        print(f"          날짜감지: {find_date(v[0])}")
                        rows = rows or v
            if rows is None:
                print("       rt_cd=0 이지만 리스트 데이터 없음")
            return rows, params

        m = _MISSING_RE.search(msg)
        if not m:
            print("       (자동 보정 불가 — 위 메시지 확인 필요)")
            return None, params

        field = m.group(1)
        val = guess_value(field, code, s, e)
        print(f"       → 누락 필드 [{field}] 감지, '{val}' 로 채워 재시도")
        params[field] = val

    print("  (최대 재시도 횟수 도달)")
    return None, params


def run_debug():
    print("\n" + "=" * 70)
    print("DEBUG: 삼성전자(005930) 엔드포인트 진단")
    print("=" * 70)
    token = get_token()

    # 휴장일을 피하려고 '확실한 영업일'을 기준으로 잡습니다.
    # 2026-08-17은 광복절 대체공휴일(증시 휴장)이라 종료일로 쓰면 안 됩니다.
    BIZ_END = "20260814"     # 금요일, 거래일 확인됨
    R5      = "20260810"     # 5거래일 전
    R90     = "20260515"     # 약 90일 전
    CODE    = "005930"

    print(f"\n※ 기준일: {BIZ_END} (영업일). 이전 실행은 종료일이 20260817(휴장)이었습니다.")

    # ── 시세 (정상 동작 확인용) ──────────────────────────────────────────────
    probe(token, "[A] 시세 · inquire-daily-itemchartprice (90일 범위)",
          "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
          "FHKST03010100",
          {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": CODE,
           "FID_INPUT_DATE_1": R90, "FID_INPUT_DATE_2": BIZ_END,
           "FID_PERIOD_DIV_CODE": "D", "FID_ORG_ADJ_PRC": "0"})

    # ── 수급: 파라미터를 자동 보정하며 탐색 ──────────────────────────────────
    # 이전 진단에서 rt_cd=2 "NOT FOUND [FID_COND_MRKT_DIV_CODE]" 가 나왔습니다.
    # 이 엔드포인트는 MKSC_SHRN_ISCD 계열이 아니라 FID_* 계열을 요구합니다.
    # 아래는 빈 파라미터로 시작해서 KIS가 요구하는 필드를 하나씩 채워 갑니다.
    INV_PATH = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily"

    probe_auto(token, "[B] 수급 · investor-trade-by-stock-daily (90일, 자동 보정)",
               INV_PATH, "FHPTJ04160001", {}, CODE, R90, BIZ_END)

    probe_auto(token, "[C] 수급 · investor-trade-by-stock-daily (단일일자, 자동 보정)",
               INV_PATH, "FHPTJ04160001", {}, CODE, BIZ_END, BIZ_END)

    probe_auto(token, "[D] 대안 · inquire-daily-trade-volume (자동 보정)",
               "/uapi/domestic-stock/v1/quotations/inquire-daily-trade-volume",
               "FHKST03010800", {}, CODE, R90, BIZ_END)

    probe_auto(token, "[E] 대안 · inquire-investor (최근 30일, 3주체만)",
               "/uapi/domestic-stock/v1/quotations/inquire-investor",
               "FHKST01010900", {}, CODE, R90, BIZ_END)

    probe_auto(token, "[F] 대안 · 외국인기관 추정가집계 (당일)",
               "/uapi/domestic-stock/v1/quotations/investor-trend-estimate",
               "HHPTJ04160200", {}, CODE, R90, BIZ_END)

    # ── 현재 파서로 시뮬레이션 ───────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("[G] 현재 파서 시뮬레이션 (90일 범위, 영업일 종료)")
    pr, fr, st = collect_stock_chunk(token, CODE, 5_919_637_922, R90, BIZ_END, R90)
    print(f"   status={st}  price_rows={len(pr)}  flow_rows={len(fr)}")
    if pr:
        print(f"   price 샘플: {pr[-1]}")
    if fr:
        print(f"   flow  샘플: {fr[0]}")
    print("\n→ [B]~[F] 중 어떤 것이 수급 데이터를 돌려주는지 확인해 주세요.")


# ── KRX vs KIS 비교 ────────────────────────────────────────────────────────────
def compare_krx_kis():
    print("\n" + "=" * 60)
    print("적재 현황 (source별)")
    print("=" * 60)
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("""
            SELECT coalesce(source,'(null)'), count(*),
                   count(*) FILTER (WHERE close > 0),
                   count(*) FILTER (WHERE trade_amount > 0),
                   round(avg(abs(change_pct))::numeric, 3)
            FROM daily_price WHERE trade_date BETWEEN %s AND %s
            GROUP BY 1 ORDER BY 2 DESC
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[daily_price] {iso(START_DATE)} ~ {iso(END_DATE)}")
        print(f"  {'source':<10} {'행수':>10} {'종가':>10} {'거래대금':>10} {'평균등락%':>9}")
        for s_, n, cl, am, ch in cur.fetchall():
            print(f"  {s_:<10} {n:>10,} {cl:>10,} {am:>10,} {str(ch):>9}")

        cur.execute("""
            SELECT coalesce(source,'(null)'), count(*),
                   count(*) FILTER (WHERE foreign_net <> 0),
                   count(*) FILTER (WHERE inst_net <> 0),
                   count(*) FILTER (WHERE inv_trust_net <> 0),
                   count(*) FILTER (WHERE pe_net <> 0),
                   count(*) FILTER (WHERE individual_net <> 0)
            FROM daily_flow WHERE trade_date BETWEEN %s AND %s
            GROUP BY 1 ORDER BY 2 DESC
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[daily_flow] {iso(START_DATE)} ~ {iso(END_DATE)}")
        print(f"  {'source':<10} {'행수':>10} {'외국인':>9} {'기관':>9} {'투신':>9} {'사모':>9} {'개인':>9}")
        for s_, n, f_, i_, it, pe, pr in cur.fetchall():
            print(f"  {s_:<10} {n:>10,} {f_:>9,} {i_:>9,} {it:>9,} {pe:>9,} {pr:>9,}")

        cur.execute("""
            SELECT p.trade_date, p.source, p.close, p.change_pct, p.trade_amount,
                   f.foreign_net, f.inst_net, f.inv_trust_net, f.pe_net
            FROM daily_price p
            LEFT JOIN daily_flow f ON f.trade_date=p.trade_date AND f.code=p.code
            WHERE p.code='005930' AND p.trade_date BETWEEN %s AND %s
            ORDER BY p.trade_date DESC LIMIT 5
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[삼성전자 005930] 최근 5일  (단위: 억원)")
        print(f"  {'날짜':<12}{'src':<5}{'종가':>9}{'등락%':>7}{'거래대금':>10}{'외국인':>9}{'기관':>9}{'투신':>8}{'사모':>8}")
        for r in cur.fetchall():
            print(f"  {str(r[0]):<12}{str(r[1] or '-'):<5}{r[2]:>9,}{float(r[3] or 0):>7.2f}"
                  f"{(r[4] or 0)//100_000_000:>10,}{(r[5] or 0)//100_000_000:>9,}"
                  f"{(r[6] or 0)//100_000_000:>9,}{(r[7] or 0)//100_000_000:>8,}"
                  f"{(r[8] or 0)//100_000_000:>8,}")


# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    if DEBUG_MODE:
        run_debug()
        return
    if COMPARE_ONLY:
        compare_krx_kis()
        return

    print("\n① KIS 토큰 발급...")
    token = get_token()

    print("② 종목 목록 조회...")
    stocks = load_stocks()
    codes = list(stocks.keys())
    n = len(codes)
    est = (n * 2 / MAX_RPS * len(CHUNKS)) / 60
    print(f"   {n:,}개 종목 × {len(CHUNKS)}개 청크 → 예상 소요시간 약 {est:.0f}분")

    total_price = total_flow = 0

    for ci, (api_s, api_e, keep_from) in enumerate(CHUNKS, 1):
        t_chunk = time.time()
        print(f"\n③ 청크 [{ci}/{len(CHUNKS)}] 저장 {iso(keep_from)}~{iso(api_e)} "
              f"(조회 {iso(api_s)}~)")
        price_rows, flow_rows = [], []
        ok = skip = err = 0
        done = 0

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = {ex.submit(collect_stock_chunk, token, code,
                                 stocks.get(code, 0), api_s, api_e, keep_from): code
                       for code in codes}

            for fut in as_completed(futures):
                code = futures[fut]
                done += 1
                try:
                    p_rows, f_rows, status = fut.result()
                except Exception as e:
                    err += 1
                    if err <= 5:
                        print(f"   ⚠ [{code}] future 예외: {e}")
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
                        total_flow += len(flow_rows)
                        price_rows, flow_rows = [], []
                        print(f"   [{done:4d}/{n}] 적재중... price={total_price:,} "
                              f"flow={total_flow:,}  ({int(time.time()-t_chunk)}초)")
                else:
                    err += 1
                    if err <= 5:
                        print(f"   ⚠ [{code}] {status}")

        if price_rows or flow_rows:
            upsert(price_rows, flow_rows)
            total_price += len(price_rows)
            total_flow += len(flow_rows)

        print(f"   청크 완료: ok={ok:,} skip={skip:,} err={err:,} "
              f"· 누적 price={total_price:,} flow={total_flow:,} ({int(time.time()-t_chunk)}초)")

    print(f"\n✅ 백필 완료: price {total_price:,}행 / flow {total_flow:,}행")
    if total_price == 0 and total_flow == 0:
        print("⚠️ 0행입니다. 위 '[price] 응답 필드 확인' 로그의 키 이름을 확인하세요.")
    compare_krx_kis()


if __name__ == "__main__":
    main()