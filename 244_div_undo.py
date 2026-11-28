# -*- coding: utf-8 -*-
"""고배당 후보 대량 등록 되돌리기: 오늘 새로 등록된 종목(first_seen=오늘)을 stocks 와 code 컬럼 테이블에서 삭제. 단, 사용자가 요청한 종목(KEEP)은 남김."""
import os, psycopg2
KEEP = {"122900", "123890", "002460", "090350", "060980", "003690"}   # TIGER 코스피고배당 구성종목 5개(요청) + 코리안리
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor(); O = ["# 고배당 대량 등록 되돌리기\n"]
cur.execute("select code,name,security_type from stocks where first_seen=current_date order by code")
rows = [r for r in cur.fetchall() if r[0] not in KEEP]
cur.execute("select code,name from stocks where first_seen=current_date and code = any(%s)", (list(KEEP),)); O.append(f"- 오늘 등록됐지만 유지: {cur.fetchall()}")
O.append(f"- 삭제 대상 {len(rows)}종목 (예: {', '.join(r[1] for r in rows[:12])})")
if not 50 <= len(rows) <= 600: O.append("- 대상 수가 예상 범위(50~600)를 벗어나 중단"); open("div_undo.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O)); raise SystemExit
codes = [r[0] for r in rows]
# 매매·관심·일지 등 사용자 기록이 걸린 테이블에 있는 종목은 삭제하지 않고 남김(외래키 보호)
cur.execute("""select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
  where c.table_schema='public' and c.column_name='code' and c.table_name ~ '(intraday|trade|trading|position|order|journal|fav|watch|portfolio|holding)' and c.table_name<>'stocks'""")
prot = {}
for (t,) in cur.fetchall():
    cur.execute(f'select distinct code from public."{t}" where code = any(%s)', (codes,))
    for (c,) in cur.fetchall(): prot.setdefault(c, []).append(t)
if prot:
    O.append(f"- 매매·관심 기록이 있어 삭제하지 않고 남김: {prot}")
    codes = [c for c in codes if c not in prot]
cur.execute("""select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
  where c.table_schema='public' and c.column_name='code' and c.table_name<>'stocks' order by 1""")
tot = 0
for (t,) in cur.fetchall():
    cur.execute(f'delete from public."{t}" where code = any(%s)', (codes,))
    if cur.rowcount: O.append(f"- {t}: {cur.rowcount}행 삭제"); tot += cur.rowcount
cur.execute("delete from stocks where code = any(%s)", (codes,)); O.append(f"- stocks: {cur.rowcount}행 삭제")
conn.commit()
cur.execute("select count(*) from stocks where security_type='STOCK'"); O.append(f"- 운영 종목(STOCK) 현재 {cur.fetchone()[0]}개")
cur.execute("select count(*) from stocks where first_seen=current_date"); O.append(f"- 오늘 등록 종목 남은 수 {cur.fetchone()[0]}")
conn.autocommit = True
cur.execute("vacuum analyze")
cur.execute("select pg_size_pretty(pg_database_size(current_database()))"); O.append(f"- DB 용량 {cur.fetchone()[0]}")
open("div_undo.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
