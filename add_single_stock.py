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

────────────────────────────────────────────────────────────────────────────
2026-09-23: KIS 호출/파싱/SQL 로직을 kis_flow_common.py로 옮겼습니다(이 파일과
04_backfill.py가 같은 로직을 따로 들고 있다가, 2026-09-21(필드명)·09-23(프로그램
매매 엔드포인트) 두 번이나 이 파일에만 있던 버그가 나서 통합). 검증 근거는
kis_flow_common.py 상단 docstring 참고.
────────────────────────────────────────────────────────────────────────────
"""
import os, sys, time, datetime
import psycopg2
from psycopg2.extras import execute_values

import kis_flow_common as kis

DB_URL = os.environ.get("SUPABASE_DB_URL", "")

MAX_RPS = 18
BATCH   = 500

_rate = kis.RateLimiter(MAX_RPS)

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
ANCHORS = kis.anchors(START_DATE, END_DATE)

print(f"\n▶ 대상 종목  : {CODE} {NAME} ({MARKET})")
print(f"▶ 백필 범위  : {START_DATE} ~ {END_DATE}")
print(f"▶ 업종(sector_krx): {SECTOR_KRX or '(미지정)'}")

if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")
if not kis.KIS_KEY or not kis.KIS_SECRET:
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수를 설정하세요.")

_last_fetch_diag = ""  # 2026-09-19: raw가 끝내 비면 왜 비었는지 로그에 남기기 위한 진단 메시지


def get_token():
    return kis.get_token(warn=print)


def fetch_listed_shares(token, code):
    return kis.fetch_listed_shares(token, code, _rate)


def fetch_daily(token, code, anchor, retries=2):
    global _last_fetch_diag
    diag = {}
    rows = kis.fetch_daily(token, code, anchor, _rate, retries=retries, diag=diag)
    if diag.get("msg"):
        _last_fetch_diag = diag["msg"]
    return rows


def fetch_program_daily(token, code, anchor, retries=2):
    return kis.fetch_program_daily(token, code, anchor, _rate, retries=retries)


def parse_flow(r, date_str, code):
    return kis.parse_flow(r, date_str, code, warn=print)


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
              name          = EXCLUDED.name,
              market        = EXCLUDED.market,
              -- 2026-09-19: security_type을 여기 추가 — 예전엔 이게 빠져 있어서,
              -- 이미 DB에 다른 분류(PREF 등)로 존재하던 종목을 이 기능으로
              -- "추가"해도 그 분류가 그대로 남아 daily_collect.yml 등 STOCK만
              -- 도는 일일 파이프라인/화면에 영원히 안 잡혔다(005935 삼성전자우
              -- 실사례로 확인 — 최초 대량이전 때 PREF로 정확히 분류돼 있었는데,
              -- 이 기능으로 명시적으로 "추가"했는데도 PREF로 남아있었음). 사용자가
              -- 이 기능으로 종목을 명시적으로 추가한다는 건 "앞으로 추적 대상에
              -- 넣겠다"는 의도이므로, STOCK으로 강제 승격시킨다.
              security_type = 'STOCK',
              sector_krx    = COALESCE(EXCLUDED.sector_krx, stocks.sector_krx),
              is_active     = true,
              last_seen     = CURRENT_DATE,
              updated_at    = now()
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
            d = kis.find_date(r)
            if d:
                raw[d] = r
        prog_rows = fetch_program_daily(token, CODE, anchor)
        for r in prog_rows:
            d = kis.find_date(r)
            if d:
                raw_prog[d] = r
        print(f"   [{i+1}/{len(ANCHORS)}] 기준일 {anchor} → 시세 {len(raw)}일 / 프로그램 {len(raw_prog)}일")

    if not raw:
        # 2026-09-19: 이전엔 여기서 그냥 return해서 프로세스가 exit code 0으로
        # 끝났다 — stocks 테이블엔 STEP 1에서 이미 종목이 등록돼 있으니 GitHub
        # Actions는 "성공"으로 표시하고 실패 알림(텔레그램)도 안 갔다. 실제로는
        # daily_price가 하나도 안 쌓여서 v_screener 등 화면에 쓰는 뷰(daily_price
        # INNER JOIN)에 전혀 안 잡히니, 사용자 입장에선 "종목이 추가가 안 된다"
        # 였는데 원인을 알 방법이 없었다(2026-09-19 실사용 사례로 확인 — 005935
        # 삼성전자우). sys.exit(1)로 바꿔 GitHub Actions가 진짜 실패로 표시하고
        # Notify on failure(텔레그램) 단계가 뜨도록 하고, 마지막 KIS 응답 진단
        # 메시지(_last_fetch_diag)도 같이 남겨 왜 비었는지 로그에서 바로 보이게 함.
        print(f"   ⚠ 수집된 데이터 없음 — 종목코드를 확인하세요")
        print(f"   진단: {_last_fetch_diag or '(fetch_daily가 한 번도 실패 진단을 안 남김 — ANCHORS가 비어있었을 가능성)'}")
        sys.exit(f"❌ {CODE} {NAME}: 과거 데이터 수집 실패 — stocks 테이블엔 등록됐지만 daily_price가 비어 있어 화면에 표시되지 않습니다. 위 진단 메시지를 확인하세요.")

    # ── STEP 4: 파싱 ──────────────────────────────────────────────────────────
    price_rows, flow_rows, program_rows = [], [], []
    prev_close = None
    for d in sorted(raw):
        r = raw[d]
        prow, prev_close = kis.parse_price(r, d, CODE, listed_sh, prev_close)
        if d < START_DATE or d > END_DATE:
            continue
        if prow:
            price_rows.append(prow)
            flow_rows.append(parse_flow(r, d, CODE))
            pr = raw_prog.get(d)
            if pr:
                program_rows.append(kis.parse_program(pr, d, CODE))

    print(f"\n⑤ 파싱 결과: price {len(price_rows)}행 / flow {len(flow_rows)}행 / program {len(program_rows)}행")

    # ── STEP 5: DB 저장 ────────────────────────────────────────────────────────
    print("⑥ DB 저장 중...")
    kis.upsert(DB_URL, price_rows, flow_rows, program_rows, batch=BATCH)

    elapsed = time.time() - t0
    print(f"\n✅ 완료 ({elapsed:.0f}초)")
    print(f"   daily_price  : {len(price_rows):,}행")
    print(f"   daily_flow   : {len(flow_rows):,}행")
    print(f"   daily_program: {len(program_rows):,}행")
    print(f"\n다음 단계: python 05_compute.py {END_DATE}")
    print(f"  → daily_metrics·signals 재계산 (오늘 날짜 1일치)")

if __name__ == "__main__":
    main()
