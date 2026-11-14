# -*- coding: utf-8 -*-
"""업종별 시가총액 비중(읽기 전용): 최신 거래일 코스피+코스닥 보통주 기준. 업종 분류별 비중·상위 종목."""
import os,psycopg2,collections
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur=conn.cursor()
L=[]
def log(m=""): print(m,flush=True); L.append(m)
cur.execute("select column_name from information_schema.columns where table_name='v_screener' order by ordinal_position"); cols=[r[0] for r in cur.fetchall()]
log("# 업종별 시가총액 비중\n- v_screener 컬럼: "+", ".join(cols))
cur.execute("select max(trade_date) from v_screener"); d=cur.fetchone()[0]; log(f"- 기준일 {d}")
mk="market" if "market" in cols else None
cur.execute("select column_name from information_schema.columns where table_name='stocks'"); sc=[r[0] for r in cur.fetchall()]
log("- stocks 컬럼: "+", ".join(sc))
def block(secexpr,title,topn=6):
    where=f"trade_date='{d}' and market_cap>0"
    cur.execute(f"select coalesce({secexpr},'(미분류)') s,count(*),sum(market_cap) from v_screener where {where} group by 1 order by 3 desc"); rs=cur.fetchall()
    tot=sum(float(r[2]) for r in rs); log(f"\n## {title}\n- 합계 {tot/1e12:,.0f}조원 · 종목 {sum(r[1] for r in rs)}개\n\n| 업종 | 종목수 | 시총(조) | 비중% | 상위 종목 |\n|---|---|---|---|---|")
    for s,n,c in rs:
        cur.execute(f"select name,market_cap from v_screener where {where} and coalesce({secexpr},'(미분류)')=%s order by market_cap desc limit {topn}",(s,))
        top=", ".join(f"{a}({float(b)/1e12:,.1f}조)" for a,b in cur.fetchall())
        log(f"| {s} | {n} | {float(c)/1e12:,.1f} | {float(c)/tot*100:.1f} | {top} |")
if "sector" in cols: block("sector","화면 업종(sector, 오버라이드 반영)")
for c in ("sector_krx","sector_kis","sector_kis_lcls"):
    if c in cols: block(c,c)
    elif c in sc:
        pass
open("sector_mcap.md","w",encoding="utf-8").write("\n".join(L))
