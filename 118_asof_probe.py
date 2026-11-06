import os, psycopg2, psycopg2.extras
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True
cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
out = []
def run(label, sql):
    try:
        cur.execute(sql); r = cur.fetchall(); out.append(f"- {label}: {[dict(x) for x in r][:3]}")
    except Exception as e:
        out.append(f"- {label}: ERR {str(e)[:200]}")
run("view def", "select pg_get_viewdef('v_data_status'::regclass) as d")
run("service select", "select * from v_data_status")
run("anon priv", "select has_table_privilege('anon','v_data_status','select') as p")
run("price collected_at", "select trade_date, count(*) n, count(collected_at) c, max(collected_at) m, bool_or(is_partial) p from daily_price where trade_date=(select max(trade_date) from daily_price) group by 1")
cur.execute("set role anon")
run("anon select", "select * from v_data_status")
open("asof_report.md", "w").write("\n".join(out)); print("\n".join(out))
