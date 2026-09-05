# -*- coding: utf-8 -*-
"""
STOCK RADAR · "전략 성과2"(상따) 후보 생성기 — 장전 / NXT / 정규장초반 3단계
==========================================================================
sangtta_virtual_trading_spec.md 1~3절 파이프라인을 구현합니다.
intraday_candidates(trade_date, code, source, rank, snapshot)에
단계별로 UPSERT합니다 (source: PRE_MARKET / NXT / REGULAR).

⚠ 설계상 트레이드오프 (아래 "구현 노트" 참고)
  - PRE_MARKET 단계는 기존 daily_metrics/signals 테이블만 읽으므로 API 위험이
    없고, 검증된 03_daily_collect.py 패턴과 동일한 방식으로 동작합니다.
  - NXT / REGULAR 단계는 "전체 시장 랭킹 API"(거래대금순위 등)의 정확한
    파라미터를 이 환경에서 실거래 없이 검증할 수 없어서, 리스크를 낮추기 위해
    이미 검증된 종목별 현재가 조회(inquire-price, FHKST01010100)를 후보
    유니버스(PRE_MARKET ∪ 그 전 단계 결과, 최대 CANDIDATE_POOL_LIMIT종목)에만
    반복 호출하는 방식으로 구현했습니다. 시장 전체에서 리스트 밖 신규 급등
    종목을 잡아내는 역할은 이 스크립트가 아니라 relay-server의 실시간 체결
    감지(장중 신규 편입, source=NEW_DETECTED)가 담당합니다.
  - NXT 시세 조회는 FID_COND_MRKT_DIV_CODE="NX"로 시도합니다. 이 파라미터는
    KIS가 NXT 지원을 추가하면서 생긴 값인데 이 환경에서는 실제 NXT 개장
    시간에 검증이 불가능했습니다. 첫 실행(장전 NXT 시간대) 로그와
    intraday_candidates.snapshot의 raw 필드를 반드시 확인하세요. 실패 시
    자동으로 해당 종목을 건너뛰고 경고만 남깁니다(스크립트 자체는 죽지 않음).

필요 환경변수
  KIS_APP_KEY / KIS_APP_SECRET   (NXT·REGULAR 단계에서만 필요, PRE_MARKET은 불필요)
  SUPABASE_DB_URL
  KIS_ACCESS_TOKEN               (있으면 재사용 — daily_collect.yml과 동일 관례)

  - SCAN 단계는 장중(09:15~15:20 KST) 5분 간격으로 실행되어 "지금까지 후보에
    없던" 신규 급등 종목을 계속 편입시킵니다. ⚠ 최초 구현에서는 거래대금순위
    (FHPST01710000)를 썼는데, 이건 삼성전자·SK하이닉스처럼 시가총액이 커서
    등락률은 낮아도(1~2%) 거래대금 절대액은 항상 큰 종목이 상위를 독점하는
    구조적 문제가 있습니다. 상따는 "당일 등락률이 빠르게 오르는 중인 종목을
    초반에 잡는 것"이 목적이라 거래대금 절대액이 아니라 등락률 자체로 줄을
    세워야 합니다. 그래서 국내주식 등락률 순위(FHPST01700000, 상승율순)로
    교체했습니다 — 이 종목이 지금 얼마나 빠르게 오르고 있는지가 직접 정렬
    기준이 되므로, 시가총액이 큰 종목은 애초에 그만큼 급등하기 어려워 자연히
    상위권에서 걸러집니다. 이 랭킹 API의 정확한 파라미터(FID_RANK_SORT_CLS_CODE
    값 매핑, FID_COND_SCR_DIV_CODE=20170 등)도 이 환경에서는 실거래 없이
    검증 불가능하여, 실패해도 스크립트가 죽지 않고 경고만 남기도록 방어적으로
    구현했습니다. 최초 장중 실행 로그를 꼭 확인하세요.
  - 등락률 순위 API 자체에도 최소 등락률(SCAN_MIN_CHANGE_PCT)·최소가격
    (SCAN_MIN_PRICE)·최소거래량 필터를 걸어 동전주·품절주 노이즈를 줄이고,
    응답에서 우선주/스팩으로 보이는 종목명은 Python 쪽에서 한 번 더 걸러냅니다
    (정확한 제외 플래그 조합도 미검증이라 이름 패턴으로 이중 방어).
  - intraday_candidates는 (trade_date, code, source) UPSERT 시 created_at을
    항상 now()로 갱신하므로, relay-server 쪽에서는 "최근에 갱신된 순"으로만
    정렬해 상위 N개만 실시간 구독하면 자연스럽게 오래된 후보가 밀려납니다
    (KIS 웹소켓 동시구독 한도 대응 — server.js SANGTTA_MAX_TRACKED 참고).

사용법
  python 66_intraday_candidates.py pre_market
  python 66_intraday_candidates.py nxt
  python 66_intraday_candidates.py regular
  python 66_intraday_candidates.py scan
"""
import os, sys, time, datetime, json, threading, re
from datetime import timezone, timedelta
import requests, psycopg2
from psycopg2.extras import execute_values, Json

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

