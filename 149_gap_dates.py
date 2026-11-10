# -*- coding: utf-8 -*-
"""가격·수급 결측일 점검(읽기 전용)"""
import os,psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True,autocommit=True); cur=c.cursor()
cur.execute("""select p.trade_date, count(*) n, count(*) filter (where p.open<=0 or p.high<=0 or p.low<=0) bad, count(*) filter (where f.code is null) noflow,
  count(*) filter (where f.code is not null and f.foreign_net is null) nullflow
  from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' left join daily_flow f on f.code=p.code and f.trade_date=p.trade_date
  where p.trade_date>='2026-08-01' group by 1 having count(*) filter (where p.open<=0 or p.high<=0 or p.low<=0)>0 or count(*) filter (where f.code is null)>3 order by 1""")
print("# 결측일\n| 날짜 | 종목 | 시고저 0 | 수급 없음 | 수급 null |\n|---|---|---|---|---|")
for r in cur: print("| "+" | ".join(str(x) for x in r)+" |")
cur.execute("select trade_date,count(*) from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' where trade_date>='2026-10-01' group by 1 order by 1")
print("\n10월 이후 일별 가격 행수: "+", ".join(f"{d:%m-%d} {n}" for d,n in cur))
