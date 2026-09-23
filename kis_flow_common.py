# -*- coding: utf-8 -*-
"""
STOCK RADAR · KIS 시세+수급+프로그램매매 공통 수집 로직
==========================================================
2026-09-23: 04_backfill.py와 add_single_stock.py가 이 로직을 각자 따로
복사해서 들고 있었습니다. 그 결과:
  · 2026-09-21: add_single_stock.py의 투신/사모/연기금 필드명이 잘못돼
    있었음(005935 추가 후 발견, 04_backfill.py 기준으로 수정)
  · 2026-09-23: add_single_stock.py의 프로그램매매 조회가
    03_daily_collect.py(2026-08-26 확정)·04_backfill.py와 다른
    엔드포인트/tr_id(FHPPG04650100 + inquire-daily-program-trade)를
    쓰고 있었음 — 검증된 건 FHPPG04650201 + program-trade-by-stock-daily.
같은 로직이 두 곳에 있으면 한쪽만 고치고 한쪽은 놓치는 사고가 반복되므로
이 파일 하나로 합쳤습니다. **이 파일이 검증된 정답입니다** — 아래 상수/
필드명 근거는 2026-08-19·08-26 실제 응답으로 확인된 사실입니다:

1. investor-trade-by-stock-daily(FHPTJ04160001)는 시세(OHLCV)와 수급을
   한 번에 돌려줍니다. 기준일 하나를 주면 그 날짜부터 과거 30거래일 반환.
2. 필수 파라미터는 FID_* 계열: FID_COND_MRKT_DIV_CODE=J
   FID_INPUT_ISCD=<종목> FID_INPUT_DATE_1=<기준일> FID_ORG_ADJ_PRC=0
   FID_ETC_CLS_CODE=0  (FID_INPUT_DATE_2는 존재하지 않음)
3. 금액 필드(_tr_pbmn, _pbmn)는 '백만원' 단위. acml_tr_pbmn(누적거래대금)만
   예외로 '원' 단위.
4. 외국인은 frgn_reg_ntby_pbmn(등록, KRX '외국인'과 일치)을 씁니다 —
   frgn_ntby_tr_pbmn(등록+미등록 합계)이 아닙니다.
5. 기관 분해: 금융투자(scrt)+투신(ivtr)+사모(pe_fund)+은행+보험+종금+기금
   = 기관합계(orgn). 검증 통과.
6. 프로그램매매는 program-trade-by-stock-daily(FHPPG04650201) —
   03_daily_collect.py(2026-08-26 확정)와 동일. whol_smtn_*_tr_pbmn은
   이름과 달리 이미 '원' 단위.

이 파일을 고치면 04_backfill.py·add_single_stock.py 둘 다에 반영됩니다.
"""
import os, time, datetime, re
import requests, psycopg2
from psycopg2.extras import execute_values

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"

# 한 번 호출에 30거래일 반환. 30거래일은 최소 42일(휴일 없을 때 6주)이므로
# 40일 간격으로 기준일을 잡으면 빈 구간 없이 이어집니다.
ANCHOR_STEP_DAYS = 40
FLOW_UNIT = 1_000_000        # 백만원 → 원


class RateLimiter:
    def __init__(self, max_rps):
        self.min_interval = 1.0 / max_rps
        self.lock = __import__("threading").Lock()
        self.last_call = 0.0

    def acquire(self):
        with self.lock:
            now = time.time()
            wait = self.min_interval - (now - self.last_call)
            if wait > 0:
                time.sleep(wait)
            self.last_call = time.time()


_DATE_RE = re.compile(r"^20\d{6}$")


def safe_int(v, d=0):
    try:
        s = str(v).replace(",", "").strip()
        return d if s in ("", "-", "None") else int(float(s))
    except Exception:
        return d


def safe_float(v, d=0.0):
    try:
        s = str(v).replace(",", "").strip()
        return d if s in ("", "-", "None") else float(s)
    except Exception:
        return d


def find_date(row):
    """값이 8자리 날짜인 키를 찾습니다 (키 이름에 의존하지 않는 안전장치)"""
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
    """END에서 START까지 step일 간격으로 기준일 목록 생성"""
    s, e = dt(start_str), dt(end_str)
    out, cur = [], e
    while True:
        out.append(ymd(cur))
        if cur <= s:
            break
        cur -= datetime.timedelta(step)
    return out


