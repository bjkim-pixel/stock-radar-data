# -*- coding: utf-8 -*-
"""my_watchlist 테이블 생성 — 117_watchlist.sql 실행. 여러 번 실행해도 안전."""
import os, sys, psycopg2
url = os.environ.get("SUPABASE_DB_URL", "")
if not url:
    sys.exit("SUPABASE_DB_URL 미설정")
sql = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "117_watchlist.sql"), encoding="utf-8").read()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor(); cur.execute(sql)
cur.execute("select count(*) from my_watchlist"); print("my_watchlist 준비 완료 — 현재 행 수:", cur.fetchone()[0])
cur.execute("select has_table_privilege('anon','my_watchlist','select')"); print("anon 읽기 권한(false여야 함):", cur.fetchone()[0])
