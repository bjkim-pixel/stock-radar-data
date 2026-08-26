# -*- coding: utf-8 -*-
"""
STOCK RADAR · KIS API 백필 (시세 + 수급)
==========================================
사용법
  python 04_backfill.py                        # 2026-01-02 ~ 어제
  python 04_backfill.py 20260102 20260818      # 날짜 범위 지정
  python 04_backfill.py --compare-only         # 재수집 없이 적재 현황만
  python 04_backfill.py --debug                # 삼성전자 응답 원문 + 파싱 검증

환경변수
  KIS_APP_KEY / KIS_APP_SECRET / SUPABASE_DB_URL

────────────────────────────────────────────────────────────────────────────
2026-08-19 진단으로 확정된 사실 (추측 아님, 실제 응답으로 검증)

1. 엔드포인트 investor-trade-by-stock-daily (FHPTJ04160001) 는
   시세(OHLCV)와 수급을 한 번에 돌려줍니다. 시세 전용 호출이 필요 없습니다.

2. 필수 파라미터 — MKSC_SHRN_ISCD 계열이 아니라 FID_* 계열입니다.
     FID_COND_MRKT_DIV_CODE=J  FID_INPUT_ISCD=<종목>
     FID_INPUT_DATE_1=<기준일>  FID_ORG_ADJ_PRC=0  FID_ETC_CLS_CODE=0
   FID_INPUT_DATE_2 는 존재하지 않습니다.

3. 기준일 하나를 주면 그 날짜부터 '과거로 30거래일'을 반환합니다.
   (검증: 기준일 20260814 → 첫행 20260814, 마지막행 20260703)

4. 금액 필드(_tr_pbmn, _pbmn)의 단위는 '백만원' 입니다.
   단, acml_tr_pbmn(누적거래대금)만은 '원' 단위이므로 곱하면 안 됩니다.

5. 외국인은 등록/미등록이 분리돼 있습니다.
     frgn_reg_ntby_pbmn  = 1,338,610 → KRX '외국인'과 일치 ✅  (이걸 사용)
     frgn_ntby_tr_pbmn   = 1,336,152 = 등록 + 미등록 합계
   기존 KRX 데이터와 시계열을 잇기 위해 등록 기준을 씁니다.

6. 기관 분해 검증 통과:
     금융투자 + 투신 + 사모 + 은행 + 보험 + 종금 + 기금 = 기관합계
     -379,039 + 29,971 - 138,232 + 5,258 - 22,192 - 203 + 6,607 = -497,830 ✅
────────────────────────────────────────────────────────────────────────────
"""
import os, sys, time, datetime, json, threading, re
import requests, psycopg2
from psycopg2.extras import execute_values
from concurrent.futures import ThreadPoolExecutor, as_completed

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

WORKERS   = 10
MAX_RPS   = 18
BATCH     = 500

# 한 번 호출에 30거래일 반환. 30거래일은 최소 42일(휴일 없을 때 6주)이므로
# 40일 간격으로 기준일을 잡으면 빈 구간 없이 이어집니다.
ANCHOR_STEP_DAYS = 40
FLOW_UNIT = 1_000_000        # 백만원 → 원


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
_lock = threading.Lock()
_dumped = {"flow": False, "program": False}
_warned = {}


def warn_once(kind, msg, limit=3):
    with _lock:
        n = _warned.get((kind, msg), 0)
        if n >= limit:
            return
        _warned[(kind, msg)] = n + 1
        print(f"   ⚠ [{kind}] {msg}")


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


def iso(d):  return f"{d[:4]}-{d[4:6]}-{d[6:]}"
def ymd(d):  return d.strftime("%Y%m%d")
def dt(s):   return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:]))


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


ANCHORS = anchors(START_DATE, END_DATE)

print(f"▶ 백필 범위: {iso(START_DATE)} ~ {iso(END_DATE)}  (워커 {WORKERS} · 최대 {MAX_RPS}건/초)")
print(f"   기준일 {len(ANCHORS)}개 × 종목당 1회 호출 (1회에 30거래일 반환)")

if not COMPARE_ONLY and (not KIS_KEY or not KIS_SECRET):
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 설정 필요")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 설정 필요")


