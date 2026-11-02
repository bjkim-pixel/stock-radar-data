import os, time, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True
cur = conn.cursor()
cur.execute("select max(trade_date) from daily_flow"); d = cur.fetchone()[0]; print("max flow date", d)
cur.execute("select max(trade_date) from daily_price"); print("max price date", cur.fetchone()[0])
cur.execute("select pg_get_viewdef('v_flow_rank_today'::regclass)"); v = cur.fetchone()[0]; print("viewdef len", len(v)); print(v[:300].replace("\n"," "))
cur.execute("select c.reloptions from pg_class c where relname='v_flow_rank_today'"); print("reloptions", cur.fetchone())
for role in ("postgres", "anon"):
    try:
        cur.execute("set role " + role)
        cur.execute("set statement_timeout = '8s'")
        t = time.time()
        cur.execute("select count(*), count(foreign_rank) from v_flow_rank_today where trade_date=%s", (d,))
        print(role, cur.fetchone(), "%.2fs" % (time.time() - t))
    except Exception as e:
        print(role, "ERR", str(e)[:200])
    finally:
        cur.execute("reset role")
cur.execute("select count(*) from daily_flow where trade_date=%s", (d,)); print("flow rows today", cur.fetchone())