def kis_hdr(token, tr_id):
    return {"Content-Type": "application/json; charset=utf-8",
            "authorization": f"Bearer {token}",
            "appkey": KIS_KEY, "appsecret": KIS_SECRET,
            "tr_id": tr_id, "custtype": "P"}


def get_token(warn=None):
    """공유 토큰 캐시(72_kis_token.py) 우선 사용 — 여러 워크플로가 동시에
    돌 때 KIS의 '앱키당 1분 1회' 토큰 발급 제한에 걸리는 걸 방지."""
    env_token = os.environ.get("KIS_ACCESS_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        import importlib
        kis_token = importlib.import_module("72_kis_token")
        return kis_token.get_token_cached()
    except Exception as ex:
        if warn:
            warn(f"  ⚠ 공유 토큰 캐시 사용 실패({str(ex)[:120]}) — 직접 발급합니다")
    r = requests.post(f"{KIS_BASE}/oauth2/tokenP",
                      json={"grant_type": "client_credentials",
                            "appkey": KIS_KEY, "appsecret": KIS_SECRET},
                      timeout=15)
    r.raise_for_status()
    return r.json()["access_token"]


def fetch_daily(token, code, anchor, rate, retries=2, diag=None):
    """기준일부터 과거 30거래일의 시세+수급을 한 번에 가져옵니다. diag를
    넘기면 diag['msg']에 실패/빈 응답 사유를 남깁니다(선택)."""
    d = None
    for attempt in range(retries + 1):
        rate.acquire()
        try:
            r = requests.get(
                f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
                headers=kis_hdr(token, "FHPTJ04160001"),
                params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
                        "FID_INPUT_DATE_1": anchor, "FID_ORG_ADJ_PRC": "0",
                        "FID_ETC_CLS_CODE": "0"},
                timeout=15)
        except Exception as ex:
            if diag is not None:
                diag["msg"] = f"요청 예외: {ex}"
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            return []
        if r.status_code == 200:
            d = r.json()
            break
        if diag is not None:
            diag["msg"] = f"HTTP {r.status_code} · body={r.text[:200]}"
        if attempt < retries and r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))
            continue
        return []

    if d is None:
        return []
    if d.get("rt_cd") != "0":
        if diag is not None:
            diag["msg"] = f"rt_cd={d.get('rt_cd')} · msg1={str(d.get('msg1','')).strip()}"
        return []
    out = [x for x in (d.get("output2") or []) if x]
    if not out and diag is not None:
        diag["msg"] = f"HTTP 200 · rt_cd=0(정상) 이지만 output2 빈 배열(기준일 {anchor} 근방 데이터 없음)"
    return out


def fetch_program_daily(token, code, anchor, rate, retries=2):
    """기준일부터 과거 여러 거래일의 프로그램매매를 가져옵니다
    (program-trade-by-stock-daily/FHPPG04650201 — 03_daily_collect.py와 동일 확정본)."""
    d = None
    for attempt in range(retries + 1):
        rate.acquire()
        try:
            r = requests.get(
                f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
                headers=kis_hdr(token, "FHPPG04650201"),
                params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
                        "FID_INPUT_DATE_1": anchor},
                timeout=15)
        except Exception:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            return []
        if r.status_code == 200:
            d = r.json()
            break
        if attempt < retries and r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))
            continue
        return []
    if d is None or d.get("rt_cd") != "0":
        return []
    return [x for x in (d.get("output") or []) if x]


def fetch_listed_shares(token, code, rate):
    """현재 상장주식수 조회 (lstn_stcn)"""
    rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price",
        headers=kis_hdr(token, "FHKST01010100"),
        params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code},
        timeout=10)
    if r.status_code != 200:
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        return None
    sh = safe_int(d.get("output", {}).get("lstn_stcn"))
    return sh if sh > 0 else None