# ── 값 파싱 ───────────────────────────────────────────────────────────────────
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


_DATE_RE = re.compile(r"^20\d{6}$")


def find_date(row):
    """값이 8자리 날짜인 키를 찾습니다 (키 이름에 의존하지 않는 안전장치)"""
    v = row.get("stck_bsop_date")
    if v and _DATE_RE.match(str(v).strip()):
        return str(v).strip()
    for k, x in row.items():
        if _DATE_RE.match(str(x).strip()):
            return str(x).strip()
    return None


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


def fetch_daily(token, code, anchor, retries=2):
    """기준일부터 과거 30거래일의 시세 + 수급을 한 번에 가져옵니다.
    KIS는 간헐적으로 HTTP 500을 냅니다 → 짧게 쉬고 재시도합니다."""
    d = None
    for attempt in range(retries + 1):
        _rate.acquire()
        try:
            r = requests.get(
                f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
                headers=kis_hdr(token, "FHPTJ04160001"),
                params={"FID_COND_MRKT_DIV_CODE": "J",
                        "FID_INPUT_ISCD": code,
                        "FID_INPUT_DATE_1": anchor,
                        "FID_ORG_ADJ_PRC": "0",
                        "FID_ETC_CLS_CODE": "0"},
                timeout=15)
        except Exception as ex:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            warn_once("net", str(ex)[:120])
            return []

        if r.status_code == 200:
            d = r.json()
            break
        if attempt < retries and r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))     # 일시적 서버 오류 → 재시도
            continue
        warn_once("http", f"HTTP {r.status_code}")
        return []

    if d is None:
        return []
    if d.get("rt_cd") != "0":
        warn_once("api", f"rt_cd={d.get('rt_cd')} msg={str(d.get('msg1','')).strip()} (예: {code})")
        return []

    rows = [x for x in (d.get("output2") or []) if x]

    with _lock:
        if rows and not _dumped["flow"]:
            _dumped["flow"] = True
            print(f"\n   ── 첫 응답 필드 확인 ({code}, 기준일 {anchor}) ──")
            print("   " + json.dumps(rows[0], ensure_ascii=False)[:500])
            print(f"   → 날짜 {find_date(rows[0])} · {len(rows)}행\n")
    return rows


# ── KIS: 프로그램매매 종목별 일별 (03_daily_collect.py와 동일 tr_id/필드) ──────
def fetch_program_daily(token, code, anchor, retries=2):
    """기준일부터 과거 여러 거래일의 프로그램매매를 가져옵니다.
    2026-08-26 확정: whol_smtn_*_tr_pbmn은 이름과 달리 이미 '원' 단위."""
    d = None
    for attempt in range(retries + 1):
        _rate.acquire()
        try:
            r = requests.get(
                f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
                headers=kis_hdr(token, "FHPPG04650201"),
                params={"FID_COND_MRKT_DIV_CODE": "J",
                        "FID_INPUT_ISCD": code,
                        "FID_INPUT_DATE_1": anchor},
                timeout=15)
        except Exception as ex:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            warn_once("prog_net", str(ex)[:120])
            return []

        if r.status_code == 200:
            d = r.json()
            break
        if attempt < retries and r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))
            continue
        warn_once("prog_http", f"HTTP {r.status_code}")
        return []

    if d is None:
        return []
    if d.get("rt_cd") != "0":
        warn_once("prog_api", f"rt_cd={d.get('rt_cd')} msg={str(d.get('msg1','')).strip()} (예: {code})")
        return []

    rows = [x for x in (d.get("output") or []) if x]

    with _lock:
        if rows and not _dumped["program"]:
            _dumped["program"] = True
            print(f"\n   ── 프로그램매매 첫 응답 필드 확인 ({code}, 기준일 {anchor}) ──")
            print("   " + json.dumps(rows[0], ensure_ascii=False)[:500])
            print(f"   → 날짜 {find_date(rows[0])} · {len(rows)}행\n")
    return rows


