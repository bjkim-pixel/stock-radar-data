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

사용법
  python 66_intraday_candidates.py pre_market
  python 66_intraday_candidates.py nxt
  python 66_intraday_candidates.py regular
"""
import os, sys, time, datetime, json, threading
import requests, psycopg2
from psycopg2.extras import execute_values, Json

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

CANDIDATE_POOL_LIMIT = 40   # NXT/REGULAR 단계에서 종목별 현재가를 조회할 최대 종목 수
TOP_N = 10

if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

STAGE = sys.argv[1] if len(sys.argv) > 1 else ""
if STAGE not in ("pre_market", "nxt", "regular"):
    sys.exit("사용법: python 66_intraday_candidates.py [pre_market|nxt|regular]")

TODAY = datetime.date.today().isoformat()


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


def main():
    print(f"▶ 전략성과2 후보 생성 — stage={STAGE}, date={TODAY}")
    if STAGE == "pre_market":
        stage_pre_market()
    elif STAGE == "nxt":
        stage_nxt()
    elif STAGE == "regular":
        stage_regular()


if __name__ == "__main__":
    main()
