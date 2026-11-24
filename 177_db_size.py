# -*- coding: utf-8 -*-
"""읽기 전용: DB 전체 용량과 큰 테이블 상위 25개"""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True); cur = c.cursor()
cur.execute("select pg_database_size(current_database()), pg_size_pretty(pg_database_size(current_database()))")
b, p = cur.fetchone(); print(f"## DB 전체 용량: **{p}** ({b/1048576:.0f} MB)\n")
print("| 테이블 | 전체(인덱스 포함) | 행 수(추정) |\n|---|---:|---:|")
cur.execute("""select n.nspname||'.'||c.relname, pg_total_relation_size(c.oid), c.reltuples::bigint
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema')
 order by 2 desc limit 25""")
for n, s, r in cur.fetchall(): print(f"| {n} | {s/1048576:.1f} MB | {r:,} |")
