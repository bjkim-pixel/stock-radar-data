# -*- coding: utf-8 -*-
import os, psycopg2, json
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# 오늘 등록 종목의 intraday_positions\n"]
c.execute("select column_name from information_schema.columns where table_name='intraday_positions' order by ordinal_position"); O.append(f"- 컬럼 {[r[0] for r in c.fetchall()]}")
c.execute("select p.*, s.name from intraday_positions p join stocks s using(code) where s.first_seen=current_date order by p.id")
cols = [d[0] for d in c.description]
for r in c.fetchall(): O.append("- " + json.dumps(dict(zip(cols, map(str, r))), ensure_ascii=False)[:500])
c.execute("select count(*) from intraday_positions"); O.append(f"- intraday_positions 전체 {c.fetchone()[0]}행")
open("pos_diag.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
