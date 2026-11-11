import os, psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
c.execute("select v.sector,count(*),string_agg(s.name,',' order by s.name) from stocks s join v_stock_sector v on v.code=s.code where s.security_type='STOCK' and v.sector is not null and s.code not in (select code from sector_override where note like '자동매핑%') group by 1 order by 2 desc")
for sec,n,names in c.fetchall(): print(f"- {sec} ({n}): {names[:90]}")
c.execute("select count(*) from sector_override where note like '자동매핑%'"); print("auto",c.fetchone())
