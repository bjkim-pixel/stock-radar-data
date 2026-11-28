import os, psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); o=["# 업종 반영 점검\n"]
c.execute("select max(trade_date) from sector_daily"); d=c.fetchone()[0]; o.append(f"sector_daily 최신일: {d}")
c.execute("select sector,market,n_stocks from sector_daily where trade_date=%s order by sector",(d,)) if False else None
c.execute("select column_name from information_schema.columns where table_name='sector_daily'"); cols=[r[0] for r in c.fetchall()]; o.append("컬럼: "+", ".join(cols))
c.execute("select sector,market,count(*) from sector_daily where trade_date=%s group by 1,2 order by 1,2",(d,)); o.append("\n## 최신일 업종(시장별 행)\n"+", ".join(f"{a}/{b}" for a,b,_ in c.fetchall()))
for s in ("K-컬처","화장품","엔터·미디어","종합상사"):
    c.execute("select min(trade_date),max(trade_date),count(distinct trade_date) from sector_daily where sector=%s",(s,)); o.append(f"- {s}: {c.fetchone()}")
c.execute("select sub,count(*) from v_global_ret group by 1 order by 2 desc"); o.append("\n## v_global_ret sub 분포\n"+", ".join(f"{a}({b})" for a,b in c.fetchall()))
c.execute("select mkt,kind,count(*) filter (where sub is null) from v_global_ret where kind='STOCK' group by 1,2"); o.append("\n## 일반종목 sub 비어있음: "+str(c.fetchall()))
open("sector_verify.md","w").write("\n".join(o))
