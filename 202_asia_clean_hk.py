import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True; c = c.cursor()
c.execute("delete from us_top_asia where excd='HKS'"); print("deleted", c.rowcount)
c.execute("select excd,count(*) from us_top_asia group by 1"); print(c.fetchall())
open("asia_list.md", "w").write("deleted HKS from us_top_asia; remaining " + str(c.fetchall() if False else ""))
