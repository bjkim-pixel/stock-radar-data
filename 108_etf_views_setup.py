# -*- coding: utf-8 -*-
"""ETF 뷰 생성(108_etf_views.sql) 후 동작 확인 — 여러 번 실행해도 안전."""
import os, sys, time, psycopg2
url = os.environ.get("SUPABASE_DB_URL", "")
if not url:
    sys.exit("SUPABASE_DB_URL 미설정")
here = os.path.dirname(os.path.abspath(__file__))
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor()
cur.execute(open(os.path.join(here, "108_etf_views.sql"), encoding="utf-8").read())
t = time.time()
cur.execute("select max(trade_date) from etf_daily"); d = cur.fetchone()[0]
cur.execute("select count(*), count(ma120), count(rs5_pctl), count(high_period_date) from v_etf_screener where trade_date=%s", (d,))
print("최근일", d, "행/ma120/rs5_pctl/신고가일:", cur.fetchone(), "소요 %.1fs" % (time.time() - t))
t = time.time()
cur.execute("select code,name,sector,close,change_pct,ma20,rs5_vs_mkt,rs5_pctl,pct_from_high,vol_ratio20_prev from v_etf_screener where trade_date=%s order by rs5_vs_mkt desc nulls last limit 5", (d,))
for r in cur.fetchall(): print(r)
cur.execute("select count(*) from v_etf_chart where code=(select code from etf_master limit 1)"); print("chart rows:", cur.fetchone()[0], "%.1fs" % (time.time() - t))
cur.execute("select has_table_privilege('anon','v_etf_screener','select')"); print("anon select:", cur.fetchone()[0])
