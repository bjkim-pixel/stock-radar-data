import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True
cur = c.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "119_collected_at_default.sql"), encoding="utf-8").read())
cur.execute("select trade_date, count(*), count(collected_at), max(collected_at) from daily_price where trade_date=(select max(trade_date) from daily_price) group by 1")
r = "수정 후: %s" % (cur.fetchall(),)
cur.execute("select * from v_data_status"); r += "\nv_data_status: %s" % (cur.fetchall(),)
print(r); open("asof_report.md", "w").write(r)
