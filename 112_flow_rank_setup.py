import os, time, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True
cur = conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "112_flow_rank_fn.sql"), encoding="utf-8").read())
cur.execute("select max(trade_date) from daily_flow"); d = cur.fetchone()[0]
t = time.time(); cur.execute("select * from flow_rank_on(%s) order by code", (d,)); a = cur.fetchall(); print("fn rows", len(a), "%.2fs" % (time.time() - t))
t = time.time(); cur.execute("select * from v_flow_rank_today where trade_date=%s order by code", (d,)); b = cur.fetchall(); print("view rows", len(b), "%.2fs" % (time.time() - t))
print("IDENTICAL:", a == b)
if a != b:
    diff = [(x, y) for x, y in zip(a, b) if x != y]; print("diff n", len(diff)); print(diff[:2])
