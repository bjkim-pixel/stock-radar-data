import os, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor()
c.execute("update us_master set sector_std='소비재',sector_std_src='manual' where code='PG'"); cn.commit()
open("pg_revert.md","w").write("PG -> 소비재 복구")
