# -*- coding: utf-8 -*-
"""KOSPI 수급 일별 뷰(v_kospi_flow_daily) 생성 — 95_kospi_flow.sql 실행. 여러 번 실행해도 안전."""
import os, sys, psycopg2
url = os.environ.get("SUPABASE_DB_URL", "")
if not url:
    sys.exit("SUPABASE_DB_URL 미설정")
sql = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "95_kospi_flow.sql"), encoding="utf-8").read()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor(); cur.execute(sql)
cur.execute("select max(trade_date)||' '||count(*) from v_kospi_flow_daily"); print("v_kospi_flow_daily 준비 완료 — 최신 행:", cur.fetchone()[0])
