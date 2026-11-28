# -*- coding: utf-8 -*-
"""고배당 후보 등록 중 일반종목(STOCK)으로 바뀐 6개를 원래 분류(PREF)로 되돌리고, 그 사이 받은 시세·수급 행을 삭제."""
import os, psycopg2
CODES = ["078935", "097955", "120115", "145995", "210540", "094820"]
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor(); O = ["# 분류 되돌리기\n"]
for t in ("daily_price", "daily_flow", "daily_program", "kiwoom_accounts"):
    cur.execute(f"delete from {t} where code = any(%s)", (CODES,)); O.append(f"- {t}: {cur.rowcount}행 삭제")
cur.execute("update stocks set security_type='PREF', updated_at=now() where code = any(%s) and security_type='STOCK'", (CODES,)); O.append(f"- PREF로 되돌림 {cur.rowcount}개")
conn.commit()
cur.execute("select security_type,count(*) from stocks group by 1 order by 2 desc"); O.append(f"- 분류별 {cur.fetchall()}")
open("revert_pref.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
