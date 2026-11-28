import os, psycopg2, collections
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
c.execute("select v.sector,s.name,s.code from stocks s join v_stock_sector v on v.code=s.code where s.security_type='STOCK' order by 1,2")
K=collections.defaultdict(list)
for sec,nm,code in c.fetchall(): K[sec].append(f"{nm}({code})")
c.execute("select coalesce(sector_std,'(미분류)'),coalesce(name_ko,name_en),code from us_master where not is_etf order by 1,2")
U=collections.defaultdict(list)
for sec,nm,code in c.fetchall(): U[sec].append(f"{nm}({code})")
o=["# 업종별 종목 목록 (국내 / 해외)\n"]
for sec in sorted(set(K)|set(U),key=lambda s:-(len(K.get(s,[]))+len(U.get(s,[])))):
    o.append(f"## {sec} — 국내 {len(K.get(sec,[]))} · 해외 {len(U.get(sec,[]))}")
    if K.get(sec): o.append("- 국내: "+", ".join(K[sec]))
    if U.get(sec): o.append("- 해외: "+", ".join(U[sec]))
    o.append("")
open("sector_lists.md","w").write("\n".join(o))