CANDIDATE_POOL_LIMIT = 40   # NXT/REGULAR 단계에서 종목별 현재가를 조회할 최대 종목 수
TOP_N = 10
SCAN_TOP_N = 15             # SCAN 단계에서 신규 편입할 최대 종목 수(1회 실행당)
SCAN_MIN_CHANGE_PCT = 5.0   # 등락률 순위 API에 걸 최소 상승률(%) — 이 밑은 아예 조회 안 함
SCAN_MIN_PRICE = 1000       # 최소 주가(원) — 동전주 노이즈 제외
SCAN_MIN_VOL = 10000        # 최소 누적거래량(주) — 품절주/거래정지성 종목 노이즈 제외
# 우선주(...우, ...우B, ...2우 등)·스팩("OOO기업인수목적" 류) 이름 패턴 — 등락률
# 순위 API의 제외 플래그 조합이 미검증이라 이름으로 한 번 더 방어적으로 거름.
_PREFERRED_OR_SPAC_RE = re.compile(r"(\d?우[A-Z]?$|스팩|기업인수목적)")

# SCAN 단계 유효 시간대(KST, 분 단위) — 정규장 초반 재선별(09:12) 직후부터
# 장 마감 전까지만 의미가 있음. 크론 자체는 넉넉하게 걸어두고 여기서 내부 가드.
SCAN_START_MIN = 9 * 60 + 15
SCAN_END_MIN = 15 * 60 + 20

KST = timezone(timedelta(hours=9))

if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

STAGE = sys.argv[1] if len(sys.argv) > 1 else ""
if STAGE not in ("pre_market", "nxt", "regular", "scan"):
    sys.exit("사용법: python 66_intraday_candidates.py [pre_market|nxt|regular|scan]")

_now_kst = datetime.datetime.now(KST)
TODAY = _now_kst.date().isoformat()
_KST_MINUTES_NOW = _now_kst.hour * 60 + _now_kst.minute


# ── 공통 유틸 ────────────────────────────────────────────────────────────────
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

_rate = RateLimiter(15)