# ── 행 파싱 ───────────────────────────────────────────────────────────────────
def parse_price(r, date_str, code, listed_sh, prev_close):
    close_p = safe_int(r.get("stck_clpr"))
    if close_p <= 0:
        return None, prev_close

    # 등락률: 직전 종가로 계산(소수점 정밀), 없으면 응답값(소수 2자리) 사용
    if prev_close:
        chg = (close_p - prev_close) / prev_close * 100
    else:
        chg = safe_float(r.get("prdy_ctrt"))

    row = (
        iso(date_str), code,
        safe_int(r.get("stck_oprc")),
        safe_int(r.get("stck_hgpr")),
        safe_int(r.get("stck_lwpr")),
        close_p,
        safe_int(r.get("acml_vol")),
        safe_int(r.get("acml_tr_pbmn")),          # 이 필드만 '원' 단위
        close_p * listed_sh if listed_sh else 0,
        listed_sh,
        round(chg, 4),
        "KIS", False,
    )
    return row, close_p


def parse_flow(r, date_str, code):
    """금액은 모두 백만원 단위 → ×1,000,000"""
    def amt(key):
        return safe_int(r.get(key)) * FLOW_UNIT

    inst = amt("orgn_ntby_tr_pbmn")

    # 기관 분해 합계가 기관합계와 맞는지 (데이터 이상 조기 감지)
    #
    # 허용오차: KIS는 각 항목을 '백만원 단위로 반올림'해서 줍니다.
    # 구성 7개가 각각 최대 ±0.5백만원, 기관합계 자체도 ±0.5백만원 오차를
    # 가질 수 있으므로 최대 ±4백만원까지는 반올림에 의한 정상 편차입니다.
    # (이보다 좁게 잡으면 정상 데이터에 경고가 쏟아집니다)
    parts = sum(amt(k) for k in (
        "scrt_ntby_tr_pbmn", "ivtr_ntby_tr_pbmn", "pe_fund_ntby_tr_pbmn",
        "bank_ntby_tr_pbmn", "insu_ntby_tr_pbmn", "mrbn_ntby_tr_pbmn",
        "fund_ntby_tr_pbmn"))
    if inst and abs(parts - inst) > 4 * FLOW_UNIT:
        warn_once("sum", f"기관합계 불일치 {code} {date_str}: 합={parts:,} vs {inst:,}", 3)

    return (
        iso(date_str), code,
        amt("frgn_reg_ntby_pbmn"),        # 외국인(등록) — KRX '외국인'과 동일
        inst,                             # 기관합계
        amt("scrt_ntby_tr_pbmn"),         # 금융투자
        amt("ivtr_ntby_tr_pbmn"),         # 투신
        amt("pe_fund_ntby_tr_pbmn"),      # 사모
        amt("fund_ntby_tr_pbmn"),         # 연기금·기금
        amt("prsn_ntby_tr_pbmn"),         # 개인
        amt("etc_corp_ntby_tr_pbmn"),     # 기타법인 — 같은 응답에 이미 들어있던 필드,
                                           # 2026-08-21 화면 노출 결정으로 복원
        # foreign_net_vol·inst_net_vol(거래량 기준)은 여전히 미저장(신호 엔진 미사용).
        "KIS", False,
    )


def parse_program(r, date_str, code):
    """whol_smtn_*_tr_pbmn은 이미 '원' 단위 (03_daily_collect.py와 동일 확정 사실)."""
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


def collect_stock(token, code, listed_sh):
    """한 종목의 전 기간을 수집. 반환 (price_rows, flow_rows, program_rows, status)"""
    try:
        raw = {}
        for a in ANCHORS:
            for r in fetch_daily(token, code, a):
                d = find_date(r)
                if d:
                    raw[d] = r          # 겹치는 날짜는 자연스럽게 덮어씀

        raw_prog = {}
        for a in ANCHORS:
            for r in fetch_program_daily(token, code, a):
                d = find_date(r)
                if d:
                    raw_prog[d] = r

        if not raw:
            return [], [], [], "skip"

        price_rows, flow_rows, program_rows = [], [], []
        prev_close = None
        for d in sorted(raw):           # 날짜 오름차순 → 등락률 계산 가능
            r = raw[d]
            prow, prev_close = parse_price(r, d, code, listed_sh, prev_close)
            if d < START_DATE or d > END_DATE:
                continue                # 범위 밖은 계산에만 쓰고 저장 안 함
            if prow:
                price_rows.append(prow)
                flow_rows.append(parse_flow(r, d, code))
                pr = raw_prog.get(d)
                if pr:
                    program_rows.append(parse_program(pr, d, code))

        return price_rows, flow_rows, program_rows, "ok"

    except Exception as ex:
        return [], [], [], f"err:{ex}"


