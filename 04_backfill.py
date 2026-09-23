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
2026-09-23: KIS 호출/파싱/SQL 로직을 kis_flow_common.py로 옮겼습니다.
add_single_stock.py도 같은 모듈을 씁니다 — 04_backfill.py 2026-08-19/08-26
검증 내용(필드명·엔드포인트)이 두 스크립트에 각각 따로 있다가 한쪽만 고쳐서
버그가 나는 사고가 반복돼(2026-09-21, 09-23) 통합했습니다. 검증 근거는
kis_flow_common.py 상단 docstring 참고.
────────────────────────────────────────────────────────────────────────────
"""
import os, sys, time, json, threading
import psycopg2
from concurrent.futures import ThreadPoolExecutor, as_completed

import kis_flow_common as kis

DB_URL = os.environ.get("SUPABASE_DB_URL", "")

WORKERS = 10
MAX_RPS = 12   # 2026-09-15: 18 → 12 (03_daily_collect.py 주석의 앱키 단위 한도 참고)
BATCH   = 500

_rate   = kis.RateLimiter(MAX_RPS)
_lock   = threading.Lock()
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
    import datetime
    START_DATE, END_DATE = args[0], (datetime.date.today() - datetime.timedelta(1)).strftime("%Y%m%d")
else:
    import datetime
    START_DATE = "20260102"
    END_DATE   = (datetime.date.today() - datetime.timedelta(1)).strftime("%Y%m%d")

ANCHORS = kis.anchors(START_DATE, END_DATE)

print(f"▶ 백필 범위: {kis.iso(START_DATE)} ~ {kis.iso(END_DATE)}  (워커 {WORKERS} · 최대 {MAX_RPS}건/초)")
print(f"   기준일 {len(ANCHORS)}개 × 종목당 1회 호출 (1회에 30거래일 반환)")

if not COMPARE_ONLY and (not kis.KIS_KEY or not kis.KIS_SECRET):
    sys.exit("❌ KIS_APP_KEY / KIS_APP_SECRET 설정 필요")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 설정 필요")


def get_token():
    print("  토큰 확보 중...")
    return kis.get_token(warn=print)


# ── fetch_daily/fetch_program_daily 얇은 래퍼 — 실패 진단 로그 + 첫 응답 덤프만
#    이 스크립트 고유 관심사(멀티스레드 진행상황 표시)라 여기 남겨둠. 실제 HTTP
#    호출/파싱/필드명은 kis_flow_common.py 것을 그대로 씀. ────────────────────
def fetch_daily(token, code, anchor, retries=2):
    diag = {}
    rows = kis.fetch_daily(token, code, anchor, _rate, retries=retries, diag=diag)
    if not rows and diag.get("msg"):
        warn_once("http", f"{diag['msg']} (예: {code})")
    with _lock:
        if rows and not _dumped["flow"]:
            _dumped["flow"] = True
            print(f"\n   ── 첫 응답 필드 확인 ({code}, 기준일 {anchor}) ──")
            print("   " + json.dumps(rows[0], ensure_ascii=False)[:500])
            print(f"   → 날짜 {kis.find_date(rows[0])} · {len(rows)}행\n")
    return rows


def fetch_program_daily(token, code, anchor, retries=2):
    rows = kis.fetch_program_daily(token, code, anchor, _rate, retries=retries)
    with _lock:
        if rows and not _dumped["program"]:
            _dumped["program"] = True
            print(f"\n   ── 프로그램매매 첫 응답 필드 확인 ({code}, 기준일 {anchor}) ──")
            print("   " + json.dumps(rows[0], ensure_ascii=False)[:500])
            print(f"   → 날짜 {kis.find_date(rows[0])} · {len(rows)}행\n")
    return rows


def parse_flow(r, date_str, code):
    return kis.parse_flow(r, date_str, code, warn=lambda m: warn_once("sum", m, 3))


def collect_stock(token, code, listed_sh):
    """한 종목의 전 기간을 수집. 반환 (price_rows, flow_rows, program_rows, status)"""
    try:
        raw = {}
        for a in ANCHORS:
            for r in fetch_daily(token, code, a):
                d = kis.find_date(r)
                if d:
                    raw[d] = r          # 겹치는 날짜는 자연스럽게 덮어씀

        raw_prog = {}
        for a in ANCHORS:
            for r in fetch_program_daily(token, code, a):
                d = kis.find_date(r)
                if d:
                    raw_prog[d] = r

        if not raw:
            return [], [], [], "skip"

        price_rows, flow_rows, program_rows = [], [], []
        prev_close = None
        for d in sorted(raw):           # 날짜 오름차순 → 등락률 계산 가능
            r = raw[d]
            prow, prev_close = kis.parse_price(r, d, code, listed_sh, prev_close)
            if d < START_DATE or d > END_DATE:
                continue                # 범위 밖은 계산에만 쓰고 저장 안 함
            if prow:
                price_rows.append(prow)
                flow_rows.append(parse_flow(r, d, code))
                pr = raw_prog.get(d)
                if pr:
                    program_rows.append(kis.parse_program(pr, d, code))

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


def upsert(price_rows, flow_rows, program_rows=None):
    kis.upsert(DB_URL, price_rows, flow_rows, program_rows, batch=BATCH)


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

    print(f"\n날짜 범위: {kis.find_date(rows[-1])} ~ {kis.find_date(rows[0])}")

    prev = None
    parsed_p, parsed_f = [], []
    for d in sorted({kis.find_date(r): r for r in rows if kis.find_date(r)}):
        r = {kis.find_date(x): x for x in rows if kis.find_date(x)}[d]
        p, prev = kis.parse_price(r, d, "005930", 5_919_637_922, prev)
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
        print(f"날짜 범위: {kis.find_date(prows[-1])} ~ {kis.find_date(prows[0])}")
        for d in sorted({kis.find_date(r): r for r in prows if kis.find_date(r)})[-3:]:
            r = {kis.find_date(x): x for x in prows if kis.find_date(x)}[d]
            pg = kis.parse_program(r, d, "005930")
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
        """, (kis.iso(START_DATE), kis.iso(END_DATE)))
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
        """, (kis.iso(START_DATE), kis.iso(END_DATE)))
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
        """, (kis.iso(START_DATE), kis.iso(END_DATE)))
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
        """, (kis.iso(START_DATE), kis.iso(END_DATE)))
        print(f"\n[daily_program] {'source':<8}{'행수':>10}{'순매수≠0':>10}   기간")
        for s_, n, ne, mn, mx in cur.fetchall():
            print(f"                {s_:<8}{n:>10,}{ne:>10,}   {mn} ~ {mx}")

        cur.execute("""
            SELECT trade_date, pgtr_buy_amt, pgtr_sell_amt, pgtr_net_amt
            FROM daily_program WHERE code='005930' AND trade_date BETWEEN %s AND %s
            ORDER BY trade_date DESC LIMIT 5
        """, (kis.iso(START_DATE), kis.iso(END_DATE)))
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
