# -*- coding: utf-8 -*-
"""오늘 고배당 후보 등록 때 일반종목(STOCK)으로 바뀐 우선주(이름이 우선주이고 last_seen=오늘)를 PREF로 되돌림. 삼성전자우·현대차2우B 는 원래 STOCK 이라 제외."""
import os, re, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
P = re.compile(r"[0-9]?우[A-C]?(\(전환\))?$|\s우[A-C]?$")
cur.execute("select code,name from stocks where security_type='STOCK' and last_seen=current_date and updated_at::date=current_date and first_seen is null")
t = [r for r in cur.fetchall() if P.search(r[1]) and r[0] not in ("005935", "005387")]
cur.execute("update stocks set security_type='PREF', updated_at=now() where code = any(%s)", ([r[0] for r in t],))
conn.commit()
cur.execute("select security_type,count(*) from stocks group by 1 order by 2 desc"); res = cur.fetchall()
O = ["# 우선주 분류 되돌리기\n", f"- PREF로 되돌림 {cur.rowcount if False else len(t)}개: {', '.join(r[1] for r in t)}", f"- 분류별 {res}"]
open("revert_pref2.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
