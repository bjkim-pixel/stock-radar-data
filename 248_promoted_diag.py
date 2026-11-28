# -*- coding: utf-8 -*-
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# 일반종목으로 바뀐 의심 종목\n"]
c.execute("""select s.code,s.name,s.market,s.security_type,s.first_seen,s.updated_at::date,(select count(*) from daily_price p where p.code=s.code) n
  from stocks s where s.security_type='STOCK' and (select count(*) from daily_price p where p.code=s.code) < 100 order by n,s.code""")
r = c.fetchall(); O.append(f"- 시세 100일 미만인 STOCK {len(r)}개")
for x in r: O.append(f"- {x}")
c.execute("select security_type,count(*) from stocks group by 1 order by 2 desc"); O.append(f"- 분류별 {c.fetchall()}")
open("promoted_diag.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
