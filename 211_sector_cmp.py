# -*- coding: utf-8 -*-
import os, psycopg2, collections
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
o=["# 업종 비교: 우리 DB(한국, v_stock_sector) vs 네이버 해외 업종\n"]
try:
    c.execute("select sector,count(*) from v_stock_sector group by 1 order by 2 desc")
    ours=c.fetchall()
except Exception as e:
    c.connection.rollback()
    c.execute("select coalesce(so.sector_override,s.sector_krx),count(*) from stocks s left join sector_override so on so.code=s.code group by 1 order by 2 desc"); ours=c.fetchall()
o.append(f"## 우리 DB 업종 {len(ours)}개\n"+", ".join(f"{a}({b})" for a,b in ours)+"\n")
c.execute("select m.kis_excd,m.profile->>'industry',count(*) from us_master m where not coalesce(m.is_etf,false) group by 1,2 order by 3 desc")
r=c.fetchall(); inds=collections.Counter(); 
for e,i,n in r: inds[i or "(없음)"]+=n
o.append(f"## 네이버 해외 업종 {len(inds)}개 (일반 종목 {sum(inds.values())})\n"+", ".join(f"{a}({b})" for a,b in inds.most_common())+"\n")
names={a for a,_ in ours if a}
same=[i for i in inds if i in names]
o.append(f"## 이름이 정확히 같은 업종: {len(same)}개 → {same}\n")
open("sector_cmp.md","w").write("\n".join(o))
