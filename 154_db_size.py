# -*- coding: utf-8 -*-
"""DB 용량 점검(읽기 전용): 전체 크기, 큰 테이블, 일별 증가 추정"""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True); cur = c.cursor()
cur.execute("select pg_database_size(current_database()), pg_size_pretty(pg_database_size(current_database()))")
b, t = cur.fetchone(); print(f"# DB 용량\n- 전체 {t} ({b/1024/1024:.1f} MB)")
cur.execute("""select relname, pg_total_relation_size(c.oid) tot, pg_relation_size(c.oid) tbl, reltuples::bigint
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' order by tot desc limit 15""")
print("\n| 테이블 | 총(인덱스 포함) MB | 데이터 MB | 행수(추정) |\n|---|---|---|---|")
for r in cur: print(f"| {r[0]} | {r[1]/1048576:.1f} | {r[2]/1048576:.1f} | {r[3]:,} |")
cur.execute("select pg_size_pretty(sum(pg_total_relation_size(c.oid))) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'")
print("\n- public 테이블 합계 " + cur.fetchone()[0])
for tb, col in [("daily_price", "trade_date"), ("daily_flow", "trade_date")]:
    try:
        cur.execute(f"select count(distinct {col}), min({col}), max({col}), count(*) from {tb}")
        n, mn, mx, rows = cur.fetchone(); print(f"- {tb}: {n}거래일 {mn}~{mx}, {rows:,}행")
    except Exception as e: print(f"- {tb} 조회 실패 {str(e)[:60]}")
