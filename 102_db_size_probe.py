# -*- coding: utf-8 -*-
"""DB 용량 점검(읽기 전용): 전체/테이블별 크기와 종목·일당 바이트 → ETF 추가 가능 종목 수 추정."""
import os,psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur=c.cursor(); L=[]
def log(m=""): print(m,flush=True); L.append(m)
cur.execute("select pg_database_size(current_database())"); tot=cur.fetchone()[0]
log(f"# DB 용량 점검\n\n- DB 전체: {tot/1e6:.0f} MB / 무료 한도 500 MB (남은 {500-tot/1e6:.0f} MB)\n")
cur.execute("""select c.relname, pg_total_relation_size(c.oid), pg_relation_size(c.oid), coalesce(s.n_live_tup,0)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace left join pg_stat_user_tables s on s.relid=c.oid
 where n.nspname='public' and c.relkind='r' order by 2 desc limit 25""")
log("| 테이블 | 총크기(MB, 인덱스 포함) | 데이터(MB) | 행수(추정) | 행당 총바이트 |\n|---|---|---|---|---|")
T={}
for n,t,r,rows in cur.fetchall():
    T[n]=(t,rows); log(f"| {n} | {t/1e6:.1f} | {r/1e6:.1f} | {rows} | {t/max(rows,1):.0f} |")
cur.execute("select count(*) from stocks"); log(f"\n- stocks 행수: {cur.fetchone()[0]}")
for q,lab in (("select count(distinct code),count(*),min(trade_date),max(trade_date),count(distinct trade_date) from daily_price","daily_price 종목/행/기간/거래일수"),
              ("select count(distinct code),count(*),min(trade_date),max(trade_date) from daily_flow","daily_flow"),
              ("select count(distinct code),count(*),min(trade_date),max(trade_date) from daily_metrics","daily_metrics"),
              ("select count(distinct code),count(*) from smart_money_state","smart_money_state")):
    try: cur.execute(q); log(f"- {lab}: {cur.fetchone()}")
    except Exception as e: c.rollback(); log(f"- {lab}: 실패 {str(e)[:80]}")
open('db_size_report.md','w',encoding='utf-8').write("\n".join(L))
