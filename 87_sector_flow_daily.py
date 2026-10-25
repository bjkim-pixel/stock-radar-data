"""sector_flow_daily 사전 집계 — 87_sector_flow_daily.sql 의 refresh_sector_flow_daily() 호출.
최초(테이블 비어 있음)엔 2026-06-01부터 2주 단위로 전부, 이후엔 최근 20일만 재계산.
사용: SUPABASE_DB_URL=... python 87_sector_flow_daily.py [--report sectorflow_report.md] [--full]"""
import os, sys, datetime, psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
START = datetime.date(2026, 6, 1)
REPORT = None
if "--report" in sys.argv:
    i = sys.argv.index("--report")
    REPORT = sys.argv[i + 1] if i + 1 < len(sys.argv) else "sectorflow_report.md"
lines = []
def log(m=""):
    print(m, flush=True); lines.append(m)

def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    here = os.path.dirname(os.path.abspath(__file__))
    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute("set statement_timeout = 0")
        cur.execute(open(os.path.join(here, "87_sector_flow_daily.sql"), encoding="utf-8").read())
        conn.commit()
        cur.execute("select max(trade_date) from sector_flow_daily")
        last = cur.fetchone()[0]
        cur.execute("select max(trade_date) from daily_price")
        end = cur.fetchone()[0]
        frm = START if (last is None or "--full" in sys.argv) else max(START, last - datetime.timedelta(days=20))
        log(f"# sector_flow_daily 갱신 ({datetime.datetime.now():%Y-%m-%d %H:%M} UTC)")
        log(f"- 계산 구간 {frm} ~ {end} (기존 마지막 {last})")
        total, d = 0, frm
        while d <= end:
            e = min(d + datetime.timedelta(days=13), end)
            cur.execute("select refresh_sector_flow_daily(%s, %s)", (d, e))
            n = cur.fetchone()[0]; conn.commit(); total += n
            log(f"  - {d} ~ {e}: {n}행")
            d = e + datetime.timedelta(days=1)
        cur.execute("select count(*), count(distinct trade_date), min(trade_date), max(trade_date), pg_size_pretty(pg_total_relation_size('sector_flow_daily')) from sector_flow_daily")
        c, nd, mn, mx, sz = cur.fetchone()
        log(f"- 전체 {c:,}행 · 거래일 {nd}일 · {mn} ~ {mx} · 테이블 크기 {sz}")
        cur.execute("""select to_char(trade_date,'YYYY-MM') m, count(distinct trade_date), count(*), sum(foreign_net)/1e8 from sector_flow_daily group by 1 order by 1""")
        log("\n| 월 | 거래일 | 행 | 외국인 합계(억) |\n|---|---|---|---|")
        for m, dd, cc, fn in cur.fetchall():
            log(f"| {m} | {dd} | {cc} | {0 if fn is None else float(fn):,.0f} |")
        cur.execute("select count(*) from daily_flow where trade_date >= %s", (START,))
        log(f"\n- daily_flow {START} 이후 행 {cur.fetchone()[0]:,}")
    conn.close()
    if REPORT:
        open(REPORT, "w", encoding="utf-8").write("\n".join(lines))

if __name__ == "__main__":
    main()
