# -*- coding: utf-8 -*-
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor(); L = []
cur.execute("select kind,count(*),min(rcept_dt),max(rcept_dt),count(distinct code) from dart_filings group by 1 order by 1"); L.append("## dart_filings kind별(건수,최초,최근,종목수)"); L += ["  "+str(r) for r in cur.fetchall()]
cur.execute("select min(rcept_dt),count(*) from dart_filings"); L.append("전체 "+str(cur.fetchone()))
cur.execute("select count(*),min(period),count(distinct code) from stock_earnings where freq='Q'"); L.append("분기 실적 "+str(cur.fetchone()))
cur.execute("select period,count(*),count(op_profit) from stock_earnings where freq='Q' group by 1 order by 1"); L += ["  "+str(r) for r in cur.fetchall()]
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L)); print("\n".join(L))
