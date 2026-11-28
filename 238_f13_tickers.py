# -*- coding: utf-8 -*-
"""OpenFIGI가 못 찾은 13F 종목(트랜스오션·토름·앵글로골드)의 티커를 직접 지정하고 f13_holding 에 반영."""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); c.connection.autocommit = True
M = [("TRANSOCEAN%", "RIG"), ("TORM PLC%", "TRMD"), ("ANGLOGOLD ASHANTI%", "AU")]
out = []
for pat, tk in M:
    c.execute("select distinct cusip, name from f13_holding where upper(name) like %s", (pat,))
    for cu, nm in c.fetchall():
        c.execute("insert into f13_cusip(cusip,ticker,name,sec_type,src) values(%s,%s,%s,'Common Stock','manual') on conflict(cusip) do update set ticker=excluded.ticker,src='manual',tried_at=now()", (cu, tk))
        c.execute("update f13_holding set ticker=%s where cusip=%s", (tk, cu)); out.append(f"{nm} {cu} → {tk} ({c.rowcount}행)")
c.execute("select code from us_master where code in ('RIG','TRMD','AU')"); out.append("us_master 보유: " + str([r[0] for r in c.fetchall()]))
open("f13_tickers.md", "w", encoding="utf-8").write("\n".join(out)); print("\n".join(out))
