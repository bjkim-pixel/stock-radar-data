# -*- coding: utf-8 -*-
"""업종 미분류 종목을 sector_kis(→없으면 sector_kis_lcls) 기준으로, 이미 분류된 종목들의 최다 sector_krx에 매핑해 sector_override에 저장."""
import os, psycopg2
from collections import Counter, defaultdict
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
cur.execute("""select s.code,s.name,s.sector_kis,s.sector_kis_lcls,v.sector from stocks s left join v_stock_sector v on v.code=s.code where s.security_type='STOCK'""")
rows = cur.fetchall()
byk = defaultdict(Counter); byl = defaultdict(Counter)
for c,n,k,l,sec in rows:
    if sec:
        if k: byk[k][sec]+=1
        if l: byl[l][sec]+=1
un = [r for r in rows if not r[4]]
print(f"# 업종 미분류 {len(un)}종목 매핑")
ok=[]; bad=[]
for c,n,k,l,_ in un:
    pick=None
    for tbl,key in ((byk,k),(byl,l)):
        if key and key in tbl:
            sec,cnt=tbl[key].most_common(1)[0]; tot=sum(tbl[key].values())
            if cnt/tot>=0.5: pick=(sec,f"KIS {key} {cnt}/{tot}"); break
    (ok if pick else bad).append((c,n,k,l,pick))
for c,n,k,l,p in ok:
    cur.execute("""insert into sector_override (code,sector_override,note) values (%s,%s,%s)
                   on conflict (code) do update set sector_override=excluded.sector_override, note=excluded.note""",(c,p[0],"자동매핑 "+p[1]))
conn.commit()
print(f"- 매핑 저장 {len(ok)}종목")
for c,n,k,l,p in ok: print(f"  · {n} ({c}) → {p[0]}  [{p[1]}]")
print(f"- 매핑 실패 {len(bad)}종목 (수동 필요)")
for c,n,k,l,_ in bad: print(f"  · {n} ({c}) kis={k} / {l}")