# ── DB ────────────────────────────────────────────────────────────────────────
def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code, listed_shares FROM stocks "
                    "WHERE security_type='STOCK' ORDER BY code")
        rows = cur.fetchall()

    # KIS는 6자리 종목코드만 받습니다. 길이가 다른 값이 섞여 있으면
    # rt_cd=2 "INVALID INPUT_FILED_SIZE [FID_INPUT_ISCD]" 로 실패합니다.
    good, bad = {}, []
    for code, shares in rows:
        c_ = (code or "").strip()
        if len(c_) == 6:
            good[c_] = shares or 0
        else:
            bad.append(code)
    if bad:
        print(f"   ⚠ 종목코드 형식 이상 {len(bad)}건 제외: {bad[:5]}"
              f"{' ...' if len(bad) > 5 else ''}")
    return good


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


def upsert(price_rows, flow_rows, program_rows=None):
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        if price_rows:
            execute_values(cur, PRICE_SQL, price_rows, page_size=BATCH)
        if flow_rows:
            execute_values(cur, FLOW_SQL, flow_rows, page_size=BATCH)
        if program_rows:
            execute_values(cur, PROGRAM_SQL, program_rows, page_size=BATCH)
        c.commit()


# ── 디버그 ────────────────────────────────────────────────────────────────────
def run_debug():
    print("\n" + "=" * 70)
    print("DEBUG: 삼성전자(005930) 파싱 검증")
    print("=" * 70)
    token = get_token()
    rows = fetch_daily(token, "005930", "20260814")
    print(f"반환 행수: {len(rows)}")
    if not rows:
        print("⚠️ 0행")
        return

    print(f"\n날짜 범위: {find_date(rows[-1])} ~ {find_date(rows[0])}")

    prev = None
    parsed_p, parsed_f = [], []
    for d in sorted({find_date(r): r for r in rows if find_date(r)}):
        r = {find_date(x): x for x in rows if find_date(x)}[d]
        p, prev = parse_price(r, d, "005930", 5_919_637_922, prev)
        if p:
            parsed_p.append(p)
            parsed_f.append(parse_flow(r, d, "005930"))

    print(f"\n파싱 결과: price {len(parsed_p)}행 / flow {len(parsed_f)}행")
    print("\n[시세] 최근 3일")
    print(f"  {'날짜':<12}{'시가':>9}{'고가':>9}{'저가':>9}{'종가':>9}{'등락%':>8}{'거래대금(억)':>13}")
    for p in parsed_p[-3:]:
        print(f"  {p[0]:<12}{p[2]:>9,}{p[3]:>9,}{p[4]:>9,}{p[5]:>9,}{p[10]:>8.2f}{p[7]//100_000_000:>13,}")

    print("\n[수급] 최근 3일 (억원)")
    print(f"  {'날짜':<12}{'외국인':>10}{'기관':>10}{'금융투자':>10}{'투신':>9}{'사모':>9}{'연기금':>9}{'개인':>10}{'기타법인':>10}")
    for f in parsed_f[-3:]:
        # 인덱스: 0날짜 1코드 2외국인 3기관 4금융투자 5투신 6사모 7연기금 8개인 9기타법인
        print(f"  {f[0]:<12}{f[2]//100_000_000:>10,}{f[3]//100_000_000:>10,}"
              f"{f[4]//100_000_000:>10,}{f[5]//100_000_000:>9,}{f[6]//100_000_000:>9,}"
              f"{f[7]//100_000_000:>9,}{f[8]//100_000_000:>10,}{f[9]//100_000_000:>10,}")

    print("\n[검증] 2026-08-14 KRX 실측 대비")
    tgt = [f for f in parsed_f if f[0] == "2026-08-14"]
    if tgt:
        f = tgt[0]
        for name, got, want in (("외국인", f[2], 1_338_609_920_750),
                                ("기관합계", f[3], -497_830_074_500),
                                ("금융투자", f[4], -379_038_602_250),
                                ("연기금", f[7], 6_607_376_750)):
            diff = abs(got - want) / max(abs(want), 1) * 100
            mark = "✅" if diff < 0.01 else "⚠️"
            print(f"  {mark} {name:<8} 수집 {got:>18,}  실측 {want:>18,}  오차 {diff:.4f}%")
    print("\n(오차는 KIS가 백만원 단위로 반올림해 제공하기 때문이며 0.01% 미만이면 정상입니다)")

    print("\n" + "-" * 70)
    print("프로그램매매 확인 (005930, 기준일 20260814)")
    prows = fetch_program_daily(token, "005930", "20260814")
    print(f"반환 행수: {len(prows)}")
    if prows:
        print(f"날짜 범위: {find_date(prows[-1])} ~ {find_date(prows[0])}")
        for d in sorted({find_date(r): r for r in prows if find_date(r)})[-3:]:
            r = {find_date(x): x for x in prows if find_date(x)}[d]
            pg = parse_program(r, d, "005930")
            # 인덱스: 0날짜 1코드 2매수 3매도 4순매수 5매수량 6매도량 7순매수량
            print(f"  {pg[0]:<12} 순매수 {pg[4]//100_000_000:>8,}억  "
                  f"매수 {pg[2]//100_000_000:>8,}억  매도 {pg[3]//100_000_000:>8,}억")


