# -*- coding: utf-8 -*-
"""
STOCK RADAR · 종목 업종 세분화(sector_kis) 갱신
=================================================
지금 화면에 쓰는 stocks.sector_krx는 2026년 초 수급주체정리.xlsx '업종' 시트를
1회성으로 마이그레이션한 값입니다(01_schema.sql 주석: "시드는 수급주체정리.xlsx
업종 시트... 이후 KIS search_stock_info로 주 1회 갱신" — 그런데 그 갱신 스크립트가
실제로는 한 번도 작성된 적이 없어서 sector_kis/sector_kis_lcls 컬럼이 스키마에만
있고 계속 비어 있었습니다).

이 xlsx 매핑은 한국표준산업분류 계열의 굵은 대분류라 화장품 제조사(에이피알·
한국콜마·코스맥스 등)가 '화학'으로 묶이는 등 체감 업종과 다르게 보이는 원인입니다.

이 스크립트는 KIS 주식기본조회(search-stock-info, tr_id CTPF1002R)를 종목별로
호출해 KIS가 매기는 업종 분류를 stocks.sector_kis(중분류)/sector_kis_lcls(대분류)
컬럼에 채웁니다. sector_krx는 백테스트 재현성 때문에 절대 건드리지 않습니다 —
05_compute.py의 업종 RS 계산은 지금과 동일하게 sector_krx 그룹을 그대로 씁니다.

⚠ 필드명 미검증 상태입니다. 반드시 아래 순서로 사용하세요.
  1) python 21_sector_kis_refresh.py --debug 161890   (한국콜마로 실제 응답 확인.
     이전 기본값 003920은 실제로는 남양유업이었습니다 — 첫 --debug 실행에서
     확인된 실수라 여기서 161890으로 정정합니다)
     → 위 응답에서 '업종'에 해당하는 필드와 값이 기대한 형태(예: '화장품')인지 확인
     → 다르면 CANDIDATE_MCLS / CANDIDATE_LCLS 리스트에 실제 필드명을 추가하세요
  2) python 21_sector_kis_refresh.py            (전체 종목 갱신, 주 1회 실행 권장)

  2026-08-20 003920(남양유업) --debug 1차 실행 결과로 이미 한 가지는 확인됐습니다:
  idx_bztp_lcls_cd_name은 '시가총액규모중' 같은 값을 주는 시가총액 규모 구분
  필드였지 업종 대분류가 아니었습니다 — CANDIDATE_LCLS에서 제외했습니다.
  반면 idx_bztp_mcls_cd_name/idx_bztp_scls_cd_name은 '음식료품'처럼 그럴듯한
  업종명을 줬고, std_idst_clsf_cd_name(표준산업분류명)은 '동물성 및 식물성
  유지 제조업'처럼 훨씬 더 잘게 쪼갠 값을 줬습니다 — 다만 남양유업은 화장품
  케이스가 아니라서 idx_bztp_mcls_cd_name이 화장품/화학을 실제로 구분해
  주는지는 아직 확인 전입니다. 161890으로 다시 확인해주세요.

필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, SUPABASE_DB_URL
(GitHub Actions에서 실행할 땐 03_daily_collect.py와 같은 시크릿을 그대로 씁니다)
"""
import os, sys, time, threading
import requests, psycopg2
from psycopg2.extras import execute_values

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")

WORKERS  = 8
MAX_RPS  = 15
BATCH    = 500

# 2026-08-20 003920(남양유업) --debug 실측으로 갱신한 후보 목록.
# idx_bztp_mcls_cd_name/idx_bztp_scls_cd_name은 실제 존재하고 그럴듯한 값('음식료품')을
# 줬지만 화장품 케이스(161890 등)로는 아직 확인 전입니다. idx_bztp_lcls_cd_name은
# 업종이 아니라 시가총액 규모('시가총액규모중') 구분이라 후보에서 뺐습니다.
# std_idst_clsf_cd_name(표준산업분류명, '동물성 및 식물성 유지 제조업')은 종목마다
# 거의 유니크할 만큼 잘게 쪼개져 있어 '업종 그룹'용으로는 너무 세분화될 수 있습니다 —
# 세부업종 표시용 백업 후보로만 마지막에 둡니다.
CANDIDATE_MCLS = ["idx_bztp_mcls_cd_name", "idx_bztp_scls_cd_name", "std_idst_clsf_cd_name"]
CANDIDATE_LCLS = ["idx_bztp_scls_cd_name", "std_idst_clsf_cd_name"]

DEBUG_MODE = False
DEBUG_CODE = None
if len(sys.argv) >= 2 and sys.argv[1] == "--debug":
    DEBUG_MODE = True
    DEBUG_CODE = sys.argv[2] if len(sys.argv) > 2 else "003920"  # 한국콜마

