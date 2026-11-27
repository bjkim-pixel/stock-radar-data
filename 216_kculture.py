import os, psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
c.execute("select s.code,s.name,s.market from stocks s join v_stock_sector v on v.code=s.code where v.sector='K-컬처' order by s.name")
r=c.fetchall(); open("kculture.md","w").write(f"# K-컬처 {len(r)}종목\n"+"\n".join(f"- {a} {b} ({m})" for a,b,m in r))
