# -*- coding: utf-8 -*-
"""13F 적재 검증(읽기 전용): 펀드별 신규/청산/증감 집계, 대표 종목 비중, 우리 DB 연결률."""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); L = []
def log(m=""): print(m, flush=True); L.append(str(m))
c.execute("select name_ko,style,last_period from f13_fund order by sort_no"); F = c.fetchall()
log("# 13F 적재 검증\n")
c.execute("""select f.name_ko,f.style,v.period,count(*) filter (where act='new'),count(*) filter (where act='exit'),count(*) filter (where act='add'),count(*) filter (where act='cut'),count(*) filter (where act='hold')
 from v_f13_change v join f13_fund f on f.cik=v.cik and f.last_period=v.period group by 1,2,3,f.sort_no order by f.sort_no""")
log("| 펀드 | 성격 | 기준 | 신규 | 청산 | 증가 | 감소 | 유지 |\n|---|---|---|---|---|---|---|---|")
for r in c.fetchall(): log("| " + " | ".join(str(x) for x in r) + " |")
c.execute("select h.name,h.ticker,h.pct,h.value from f13_holding h join f13_fund f on f.cik=h.cik and f.last_period=h.period where f.cik=1067983 and h.put_call='' order by h.value desc limit 6")
log("\n버크셔 상위: " + ", ".join(f"{a}({b}) {float(p):.1f}%" for a, b, p, v in c.fetchall()))
c.execute("select count(*) from f13_holding h join f13_fund f on f.cik=h.cik and f.last_period=h.period where h.put_call='' and h.ticker is not null and h.ticker in (select code from us_master)")
a = c.fetchone()[0]; c.execute("select count(*) from f13_holding h join f13_fund f on f.cik=h.cik and f.last_period=h.period where h.put_call=''"); b = c.fetchone()[0]
log(f"최신 분기 보유행 {b}개 중 우리 해외종목과 연결 {a}개")
c.execute("select count(*) from us_master"); log(f"us_master {c.fetchone()[0]}종목")
c.execute("select count(*),min(trade_date),max(trade_date) from us_daily"); log(f"us_daily {c.fetchone()}")
c.execute("select pg_size_pretty(pg_database_size(current_database()))"); log(f"DB 전체 {c.fetchone()[0]}")
open("f13_verify.md", "w", encoding="utf-8").write("\n".join(L))
