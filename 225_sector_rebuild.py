# -*- coding: utf-8 -*-
"""업종 변경 반영: sector_daily만 올해 전 구간 재계산(05_metrics.sql의 sector_daily 단계 그대로) + 사라진 업종 잔존 행 삭제 + 검증.
daily_metrics·signals·포트폴리오는 건드리지 않음."""
import os, re, datetime, psycopg2
START=datetime.date(2026,1,2); END=datetime.date(2026,11,27); LOOK=START-datetime.timedelta(400)
P={"start_date":START.isoformat(),"end_date":END.isoformat(),"lookback":LOOK.isoformat()}
text=open("05_metrics.sql",encoding="utf-8").read()
buf=None; step=[]
for line in text.splitlines():
    if line.strip().startswith("-- @@STEP:"):
        if buf is not None: break
        if "sector_daily" in line: buf=step
        continue
    if buf is not None: buf.append(line)
sql="\n".join(step)
pr=re.compile(r"%\(\w+\)s"); out=[];last=0
for m in pr.finditer(sql): out.append(sql[last:m.start()].replace("%","%%"));out.append(m.group(0));last=m.end()
out.append(sql[last:].replace("%","%%")); sql="".join(out)
o=["# sector_daily 재계산·정리\n"]
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor()
c.execute("SET statement_timeout='10min'")
c.execute(sql,P); o.append(f"- 재계산 upsert {c.rowcount:,}행 ({START}~{END})"); cn.commit()
STALE=("K-컬처","건설","기계·장비","음식료·담배","전기·전자")
c.execute("delete from sector_daily where market='ALL' and trade_date between %s and %s and sector=any(%s)",(START,END,list(STALE)))
o.append(f"- 옛 업종 행 삭제 {c.rowcount:,}행 {STALE}"); cn.commit()
c.execute("select distinct v.sector from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK'"); cur={r[0] for r in c.fetchall()}
c.execute("select v.sector,count(*) from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK' group by 1"); act=dict(c.fetchall())
c.execute("select max(trade_date) from sector_daily"); d=c.fetchone()[0]
c.execute("select sector,stock_count,rs_rank,rs5_rank from sector_daily where trade_date=%s and market='ALL' order by rs_rank nulls last,sector",(d,))
o.append(f"\n## 최신일 {d}")
for s,n,a,b in c.fetchall(): o.append(f"- {s}: 종목 {n}(실제 {act.get(s)}) · RS {a} · RS5 {b}{' ⚠잔존' if s not in cur else ''}{' ⚠종목수차이' if act.get(s)!=n else ''}")
for s in ("엔터·미디어","화장품","종합상사","증권","보안","K-컬처"):
    c.execute("select count(*),min(trade_date),max(trade_date) from sector_daily where sector=%s and market='ALL' and trade_date>=%s",(s,START)); o.append(f"- 이력 {s}: {c.fetchone()}")
c.execute("select count(distinct sector) from v_sector_rank"); o.append(f"- v_sector_rank 업종 수: {c.fetchone()[0]}")
c.execute("select sector,rs_rank,stock_count from v_sector_rank where rs_rank<=5 order by rs_rank"); o.append("- RS 상위: "+", ".join(f"{a}({b})" for a,b,_ in c.fetchall()))
open("sector_rebuild.md","w").write("\n".join(o))
