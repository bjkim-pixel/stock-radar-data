# -*- coding: utf-8 -*-
"""접속 기록 테이블(access_log) 생성 — 92_access_log.sql 실행. 여러 번 실행해도 안전."""
import os, sys, psycopg2
url = os.environ.get("SUPABASE_DB_URL", "")
if not url:
    sys.exit("SUPABASE_DB_URL 미설정")
sql = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "92_access_log.sql"), encoding="utf-8").read()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor(); cur.execute(sql)
cur.execute("select count(*) from access_log"); print("access_log 준비 완료 — 현재 행 수:", cur.fetchone()[0])
cur.execute("select has_table_privilege('anon','access_log','select')"); print("anon 읽기 권한(false여야 함):", cur.fetchone()[0])