if not DEBUG_MODE:
    if not KIS_KEY or not KIS_SECRET:
        sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")
    if not DB_URL:
        sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")


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


def pick(row, *names):
    if not row:
        return None
    for n in names:
        if n in row and str(row[n]).strip() not in ("", "-"):
            return row[n]
    return None


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


def fetch_stock_info(token, code):
    """KIS 주식기본조회 — 업종 분류 등 종목 메타 정보. 30초에 1회 제한이 있다는
    보고가 있어 --partial 스냅샷과는 달리 넉넉히 쉬어가며 호출합니다."""
    _rate.acquire()
    r = requests.get(
        f"{KIS_BASE}/uapi/domestic-stock/v1/quotations/search-stock-info",
        headers=kis_headers(token, "CTPF1002R"),
        params={"PRDT_TYPE_CD": "300", "PDNO": code},
        timeout=10
    )
    if r.status_code != 200:
        return None
    d = r.json()
    if d.get("rt_cd") != "0":
        return None
    return d.get("output")


def run_debug():
    import json
    print(f"\n=== DEBUG: 종목기본조회 {DEBUG_CODE} ===\n")
    token = get_token() if (KIS_KEY and KIS_SECRET) else sys.exit(
        "❌ --debug도 KIS_APP_KEY/KIS_APP_SECRET은 필요합니다.")
    out = fetch_stock_info(token, DEBUG_CODE)
    print(json.dumps(out, ensure_ascii=False, indent=2) if out else "  (데이터 없음)")
    print("""
→ 위 JSON에서 '업종'에 해당하는 필드를 찾아 CANDIDATE_MCLS/CANDIDATE_LCLS 맨
  앞에 추가하세요(정확한 필드명일수록 앞에 둘수록 우선 채택됩니다).
  기대값 예시: 한국콜마(003920)라면 '화장품' 또는 그에 준하는 세분류가 나와야
  기존 sector_krx('화학')보다 나아진 것입니다. 여전히 큰 대분류만 나온다면
  이 엔드포인트로는 원하는 세분화를 못 얻는다는 뜻이니 알려주세요 — 다른
  대안(KRX 업종분류 파일 재수입 등)을 검토해야 합니다.
""")


def load_stocks():
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT code FROM stocks WHERE security_type = 'STOCK' ORDER BY code")
        return [r[0] for r in cur.fetchall()]


SECTOR_KIS_SQL = """
UPDATE stocks AS s SET sector_kis = v.mcls, sector_kis_lcls = v.lcls, updated_at = now()
FROM (VALUES %s) AS v(code, mcls, lcls)
WHERE s.code = v.code
  AND (v.mcls IS DISTINCT FROM s.sector_kis OR v.lcls IS DISTINCT FROM s.sector_kis_lcls)
"""


def upsert(rows):
    if not rows:
        return
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        execute_values(cur, SECTOR_KIS_SQL, rows, page_size=BATCH)
        c.commit()


def log_result(status, n, message=""):
    try:
        with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
            cur.execute(
                "INSERT INTO ingest_log (job, status, row_count, message) VALUES (%s,%s,%s,%s)",
                ("sector_kis_refresh", status, n, message[:500]))
            c.commit()
    except Exception as ex:
        print(f"  ⚠ ingest_log 기록 실패: {ex}")


def main():
    from concurrent.futures import ThreadPoolExecutor, as_completed
    t0 = time.time()
    print("① KIS 토큰 발급...")
    token = get_token()
    print("② 종목 목록 조회...")
    codes = load_stocks()
    print(f"   {len(codes):,}개 종목")

    rows, ok, err = [], 0, 0

    def one(code):
        try:
            out = fetch_stock_info(token, code)
            if not out:
                return code, None, None
            mcls = pick(out, *CANDIDATE_MCLS)
            lcls = pick(out, *CANDIDATE_LCLS)
            return code, (str(mcls).strip() if mcls else None), (str(lcls).strip() if lcls else None)
        except Exception:
            return code, None, None

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(one, c): c for c in codes}
        for i, fut in enumerate(as_completed(futs), 1):
            code, mcls, lcls = fut.result()
            if mcls or lcls:
                rows.append((code, mcls, lcls))
                ok += 1
            else:
                err += 1
            if len(rows) >= BATCH:
                upsert(rows)
                rows = []
            if i % 500 == 0:
                print(f"   [{i}/{len(codes)}] 진행 중... ({int(time.time()-t0)}초 경과)")

    upsert(rows)
    dur = int((time.time() - t0) * 1000)
    print(f"\n✅ 완료: 업종 확보 {ok:,} / 실패·없음 {err:,}  ({dur//1000}초)")
    log_result("SUCCESS" if ok else "FAIL", ok, f"ok={ok} err={err}")


if __name__ == "__main__":
    if DEBUG_MODE:
        run_debug()
    else:
        main()
