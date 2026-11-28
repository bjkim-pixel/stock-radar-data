import os, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor()
c.execute("insert into sector_override(code,sector_override,note) values('317400','인프라','GS건설과 동일') on conflict (code) do update set sector_override=excluded.sector_override,note=excluded.note"); cn.commit()
c.execute("select s.name,v.sector from stocks s join v_stock_sector v on v.code=s.code where s.code='317400'"); r=c.fetchone()
c.execute("select count(*) from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK' and v.sector='건설'"); n=c.fetchone()[0]
open("zai.md","w").write(f"{r}\n건설 업종 잔여 국내 종목: {n}")
