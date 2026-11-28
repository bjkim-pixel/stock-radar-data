# -*- coding: utf-8 -*-
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# 되돌리기 진단\n"]
c.execute("select code from stocks where first_seen=current_date"); codes = [r[0] for r in c.fetchall()]
O.append(f"- 오늘 등록 종목 {len(codes)}개")
c.execute("""select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
  where c.table_schema='public' and c.column_name='code' and c.table_name ~ '(intraday|trade|trading|position|order|journal|fav|watch|portfolio|holding)' and c.table_name<>'stocks'""")
for (t,) in c.fetchall():
    c.execute(f'select count(distinct code) from public."{t}" where code = any(%s)', (codes,)); O.append(f"- {t}: 오늘 등록 종목 중 {c.fetchone()[0]}개 포함")
c.execute("select count(*),min(first_seen),max(first_seen) from stocks where security_type='STOCK'"); O.append(f"- STOCK {c.fetchone()}")
c.execute("select first_seen,count(*) from stocks where security_type='STOCK' group by 1 order by 1 desc limit 5"); O.append(f"- first_seen 분포 {c.fetchall()}")
open("undo_diag.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
