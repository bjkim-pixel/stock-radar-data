"""종목별 외+기 누적 순매수 ÷ 그날 시총(3M/1M/1W) 사전 계산 — 86_flow_cap_ratio.sql 의 refresh_flow_cap_ratio() 호출.
사용: SUPABASE_DB_URL=... python 86_flow_cap_ratio.py [--report flowcap_report.md]"""
import os, sys, datetime, psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
REPORT = None
if "--report" in sys.argv:
    i = sys.argv.index("--report")
    REPORT = sys.argv[i + 1] if i + 1 < len(sys.argv) else "flowcap_report.md"
lines = []
def log(m=""):
    print(m, flush=True); lines.append(m)

def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    here = os.path.dirname(os.path.abspath(__file__))
    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute(open(os.path.join(here, "86_flow_cap_ratio.sql"), encoding="utf-8").read())
        conn.commit()
        cur.execute("select refresh_flow_cap_ratio()")
        n = cur.fetchone()[0]; conn.commit()
        log(f"# flow_cap_ratio 갱신 ({datetime.datetime.now():%Y-%m-%d %H:%M} UTC)")
        log(f"- 계산 종목 {n}개")
        cur.execute("select max(as_of), count(*) filter (where r_3m is null), count(*) filter (where r_1m is null), count(*) filter (where r_1w is null) from flow_cap_ratio")
        a, n3, n1, nw = cur.fetchone()
        log(f"- 기준일 {a} · 값 없음(시총·이력 부족): 3M {n3} / 1M {n1} / 1W {nw}")
        log("\n| code | name | 누적순매수 3M(억) | 3M % | 1M % | 1W % |\n|---|---|---|---|---|---|")
        cur.execute("""select f.code, s.name, f.a_3m/1e8, f.r_3m, f.r_1m, f.r_1w from flow_cap_ratio f join stocks s on s.code=f.code
                       where f.code in ('005930','000660','035420','005380','373220') order by f.code""")
        for c, nm, a3, r3, r1, rw in cur.fetchall():
            log(f"| {c} | {nm} | {a3:,.0f} | {r3} | {r1} | {rw} |")
    conn.close()
    if REPORT:
        open(REPORT, "w", encoding="utf-8").write("\n".join(lines))

if __name__ == "__main__":
    main()
