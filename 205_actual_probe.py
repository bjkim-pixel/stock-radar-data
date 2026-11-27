# -*- coding: utf-8 -*-
"""3종목 실적 행 확인(읽기 전용)."""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor(); L = []
for code in ("005930", "000660", "009150"):
    L.append(f"## {code}")
    cur.execute("select freq,period,is_est,src,sales,op_profit,net_income,eps,bps,roe,dps,updated_at::date from stock_earnings where code=%s and period>='202603' order by freq,period", (code,))
    L += ["  " + str(r) for r in cur.fetchall()]
cur.execute("select freq,period,is_est,count(*),count(bps) from stock_earnings where period>='202606' group by 1,2,3 order by 1,2,3"); L.append("## 전체 분포(freq,period,is_est,행,BPS있음)"); L += ["  " + str(r) for r in cur.fetchall()]
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L)); print("\n".join(L))
