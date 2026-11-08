# -*- coding: utf-8 -*-
"""data_version() 함수 생성(128_data_version.sql). 여러 번 실행해도 안전."""
import os,psycopg2,time
sql=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"128_data_version.sql"),encoding="utf-8").read()
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor(); cur.execute(sql)
t=time.time(); cur.execute("select data_version()"); v=cur.fetchone()[0]
msg=f"data_version() = {v} ({(time.time()-t)*1000:.0f}ms)"; print(msg)
open("data_version_report.md","w",encoding="utf-8").write(msg+"\n")