# ── 현황 ──────────────────────────────────────────────────────────────────────
def compare_krx_kis():
    print("\n" + "=" * 64)
    print("적재 현황 (source별)")
    print("=" * 64)
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("""
            SELECT coalesce(source,'(null)'), count(*),
                   count(*) FILTER (WHERE close>0), count(*) FILTER (WHERE trade_amount>0)
            FROM daily_price WHERE trade_date BETWEEN %s AND %s GROUP BY 1 ORDER BY 2 DESC
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[daily_price]  {'source':<8}{'행수':>10}{'종가':>10}{'거래대금':>10}")
        for s_, n, cl, am in cur.fetchall():
            print(f"               {s_:<8}{n:>10,}{cl:>10,}{am:>10,}")

        cur.execute("""
            SELECT coalesce(source,'(null)'), count(*),
                   count(*) FILTER (WHERE foreign_net<>0), count(*) FILTER (WHERE inst_net<>0),
                   count(*) FILTER (WHERE inv_trust_net<>0), count(*) FILTER (WHERE pe_net<>0),
                   count(*) FILTER (WHERE individual_net<>0),
                   count(*) FILTER (WHERE corp_other_net IS NOT NULL)
            FROM daily_flow WHERE trade_date BETWEEN %s AND %s GROUP BY 1 ORDER BY 2 DESC
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[daily_flow]   {'source':<8}{'행수':>10}{'외국인':>9}{'기관':>9}{'투신':>9}{'사모':>9}{'개인':>9}{'기타법인':>10}")
        for s_, n, f_, i_, it, pe, pr, co in cur.fetchall():
            print(f"               {s_:<8}{n:>10,}{f_:>9,}{i_:>9,}{it:>9,}{pe:>9,}{pr:>9,}{co:>10,}")

        cur.execute("""
            SELECT p.trade_date, p.source, p.close, p.change_pct,
                   f.foreign_net, f.inst_net, f.inv_trust_net, f.pe_net, f.individual_net,
                   f.corp_other_net
            FROM daily_price p
            LEFT JOIN daily_flow f ON f.trade_date=p.trade_date AND f.code=p.code
            WHERE p.code='005930' AND p.trade_date BETWEEN %s AND %s
            ORDER BY p.trade_date DESC LIMIT 5
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[삼성전자] 최근 5일 (억원)")
        print(f"  {'날짜':<12}{'src':<5}{'종가':>9}{'등락%':>7}{'외국인':>9}{'기관':>9}{'투신':>8}{'사모':>8}{'개인':>9}{'기타법인':>10}")
        for r in cur.fetchall():
            print(f"  {str(r[0]):<12}{str(r[1] or '-'):<5}{r[2]:>9,}{float(r[3] or 0):>7.2f}"
                  f"{(r[4] or 0)//100_000_000:>9,}{(r[5] or 0)//100_000_000:>9,}"
                  f"{(r[6] or 0)//100_000_000:>8,}{(r[7] or 0)//100_000_000:>8,}"
                  f"{(r[8] or 0)//100_000_000:>9,}{(r[9] or 0)//100_000_000:>10,}")

        cur.execute("""
            SELECT coalesce(source,'(null)'), count(*),
                   count(*) FILTER (WHERE pgtr_net_amt<>0),
                   min(trade_date), max(trade_date)
            FROM daily_program WHERE trade_date BETWEEN %s AND %s GROUP BY 1 ORDER BY 2 DESC
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[daily_program] {'source':<8}{'행수':>10}{'순매수≠0':>10}   기간")
        for s_, n, ne, mn, mx in cur.fetchall():
            print(f"                {s_:<8}{n:>10,}{ne:>10,}   {mn} ~ {mx}")

        cur.execute("""
            SELECT trade_date, pgtr_buy_amt, pgtr_sell_amt, pgtr_net_amt
            FROM daily_program WHERE code='005930' AND trade_date BETWEEN %s AND %s
            ORDER BY trade_date DESC LIMIT 5
        """, (iso(START_DATE), iso(END_DATE)))
        print(f"\n[삼성전자 프로그램] 최근 5일 (억원)")
        print(f"  {'날짜':<12}{'매수':>10}{'매도':>10}{'순매수':>10}")
        for d_, b_, s_, n_ in cur.fetchall():
            print(f"  {str(d_):<12}{(b_ or 0)//100_000_000:>10,}{(s_ or 0)//100_000_000:>10,}"
                  f"{(n_ or 0)//100_000_000:>10,}")


# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    if DEBUG_MODE:
        run_debug()
        return
    if COMPARE_ONLY:
        compare_krx_kis()
        return

    t0 = time.time()
    print("\n① KIS 토큰 발급...")
    token = get_token()

    print("② 종목 목록 조회...")
    stocks = load_stocks()
    codes = list(stocks.keys())
    n = len(codes)
    calls = n * len(ANCHORS) * 2   # investor-trade + program-trade 두 엔드포인트
    print(f"   {n:,}개 종목 × {len(ANCHORS)}회 × 2엔드포인트 = {calls:,}회 호출 "
          f"→ 예상 {calls/MAX_RPS/60:.0f}분")

    print(f"\n③ 수집 중... (워커 {WORKERS} · 최대 {MAX_RPS}건/초)")
    price_buf, flow_buf, program_buf = [], [], []
    ok = skip = err = done = 0
    tot_p = tot_f = tot_g = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(collect_stock, token, c, stocks.get(c, 0)): c for c in codes}
        for fut in as_completed(futs):
            code = futs[fut]
            done += 1
            try:
                p_rows, f_rows, g_rows, status = fut.result()
            except Exception as e:
                err += 1
                warn_once("future", f"{code}: {e}")
                continue

            if status == "skip":
                skip += 1
            elif status == "ok":
                ok += 1
                price_buf.extend(p_rows)
                flow_buf.extend(f_rows)
                program_buf.extend(g_rows)
                if len(price_buf) >= BATCH * 10:
                    upsert(price_buf, flow_buf, program_buf)
                    tot_p += len(price_buf); tot_f += len(flow_buf); tot_g += len(program_buf)
                    price_buf, flow_buf, program_buf = [], [], []
                    print(f"   [{done:4d}/{n}] price={tot_p:,} flow={tot_f:,} program={tot_g:,} "
                          f"({int(time.time()-t0)}초)")
            else:
                err += 1
                warn_once("stock", f"{code} {status}")

    if price_buf or flow_buf or program_buf:
        upsert(price_buf, flow_buf, program_buf)
        tot_p += len(price_buf); tot_f += len(flow_buf); tot_g += len(program_buf)

    print(f"\n✅ 백필 완료: price {tot_p:,}행 / flow {tot_f:,}행 / program {tot_g:,}행")
    print(f"   ok={ok:,} skip={skip:,} err={err:,}  ({int(time.time()-t0)}초)")
    if tot_p == 0:
        print("⚠️ 0행입니다. 위 '첫 응답 필드 확인' 로그를 보세요.")
    compare_krx_kis()


if __name__ == "__main__":
    main()
