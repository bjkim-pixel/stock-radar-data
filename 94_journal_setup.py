# -*- coding: utf-8 -*-
"""투자일지 테이블(journal_entries) 생성 — 94_journal.sql 실행. 여러 번 실행해도 안전."""
import os, sys, psycopg2
url = os.environ.get("SUPABASE_DB_URL", "")
if not url:
    sys.exit("SUPABASE_DB_URL 미설정")
sql = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "94_journal.sql"), encoding="utf-8").read()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor(); cur.execute(sql)
cur.execute("select count(*) from journal_entries"); print("journal_entries 준비 완료 — 현재 행 수:", cur.fetchone()[0])
cur.execute("select has_table_privilege('anon','journal_entries','select')"); print("anon 읽기 권한(false여야 함):", cur.fetchone()[0])
