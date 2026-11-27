# -*- coding: utf-8 -*-
import os, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor(); o=[]
for code in ("001120","047050"):
    c.execute("insert into sector_override(code,sector_override,note) values(%s,'종합상사','사용자 지시: 종합상사 신설·재분류') on conflict (code) do update set sector_override=excluded.sector_override,note=excluded.note",(code,))
    c.execute("select s.name,v.sector from stocks s join v_stock_sector v on v.code=s.code where s.code=%s",(code,)); o.append(f"- 국내 {code} {c.fetchone()}")
M={"종합상사":["8001.T","8002.T","8015.T","8031.T","8053.T","8058.T"],"금융":["BRK.A","BRK.B"],
   "엔터·미디어":["DIS"],"소비재":["4661.T"],"암호화폐·AI인프라":["HUT","IREN","RIOT","WULF"]}
for sec,codes in M.items():
    for code in codes:
        c.execute("update us_master set sector_std=%s,sector_std_src='manual' where code=%s returning name_ko",(sec,code))
        r=c.fetchone(); o.append(f"- 해외 {code} {r[0] if r else '(없음)'} → {sec}")
cn.commit()
c.execute("select coalesce(sector_std,'(미분류)'),count(*) from us_master where not is_etf group by 1 order by 2 desc"); o.append("\n분포: "+", ".join(f"{a}({b})" for a,b in c.fetchall()))
c.execute("select count(*) from stocks s left join v_stock_sector v on v.code=s.code where s.security_type='STOCK' and v.sector is null"); o.append(f"국내 미분류: {c.fetchone()[0]}")
open("sector_final.md","w").write("# 최종 적용\n"+"\n".join(o))
