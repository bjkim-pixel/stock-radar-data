# -*- coding: utf-8 -*-
import os, re, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# STOCK 중 우선주 이름 종목\n"]
c.execute("select code,name,first_seen,updated_at::date,last_seen from stocks where security_type='STOCK' order by name")
P = re.compile(r"[0-9]?우[A-C]?(\(전환\))?$|\s우[A-C]?$")
r = [x for x in c.fetchall() if P.search(x[1])]
O.append(f"- 우선주 이름인 STOCK {len(r)}개")
for x in r: O.append(f"- {x}")
c.execute("select count(*) from stocks where security_type='PREF'"); O.append(f"- PREF {c.fetchone()[0]}개")
open("pref_diag.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