def get_token():
    reuse = os.environ.get("KIS_ACCESS_TOKEN", "")
    if reuse:
        return reuse
    if not KIS_KEY or not KIS_SECRET:
        return None
    r = requests.post(
        f"{KIS_BASE}/oauth2/tokenP",
        json={"grant_type": "client_credentials", "appkey": KIS_KEY, "appsecret": KIS_SECRET},
        timeout=15,
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


def fetch_price(token, code, market_div="J"):
    """FHKST01010100 (주식현재가 시세). market_div="NX"는 NXT 시도용(검증 필요, 구현 노트 참고)."""
    _rate.acquire()
    try:
        r = requests.get(
            f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price",
            headers=kis_headers(token, "FHKST01010100"),
            params={"FID_COND_MRKT_DIV_CODE": market_div, "FID_INPUT_ISCD": code},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        d = r.json()
        if d.get("rt_cd") != "0":
            return None
        return d.get("output")
    except Exception as e:
        print(f"  ⚠ {code} 시세 조회 실패({market_div}): {e}")
        return None


def safe_num(v, default=0.0):
    try:
        s = str(v).replace(",", "").strip()
        return float(s) if s not in ("", "-", "None") else default
    except Exception:
        return default


def upsert_candidates(rows, source):
    """rows: [{code, rank, snapshot}]"""
    if not rows:
        print(f"  {source}: 후보 없음 — 저장 생략")
        return
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO intraday_candidates (trade_date, code, source, rank, snapshot)
                VALUES %s
                ON CONFLICT (trade_date, code, source) DO UPDATE SET
                    rank = EXCLUDED.rank,
                    snapshot = EXCLUDED.snapshot,
                    created_at = now()
                """,
                [(TODAY, r["code"], source, r["rank"], Json(r["snapshot"])) for r in rows],
            )
        print(f"  {source}: {len(rows)}건 저장 완료")
    finally:
        conn.close()


def fetch_existing_candidate_codes(sources):
    """지금까지 쌓인 후보 코드 목록 (다음 단계의 조회 유니버스로 사용)"""
    conn = psycopg2.connect(DB_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT code FROM intraday_candidates WHERE trade_date=%s AND source = ANY(%s)",
                (TODAY, sources),
            )
            return [r[0] for r in cur.fetchall()]
    finally:
        conn.close()


# ── 1) 장전 (PRE_MARKET) — 순수 DB 기반, API 불필요 ──────────────────────────
def stage_pre_market():
    """전략성과 3단계 통과 종목(V4_CAND_TREND_3 / V4_CAND_CLOSEBET_3, 가장 최근
    trade_date) + daily_metrics.weight_rank 당일 Top10 을 합쳐 1차 유니버스로 저장."""
    conn = psycopg2.connect(DB_URL)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT max(trade_date) FROM signals WHERE signal_type LIKE 'V4_CAND_%'
            """)
            latest = cur.fetchone()[0]
            if not latest:
                print("  PRE_MARKET: V4_CAND_* 신호가 없음 — 후보 생성 불가")
                return

            cur.execute("""
                SELECT s.code, st.name, s.signal_type, s.score, s.reason
                FROM signals s
                JOIN stocks st ON st.code = s.code
                WHERE s.trade_date = %s
                  AND s.signal_type IN ('V4_CAND_TREND_3', 'V4_CAND_CLOSEBET_3')
            """, (latest,))
            trend_rows = cur.fetchall()

            cur.execute("""
                SELECT m.code, st.name, m.weight_rank, m.pick_score
                FROM daily_metrics m
                JOIN stocks st ON st.code = m.code
                WHERE m.trade_date = %s AND m.weight_rank IS NOT NULL
                ORDER BY m.weight_rank ASC
                LIMIT %s
            """, (latest, TOP_N))
            weight_rows = cur.fetchall()
    finally:
        conn.close()

    merged = {}  # code -> snapshot dict
    for code, name, sig_type, score, reason in trend_rows:
        m = merged.setdefault(code, {"code": code, "name": name, "sources": [], "score": None})
        m["sources"].append(sig_type)
        m["reason"] = reason
        if score is not None:
            m["score"] = max(m["score"] or 0, float(score))

    for code, name, weight_rank, pick_score in weight_rows:
        m = merged.setdefault(code, {"code": code, "name": name, "sources": [], "score": None})
        m["sources"].append(f"WEIGHT_TOP10(#{weight_rank})")
        m["weight_rank"] = weight_rank
        m["pick_score"] = float(pick_score) if pick_score is not None else None

    # 정렬: score(있으면) desc, 없으면 weight_rank asc 를 보조키로
    def sort_key(m):
        return (-(m.get("score") or -1), m.get("weight_rank") or 999)

    ordered = sorted(merged.values(), key=sort_key)
    rows = []
    for i, m in enumerate(ordered, start=1):
        rows.append({
            "code": m["code"],
            "rank": i,
            "snapshot": {
                "name": m["name"],
                "base_date": str(latest),
                "sources": m["sources"],
                "score": m.get("score"),
                "weight_rank": m.get("weight_rank"),
                "pick_score": m.get("pick_score"),
            },
        })
    print(f"  PRE_MARKET: 기준일 {latest}, 전략3단계 {len(trend_rows)}건 + 무게상위 {len(weight_rows)}건 → 유니크 {len(rows)}건")
    upsert_candidates(rows, "PRE_MARKET")


# ── 2) NXT (08:00~08:45) ──────────────────────────────────────────────────
def stage_nxt():
    pool = fetch_existing_candidate_codes(["PRE_MARKET"])[:CANDIDATE_POOL_LIMIT]
    if not pool:
        print("  NXT: PRE_MARKET 후보가 없어 조회 유니버스가 비어있음 — 스킵")
        return
    token = get_token()
    if not token:
        print("  NXT: KIS 토큰 없음(KIS_APP_KEY/SECRET 미설정) — 스킵")
        return

    scored = []
    for code in pool:
        out = fetch_price(token, code, market_div="NX")
        if not out:
            continue
        change_pct = safe_num(out.get("prdy_ctrt"))
        price = safe_num(out.get("stck_prpr"))
        scored.append({
            "code": code,
            "change_pct": change_pct,
            "price": price,
            "raw": out,
        })

    if not scored:
        print("  NXT: 유효 응답 없음 (market_div=NX 파라미터를 실제 NXT 개장 시간에 재검증 필요) — 스킵")
        return

    scored.sort(key=lambda r: r["change_pct"], reverse=True)
    top = scored[:TOP_N]
    # 두드러진 상승(+5% 이상)은 PRE_MARKET 밖이어도 편입 — 여기선 이미 pool이
    # PRE_MARKET 한정이라 항상 교집합이지만, 유니버스를 넓히고 싶으면
    # CANDIDATE_POOL_LIMIT과 pool 소스를 확장하면 됨(구현 노트 참고).
    rows = []
    for i, r in enumerate(top, start=1):
        rows.append({
            "code": r["code"],
            "rank": i,
            "snapshot": {
                "change_pct": r["change_pct"],
                "price": r["price"],
                "market_div_tried": "NX",
            },
        })
    print(f"  NXT: 조회 {len(pool)}건 중 유효 {len(scored)}건 → Top{len(rows)} 저장")
    upsert_candidates(rows, "NXT")


# ── 3) 정규장 초반 재선별 (09:10~09:15) ──────────────────────────────────────
def stage_regular():
    pool = fetch_existing_candidate_codes(["PRE_MARKET", "NXT"])[:CANDIDATE_POOL_LIMIT]
    if not pool:
        print("  REGULAR: 이전 단계 후보가 없어 조회 유니버스가 비어있음 — 스킵")
        return
    token = get_token()
    if not token:
        print("  REGULAR: KIS 토큰 없음 — 스킵")
        return

    scored = []
    for code in pool:
        out = fetch_price(token, code, market_div="J")
        if not out:
            continue
        price = safe_num(out.get("stck_prpr"))
        high = safe_num(out.get("stck_hgpr"))
        acc_amt = safe_num(out.get("acml_tr_pbmn"))  # 누적거래대금(원)
        change_pct = safe_num(out.get("prdy_ctrt"))
        is_new_high = price >= high and price > 0
        scored.append({
            "code": code,
            "price": price,
            "acc_amt": acc_amt,
            "change_pct": change_pct,
            "is_new_high": is_new_high,
        })

    if not scored:
        print("  REGULAR: 유효 응답 없음 — 스킵")
        return

    # 거래대금 상위를 우선하되, 신고가 돌파 종목에 가중치를 줘서 앞으로 당김
    scored.sort(key=lambda r: (r["is_new_high"], r["acc_amt"]), reverse=True)
    top = scored[:TOP_N]
    rows = []
    for i, r in enumerate(top, start=1):
        rows.append({
            "code": r["code"],
            "rank": i,
            "snapshot": {
                "price": r["price"],
                "acc_amt": r["acc_amt"],
                "change_pct": r["change_pct"],
                "is_new_high": r["is_new_high"],
            },
        })
    print(f"  REGULAR: 조회 {len(pool)}건 중 유효 {len(scored)}건 → Top{len(rows)} 저장 (신고가 {sum(1 for r in top if r['is_new_high'])}건)")
    upsert_candidates(rows, "REGULAR")


def fetch_all_known_codes():
    """오늘 이미 후보로 잡힌 모든 종목(어느 source든) — SCAN에서 중복 편입 방지용."""
    conn = psycopg2.connect(DB_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT code FROM intraday_candidates WHERE trade_date=%s",
                (TODAY,),
            )
            return {r[0] for r in cur.fetchall()}
    finally:
        conn.close()


def fetch_change_rate_rank(token, limit=30):
    """FHPST01700000 (국내주식 등락률 순위, 상승율순). 거래대금순위와 달리
    "지금 얼마나 빠르게 오르고 있는가" 자체로 정렬하므로, 시가총액이 커서
    거래대금은 항상 크지만 등락률은 낮은 삼성전자·SK하이닉스 같은 종목이
    상위를 독점하는 문제가 구조적으로 없다(그런 종목은 이 API에서 애초에
    상위권에 오르지 못함). 파라미터 검증 불가 항목 — 구현 노트 참고.
    실패 시 빈 리스트를 반환하고 경고만 남김(스크립트는 계속 진행)."""
    _rate.acquire()
    try:
        r = requests.get(
            f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/fluctuation-rank",
            headers=kis_headers(token, "FHPST01700000"),
            params={
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_COND_SCR_DIV_CODE": "20170",
                "FID_INPUT_ISCD": "0000",           # 0000=전체(코스피+코스닥)
                "FID_RANK_SORT_CLS_CODE": "0",       # 0=상승율순 (검증 필요)
                "FID_INPUT_CNT_1": "0",
                "FID_PRC_CLS_CODE": "0",
                "FID_INPUT_PRICE_1": str(SCAN_MIN_PRICE),
                "FID_INPUT_PRICE_2": "",
                "FID_VOL_CNT": str(SCAN_MIN_VOL),
                "FID_TRGT_CLS_CODE": "0",
                "FID_TRGT_EXLS_CLS_CODE": "0000000000",
                "FID_DIV_CLS_CODE": "0",
                "FID_RSFL_RATE1": str(SCAN_MIN_CHANGE_PCT),  # 최소 등락률(%) — 이 밑은 API가 아예 제외
                "FID_RSFL_RATE2": "",
            },
            timeout=10,
        )
        if r.status_code != 200:
            print(f"  ⚠ SCAN: 등락률순위 API 응답코드 {r.status_code} — 스킵")
            return []
        d = r.json()
        if d.get("rt_cd") != "0":
            print(f"  ⚠ SCAN: 등락률순위 API rt_cd={d.get('rt_cd')} msg={d.get('msg1')} — 파라미터 재검증 필요, 스킵")
            return []
        rows = d.get("output", []) or []
        return rows[:limit]
    except Exception as e:
        print(f"  ⚠ SCAN: 등락률순위 조회 실패(파라미터 재검증 필요): {e}")
        return []


# ── 4) 장중 연속 스캔 (SCAN, 09:15~15:20, 5분 간격) ───────────────────────────
def stage_scan():
    """휴리스틱: NEW_DETECTED(웹소켓 체결 기반)는 이미 구독 중인 종목에서만
    포착 가능하므로, 시장 전체에서 완전히 새로운 급등 종목을 잡아내려면 REST
    랭킹 API로 주기적으로 훑어야 함. 여기서 찾은 신규 종목만 SCAN 소스로
    upsert하고(기존 후보 재중복 skip), relay-server가 2분 주기로 폴링해
    자동으로 실시간 구독 대상에 편입시킨다(server.js refreshSangttaCandidates).

    ⚠ 거래대금순위가 아니라 등락률순위(상승율순)를 쓰는 이유: 상따는 "지금
    빠르게 오르고 있는 종목"을 찾는 것이 목적인데, 거래대금 절대액 기준으로
    줄을 세우면 삼성전자·SK하이닉스처럼 등락률은 1~2%뿐이어도 시가총액이
    커서 거래대금 자체는 항상 최상위인 종목들이 계속 걸려버린다. 등락률로
    직접 정렬하면 그런 종목은 애초에 그 정도로 급등하는 일이 드물어 자연히
    걸러지고, 실제로 오늘 크게 움직이는 중소형주 위주로 후보가 채워진다."""
    if not (SCAN_START_MIN <= _KST_MINUTES_NOW <= SCAN_END_MIN):
        print(f"  SCAN: 장중 스캔 시간대(09:15~15:20 KST) 밖(현재 {_now_kst.strftime('%H:%M')} KST) — 스킵")
        return

    token = get_token()
    if not token:
        print("  SCAN: KIS 토큰 없음 — 스킵")
        return

    ranked = fetch_change_rate_rank(token, limit=30)
    if not ranked:
        return

    known = fetch_all_known_codes()
    skipped_pref = 0
    new_rows = []
    for i, out in enumerate(ranked, start=1):
        code = out.get("stck_shrn_iscd") or out.get("mksc_shrn_iscd") or out.get("code")
        name = out.get("hts_kor_isnm") or ""
        if not code or code in known:
            continue
        if _PREFERRED_OR_SPAC_RE.search(name):
            skipped_pref += 1
            continue
        change_pct = safe_num(out.get("prdy_ctrt"))
        price = safe_num(out.get("stck_prpr"))
        acc_amt = safe_num(out.get("acml_tr_pbmn"))
        if price and price < SCAN_MIN_PRICE:
            continue
        new_rows.append({
            "code": code,
            "rank": i,
            "snapshot": {
                "name": name or None,
                "price": price,
                "change_pct": change_pct,
                "acc_amt": acc_amt,
                "detected_at": _now_kst.strftime("%H:%M:%S"),
            },
        })
        if len(new_rows) >= SCAN_TOP_N:
            break

    if not new_rows:
        print(f"  SCAN: 등락률순위 {len(ranked)}건 중 신규 종목 없음(모두 기존 후보, 우선주/스팩 {skipped_pref}건 제외) — 저장 생략")
        return

    print(f"  SCAN: 등락률순위 {len(ranked)}건 중 신규 {len(new_rows)}건 편입(우선주/스팩 {skipped_pref}건 제외)")
    upsert_candidates(new_rows, "SCAN")


def main():
    print(f"▶ 전략성과2 후보 생성 — stage={STAGE}, date={TODAY} (KST {_now_kst.strftime('%H:%M')})")
    if STAGE == "pre_market":
        stage_pre_market()
    elif STAGE == "nxt":
        stage_nxt()
    elif STAGE == "regular":
        stage_regular()
    elif STAGE == "scan":
        stage_scan()


if __name__ == "__main__":
    main()
