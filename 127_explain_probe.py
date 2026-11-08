# -*- coding: utf-8 -*-
"""느린 뷰의 서버 실행시간(EXPLAIN ANALYZE) 측정 — 읽기 전용(트랜잭션 rollback)."""
import os,psycopg2,json
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=False; cur=conn.cursor()
cur.execute("select max(trade_date) from daily_price"); D=cur.fetchone()[0]
cur.execute("show server_version"); ver=cur.fetchone()[0]
Q=[("v_stock_flow_periods 전체","select * from v_stock_flow_periods"),
("v_stock_flow_periods 1종목","select * from v_stock_flow_periods where code='000660'"),
("v_etf_screener 오늘",f"select * from v_etf_screener where trade_date='{D}'"),
("v_flow_rank_today 오늘",f"select * from v_flow_rank_today where trade_date='{D}'"),
("flow_rank_on 오늘",f"select * from flow_rank_on('{D}')"),
("v_market_overview","select * from v_market_overview order by trade_date"),
("v_kospi_flow_daily","select * from v_kospi_flow_daily order by trade_date"),
("v_stock_chart 1종목","select * from v_stock_chart where code='000660' order by trade_date"),
("v_screener 오늘 *",f"select * from v_screener where trade_date='{D}'"),
("v_stock_summary 1종목","select * from v_stock_summary where code='000660'"),
("v_sector_rank","select * from v_sector_rank"),
("v_sector_flow_daily 반도체","select * from v_sector_flow_daily where sector='반도체' order by trade_date"),
("v_sector_stocks 반도체 오늘",f"select * from v_sector_stocks where sector='반도체' and trade_date='{D}'"),
("v_market_amount_real","select * from v_market_amount_real order by trade_date"),
("v_market_flow_periods","select * from v_market_flow_periods"),
("v_data_status","select * from v_data_status"),
("distinct trade_date daily_price","select distinct trade_date from daily_price")]
out=[f"# EXPLAIN ANALYZE (PG {ver}, 기준일 {D})","","| 쿼리 | 실행(ms) | 계획(ms) | 행 |","|---|---|---|---|"]
plans={}
for n,s in Q:
    try:
        cur.execute("explain (analyze, buffers, format json) "+s); p=cur.fetchone()[0][0]
        out.append(f"| {n} | {p['Execution Time']:.0f} | {p['Planning Time']:.0f} | {p['Plan'].get('Actual Rows')} |"); plans[n]=p
    except Exception as e:
        conn.rollback(); out.append(f"| {n} | 오류 {str(e)[:80]} | | |")
    conn.rollback()
def walk(node,depth,acc):
    acc.append(("  "*depth)+f"{node['Node Type']} {node.get('Relation Name','')} {node.get('Index Name','')} rows={node.get('Actual Rows')} loops={node.get('Actual Loops')} t={node.get('Actual Total Time')}")
    for c in node.get("Plans",[]): walk(c,depth+1,acc)
for n in ["v_stock_flow_periods 전체","v_etf_screener 오늘","v_flow_rank_today 오늘","v_market_overview","v_kospi_flow_daily","v_stock_chart 1종목","v_screener 오늘 *"]:
    if n in plans:
        acc=[]; walk(plans[n]["Plan"],0,acc)
        out+=["",f"## {n}","```"]+acc[:45]+["```"]
cur.execute("select indexrelname, relname from pg_stat_user_indexes where relname in ('daily_flow','daily_price','daily_program','daily_metrics','etf_daily','market_daily','signals') order by 2,1")
out+=["","## 인덱스"]+[f"- {r[1]}.{r[0]}" for r in cur.fetchall()]
open("explain_report.md","w",encoding="utf-8").write("\n".join(out)+"\n"); print("\n".join(out[:30]))
