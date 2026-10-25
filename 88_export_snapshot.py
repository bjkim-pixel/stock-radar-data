"""화면 첫 로딩용 정적 스냅샷 생성 — Supabase 뷰 몇 개를 하루 한두 번 JSON 한 파일로 내려 data-snapshot 브랜치에 올립니다.
브라우저는 이 파일(GitHub raw, CDN 캐시)을 먼저 읽고, 없거나 날짜가 안 맞으면 예전처럼 Supabase를 직접 조회합니다.
사용: SUPABASE_DB_URL=... python 88_export_snapshot.py [--out snapshot.json] [--report snapshot_report.md]"""
import os, sys, json, datetime, decimal, psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
OUT = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "snapshot.json"
REPORT = sys.argv[sys.argv.index("--report") + 1] if "--report" in sys.argv else None
lines = []
def log(m=""):
    print(m, flush=True); lines.append(m)

def conv(v):
    if isinstance(v, decimal.Decimal):
        f = float(v)
        return int(f) if f.is_integer() and abs(f) < 9e15 else f
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    return v

def dump(cur, sql, args=None):
    cur.execute(sql, args or ())
    cols = [d[0] for d in cur.description]
    return {"cols": cols, "rows": [[conv(x) for x in r] for r in cur.fetchall()]}

def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    conn = psycopg2.connect(DB_URL)
    snap = {"generated_at": datetime.datetime.utcnow().isoformat() + "Z", "tables": {}}
    T = snap["tables"]
    with conn.cursor() as cur:
        cur.execute("set statement_timeout = 0")
        cur.execute("select max(trade_date) from v_screener")
        d = cur.fetchone()[0]
        snap["date"] = d.isoformat()
        T["v_screener"] = dump(cur, "select * from v_screener where trade_date = %s", (d,))
        T["v_flow_rank_today"] = dump(cur, "select * from v_flow_rank_today where trade_date = %s", (d,))
        T["v_stock_flow_periods"] = dump(cur, "select * from v_stock_flow_periods")
        T["v_market_overview"] = dump(cur, "select * from v_market_overview order by trade_date")
        T["v_market_amount_real"] = dump(cur, "select * from v_market_amount_real order by trade_date")
        T["v_sector_rank"] = dump(cur, "select * from v_sector_rank")
        T["market_daily"] = dump(cur, "select trade_date, market, index_close, index_ma20, index_amount, regime from market_daily where market in ('KOSPI','KOSDAQ') order by trade_date")
        T["flow_cap_ratio"] = dump(cur, "select * from flow_cap_ratio")
        T["stocks"] = dump(cur, "select code, name, market, security_type from stocks where security_type = 'STOCK' order by name")
        T["sector_flow_daily"] = dump(cur, "select * from sector_flow_daily order by trade_date, market, sector")
    conn.close()
    txt = json.dumps(snap, ensure_ascii=False, separators=(",", ":"))
    open(OUT, "w", encoding="utf-8").write(txt)
    import gzip
    gz = len(gzip.compress(txt.encode("utf-8"), 6))
    log(f"# snapshot 생성 ({snap['generated_at']})\n- 기준일 {snap['date']} · 원본 {len(txt)/1024:,.0f}KB · gzip {gz/1024:,.0f}KB\n")
    log("| 테이블 | 행 | 열 |\n|---|---|---|")
    for k, v in T.items():
        log(f"| {k} | {len(v['rows']):,} | {len(v['cols'])} |")
    if REPORT:
        open(REPORT, "w", encoding="utf-8").write("\n".join(lines))

if __name__ == "__main__":
    main()