# ── 파싱 ──────────────────────────────────────────────────────────────────
def parse_price(r, date_str, code, listed_sh, prev_close):
    close_p = safe_int(r.get("stck_clpr"))
    if close_p <= 0:
        return None, prev_close
    if prev_close:
        chg = (close_p - prev_close) / prev_close * 100
    else:
        chg = safe_float(r.get("prdy_ctrt"))
    sh = safe_int(r.get("lstn_stcn")) or listed_sh
    row = (
        iso(date_str), code,
        safe_int(r.get("stck_oprc")), safe_int(r.get("stck_hgpr")),
        safe_int(r.get("stck_lwpr")), close_p,
        safe_int(r.get("acml_vol")), safe_int(r.get("acml_tr_pbmn")),  # 이 필드만 '원' 단위
        close_p * sh if sh else 0, sh,
        round(chg, 4), "KIS", False,
    )
    return row, close_p


def parse_flow(r, date_str, code, warn=None):
    """금액은 모두 백만원 단위 → ×1,000,000"""
    def amt(key):
        return safe_int(r.get(key)) * FLOW_UNIT

    inst = amt("orgn_ntby_tr_pbmn")
    # 기관 분해 합계가 기관합계와 맞는지 (데이터 이상 조기 감지).
    # 허용오차 ±4백만원: KIS가 각 항목을 백만원 단위로 반올림해서 주기 때문.
    parts = sum(amt(k) for k in (
        "scrt_ntby_tr_pbmn", "ivtr_ntby_tr_pbmn", "pe_fund_ntby_tr_pbmn",
        "bank_ntby_tr_pbmn", "insu_ntby_tr_pbmn", "mrbn_ntby_tr_pbmn",
        "fund_ntby_tr_pbmn"))
    if warn and inst and abs(parts - inst) > 4 * FLOW_UNIT:
        warn(f"기관합계 불일치 {code} {date_str}: 합={parts:,} vs {inst:,}")

    return (
        iso(date_str), code,
        amt("frgn_reg_ntby_pbmn"),        # 외국인(등록) — KRX '외국인'과 동일
        inst,                             # 기관합계
        amt("scrt_ntby_tr_pbmn"),         # 금융투자
        amt("ivtr_ntby_tr_pbmn"),         # 투신
        amt("pe_fund_ntby_tr_pbmn"),      # 사모
        amt("fund_ntby_tr_pbmn"),         # 연기금·기금
        amt("prsn_ntby_tr_pbmn"),         # 개인
        amt("etc_corp_ntby_tr_pbmn"),     # 기타법인
        "KIS", False,
    )


def parse_program(r, date_str, code):
    """whol_smtn_*_tr_pbmn은 이미 '원' 단위."""
    buy  = safe_int(r.get("whol_smtn_shnu_tr_pbmn"))
    sell = safe_int(r.get("whol_smtn_seln_tr_pbmn"))
    net  = safe_int(r.get("whol_smtn_ntby_tr_pbmn"))
    if net == 0 and (buy != 0 or sell != 0):
        net = buy - sell
    return (
        iso(date_str), code, buy, sell, net,
        safe_int(r.get("whol_smtn_shnu_vol")),
        safe_int(r.get("whol_smtn_seln_vol")),
        safe_int(r.get("whol_smtn_ntby_qty")),
        "KIS",
    )


# ── SQL ───────────────────────────────────────────────────────────────────
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
  (trade_date, code, pgtr_buy_amt, pgtr_sell_amt, pgtr_net_amt,
   pgtr_buy_qty, pgtr_sell_qty, pgtr_net_qty, source)
VALUES %s
ON CONFLICT (trade_date, code) DO UPDATE SET
  pgtr_buy_amt=EXCLUDED.pgtr_buy_amt, pgtr_sell_amt=EXCLUDED.pgtr_sell_amt,
  pgtr_net_amt=EXCLUDED.pgtr_net_amt,
  pgtr_buy_qty=EXCLUDED.pgtr_buy_qty, pgtr_sell_qty=EXCLUDED.pgtr_sell_qty,
  pgtr_net_qty=EXCLUDED.pgtr_net_qty,
  source=EXCLUDED.source, collected_at=now()
"""


def upsert(db_url, price_rows, flow_rows, program_rows=None, batch=500):
    with psycopg2.connect(db_url) as c, c.cursor() as cur:
        if price_rows:
            execute_values(cur, PRICE_SQL, price_rows, page_size=batch)
        if flow_rows:
            execute_values(cur, FLOW_SQL, flow_rows, page_size=batch)
        if program_rows:
            execute_values(cur, PROGRAM_SQL, program_rows, page_size=batch)
        c.commit()
