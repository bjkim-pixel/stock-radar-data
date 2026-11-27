# -*- coding: utf-8 -*-
import os, psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
o=["# 우리 업종 기준 목록 (v_stock_sector)\n"]
c.execute("select v.sector,count(*) from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK' group by 1 order by 2 desc")
r=c.fetchall(); o.append(f"업종 {len(r)}개\n\n"+"\n".join(f"- {a}: {b}" for a,b in r))
c.execute("select count(*) from stocks where security_type='STOCK'"); o.append(f"\n국내 일반종목 {c.fetchone()[0]}")
c.execute("select count(*) from stocks s left join v_stock_sector v on v.code=s.code where s.security_type='STOCK' and v.sector is null"); o.append(f"미분류 {c.fetchone()[0]}")
open("sector_base.md","w").write("\n".join(o))
