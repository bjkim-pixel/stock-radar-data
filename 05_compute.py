# -*- coding: utf-8 -*-
"""
STOCK RADAR · 파생지표 + 신호 계산 실행기
==========================================
05_metrics.sql → 06_signals.sql → 06_portfolio.py 를 순서대로 실행합니다.
지표·후보 스크리닝은 DB 안에서 끝나고, 포지션 상태가 필요한 매수확정/불타기/
트레일링 손절만 파이썬(06_portfolio.py)이 처리합니다.

사용법
  python 05_compute.py                        # DB에 있는 전체 기간
  python 05_compute.py 20260801 20260818      # 날짜 범위 지정
  python 05_compute.py 20260818               # 하루만 (매일 수집 후 자동 실행용)
  python 05_compute.py --metrics-only         # 지표만
  python 05_compute.py --signals-only         # 후보 스크리닝만 (포지션 단계 제외)
  python 05_compute.py --no-portfolio         # 지표+후보까지만

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time, datetime, re, subprocess
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

METRICS_SQL   = "05_metrics.sql"
SIGNALS_SQL   = "06_signals.sql"
PORTFOLIO_PY  = "06_portfolio.py"

# 250일 신고가 창을 채우려면 범위 밖 과거가 필요합니다.
LOOKBACK_DAYS   = 400
# 신호는 "전일 대비" 비교만 하므로 짧게.
LOOKBACK_SIGNAL = 20

METRICS_ONLY = "--metrics-only" in sys.argv
SIGNALS_ONLY = "--signals-only" in sys.argv
NO_PORTFOLIO = "--no-portfolio" in sys.argv or METRICS_ONLY or SIGNALS_ONLY
args = [a for a in sys.argv[1:] if not a.startswith("--")]


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def db_date_range():
    """DB에 실제로 존재하는 daily_price 기간을 조회"""
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        cur.execute("SELECT min(trade_date), max(trade_date) FROM daily_price")
        lo, hi = cur.fetchone()
        if lo is None:
            sys.exit("❌ daily_price가 비어 있습니다. 먼저 수집/백필을 실행하세요.")
        return lo, hi


# ── 날짜 결정 ─────────────────────────────────────────────────────────────────
if len(args) >= 2:
    START = datetime.date.fromisoformat(iso(args[0]))
    END   = datetime.date.fromisoformat(iso(args[1]))
elif len(args) == 1:
    START = END = datetime.date.fromisoformat(iso(args[0]))
else:
    START, END = db_date_range()

# Supabase 무료 플랜 500MB 용량 한도(2026-08 확인) 때문에 daily_metrics/signals는
# 2026년치만 보관하기로 함. daily_price/daily_flow(원본)는 400일 lookback을 위해
# 계속 더 과거까지 쌓이지만, 파생 결과는 여기서 하한선을 걸어 절대 그 이전 날짜에
# 쓰지 않습니다 — 언제든 05_compute.py로 재계산 가능하니 데이터 유실은 아닙니다.
METRICS_RETENTION_START = datetime.date(2026, 1, 1)
if START < METRICS_RETENTION_START:
    print(f"   ⚠ start_date {START}가 보관 하한({METRICS_RETENTION_START})보다 이전이라 "
          f"{METRICS_RETENTION_START}로 올립니다 (lookback 계산엔 원래 start_date 영향 없음).")
    START = max(START, METRICS_RETENTION_START)

PARAMS = {
    "start_date": START.isoformat(),
    "end_date":   END.isoformat(),
    "lookback":   (START - datetime.timedelta(LOOKBACK_DAYS)).isoformat(),
    "lookback_s": (START - datetime.timedelta(LOOKBACK_SIGNAL)).isoformat(),
}

print(f"▶ 계산 범위: {PARAMS['start_date']} ~ {PARAMS['end_date']}")
print(f"   (지표 조회 시작 {PARAMS['lookback']} · 신호 조회 시작 {PARAMS['lookback_s']})")


# ── % 이스케이프 ──────────────────────────────────────────────────────────────
# psycopg2는 SQL 안의 %를 파라미터 기호로 해석합니다. 그래서 '거래대금 150%'
# 같은 평범한 문자열이나 주석 한 글자 때문에 쿼리 전체가 깨집니다.
# SQL 파일에는 %를 그냥 쓰고, 실행 직전에 여기서 %(이름)s만 남기고 escape 합니다.
_PARAM_RE = re.compile(r"%\(\w+\)s")


def escape_percent(sql):
    out, last = [], 0
    for m in _PARAM_RE.finditer(sql):
        out.append(sql[last:m.start()].replace("%", "%%"))
        out.append(m.group(0))
        last = m.end()
    out.append(sql[last:].replace("%", "%%"))
    return "".join(out)


# ── SQL 파일 → STEP 단위로 분리 ───────────────────────────────────────────────
def load_steps(path):
    """'-- @@STEP: 제목' 주석을 기준으로 SQL을 단계별로 쪼갭니다."""
    if not os.path.exists(path):
        sys.exit(f"❌ {path} 파일을 찾을 수 없습니다.")
    with open(path, encoding="utf-8") as f:
        text = f.read()

    steps, title, buf = [], None, []
    for line in text.splitlines():
        if line.strip().startswith("-- @@STEP:"):
            if title and "".join(buf).strip():
                steps.append((title, "\n".join(buf)))
            title = line.split("-- @@STEP:", 1)[1].strip()
            buf = []
        else:
            buf.append(line)
    if title and "".join(buf).strip():
        steps.append((title, "\n".join(buf)))
    return [(t, escape_percent(s)) for t, s in steps]


def log_result(cur, job, status, row_count, duration_ms, message=""):
    cur.execute("""
        INSERT INTO ingest_log (job, trade_date, status, row_count, duration_ms, message)
        VALUES (%s, %s, %s, %s, %s, %s)
    """, (job, PARAMS["end_date"], status, row_count, duration_ms, message))


def run_file(path, job_name):
    steps = load_steps(path)
    print(f"\n━━ {path} ({len(steps)}단계) ━━")
    t_file = time.time()
    total_rows = 0

    with psycopg2.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            # daily_metrics는 250일/90일 윈도우 함수를 전 종목에 돌리는 무거운 쿼리라,
            # 조회 범위가 넓어지면 Supabase 풀러 기본 statement_timeout(약 100~120초)에
            # 걸릴 수 있습니다. 이 세션에서만 넉넉하게 늘려둡니다.
            cur.execute("SET statement_timeout = '10min'")
        conn.commit()

        for i, (title, sql) in enumerate(steps, 1):
            t0 = time.time()
            with conn.cursor() as cur:
                cur.execute(sql, PARAMS)
                rows = cur.rowcount
            conn.commit()
            total_rows += max(rows, 0)
            print(f"  [{i}/{len(steps)}] {title}  →  {rows:,}행  ({time.time()-t0:.1f}초)")

        dur = int((time.time() - t_file) * 1000)
        with conn.cursor() as cur:
            log_result(cur, job_name, "SUCCESS", total_rows, dur,
                       f"{PARAMS['start_date']}~{PARAMS['end_date']}")
        conn.commit()

    print(f"  ✅ {job_name} 완료: {total_rows:,}행 ({dur//1000}초)")
    return total_rows


def summary():
    """계산 결과 요약 — 값이 제대로 들어갔는지 눈으로 확인"""
    with psycopg2.connect(DB_URL) as c, c.cursor() as cur:
        print("\n" + "=" * 64)
        print("계산 결과 요약")
        print("=" * 64)

        cur.execute("""
            SELECT count(*),
                   count(*) FILTER (WHERE ma20 IS NOT NULL),
                   count(*) FILTER (WHERE is_new_high_all),
                   count(*) FILTER (WHERE vol_ratio20_prev >= 200),
                   count(*) FILTER (WHERE market_cap_ok),
                   count(*) FILTER (WHERE nonpersonal_net > 0)
            FROM (
              SELECT m.*, (p.market_cap >= 2000000000000) AS market_cap_ok
              FROM daily_metrics m
              JOIN daily_price p ON p.trade_date = m.trade_date AND p.code = m.code
              WHERE m.trade_date BETWEEN %(start_date)s AND %(end_date)s
            ) t
        """, PARAMS)
        r = cur.fetchone()
        print(f"\n[daily_metrics] v4 조건별 통과 종목-일 수")
        print(f"  총 행수             : {r[0]:,}")
        print(f"  MA20 산출됨         : {r[1]:,}")
        print(f"  ② 누적 신고가       : {r[2]:,}")
        print(f"  ③ 거래량 200% 이상  : {r[3]:,}")
        print(f"  ④ 시총 2조 이상     : {r[4]:,}")
        print(f"  ⑤ 비개인 순매수 (+) : {r[5]:,}")

        cur.execute("""
            SELECT count(DISTINCT trade_date), count(*) FILTER (WHERE rs_rank <= 5)
            FROM sector_daily
            WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
        """, PARAMS)
        r = cur.fetchone()
        print(f"\n[sector_daily] ① 업종 RS")
        print(f"  거래일 수           : {r[0]:,}일")
        print(f"  RS 5위 이내 업종-일 : {r[1]:,}")

        cur.execute("""
            SELECT regime, count(*) FROM market_daily
            WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
            GROUP BY regime ORDER BY 2 DESC
        """, PARAMS)
        rows = cur.fetchall()
        if rows:
            print(f"\n[market_daily] 레짐 분포 (v4 규칙에는 미사용 — 참고용)")
            for reg, n in rows:
                print(f"  {reg:<10}: {n:,}일")

        cur.execute("""
            SELECT signal_type, grade, count(*) FROM signals
            WHERE trade_date BETWEEN %(start_date)s AND %(end_date)s
            GROUP BY signal_type, grade ORDER BY 1, 2
        """, PARAMS)
        rows = cur.fetchall()
        print(f"\n[signals] 유형별 건수")
        if not rows:
            print("  (생성된 신호 없음 — 조건이 빡빡하거나 데이터가 부족합니다)")
        for st, g, n in rows:
            print(f"  {st:<16} {g:<12}: {n:,}건")

        cur.execute("""
            SELECT sg.trade_date, sg.code, s.name, sg.signal_type,
                   sg.score, sg.reason_text
            FROM signals sg JOIN stocks s ON s.code = sg.code
            WHERE sg.trade_date BETWEEN %(start_date)s AND %(end_date)s
              AND sg.signal_type LIKE 'V4[_]%%'
            ORDER BY sg.trade_date DESC, sg.signal_type, sg.score DESC
            LIMIT 15
        """, PARAMS)
        rows = cur.fetchall()
        if rows:
            print(f"\n[최근 v4 신호 15건]")
            for d, code, name, st, sc, txt in rows:
                print(f"  {d} {code} {name[:10]:<10} {st:<14} {sc:>6} · {txt}")


def run_portfolio():
    """포지션 엔진은 상태 기반이라 SQL이 아닌 별도 파이썬 프로세스로 실행합니다."""
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, PORTFOLIO_PY)
    if not os.path.exists(script):
        print(f"\n⚠ {PORTFOLIO_PY}를 찾을 수 없어 포지션 단계를 건너뜁니다.")
        return
    print(f"\n━━ {PORTFOLIO_PY} ━━")
    cmd = [sys.executable, script,
           PARAMS["start_date"].replace("-", ""),
           PARAMS["end_date"].replace("-", "")]
    r = subprocess.run(cmd, cwd=here)
    if r.returncode != 0:
        sys.exit(f"❌ {PORTFOLIO_PY} 실패 (exit {r.returncode})")


def main():
    t0 = time.time()
    if not SIGNALS_ONLY:
        run_file(METRICS_SQL, "metrics")
    if not METRICS_ONLY:
        run_file(SIGNALS_SQL, "signals")
    if not NO_PORTFOLIO:
        run_portfolio()
    summary()
    print(f"\n✅ 전체 완료 ({int(time.time()-t0)}초)")


if __name__ == "__main__":
    main()
