# -*- coding: utf-8 -*-
"""종목 1개 삭제: stocks + code 컬럼이 있는 모든 테이블에서 해당 종목 행 제거(한 트랜잭션).
사용법: python delete_stock.py <code> <종목명>   (stocks의 이름과 일치할 때만 삭제)  환경변수: SUPABASE_DB_URL"""
import os,sys,psycopg2
code,name=sys.argv[1].strip(),sys.argv[2].strip()
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur=conn.cursor()
cur.execute("select code,name,market,security_type,is_active from stocks where code=%s",(code,))
r=cur.fetchone(); rep=[f"# 종목 삭제 결과 {code} {name}"]
if not r: rep.append("- stocks에 없음 → 변경 없음")
elif r[1]!=name: rep.append(f"- 이름 불일치(DB: {r[1]}) → 삭제 안 함")
else:
    rep.append(f"- 대상: {r}")
    cur.execute("""select c.table_name from information_schema.columns c join information_schema.tables t
      on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
      where c.table_schema='public' and c.column_name='code' and c.table_name<>'stocks' order by 1""")
    for (t,) in cur.fetchall():
        cur.execute(f'delete from public."{t}" where code=%s',(code,))
        if cur.rowcount: rep.append(f"- {t}: {cur.rowcount}행 삭제")
    cur.execute("delete from stocks where code=%s",(code,)); rep.append(f"- stocks: {cur.rowcount}행 삭제")
    conn.commit()
    cur.execute("select count(*) from stocks where code=%s",(code,)); rep.append(f"- 확인: 남은 stocks 행 {cur.fetchone()[0]}")
open("delete_stock_report.md","w",encoding="utf-8").write("\n".join(rep)+"\n"); print("\n".join(rep))
