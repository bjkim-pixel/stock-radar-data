# -*- coding: utf-8 -*-
import os, psycopg2, collections
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
c.execute("select code,coalesce(name_ko,name_en),sector,profile->>'industry',kis_excd from us_master where not is_etf order by code")
R=c.fetchall(); o=[f"# 해외 일반종목 업종: 우리 DB(KIS sector) vs 네이버 industry · {len(R)}종목\n"]
ks=collections.Counter(r[2] or "(없음)" for r in R); ns=collections.Counter(r[3] or "(없음)" for r in R)
o.append(f"- KIS 업종 {len(ks)}종 / 네이버 업종 {len(ns)}종 · KIS 없음 {ks['(없음)']} · 네이버 없음 {ns['(없음)']}")
o.append(f"- 이름 정확히 일치: {sum(1 for r in R if r[2] and r[2]==r[3])}종목\n")
o.append("## KIS 업종(건수)\n"+", ".join(f"{a}({b})" for a,b in ks.most_common())+"\n")
o.append("## 네이버 업종(건수)\n"+", ".join(f"{a}({b})" for a,b in ns.most_common())+"\n")
m=collections.defaultdict(collections.Counter)
for r in R: m[r[2] or "(없음)"][r[3] or "(없음)"]+=1
o.append("## KIS 업종 → 네이버 업종 분포\n")
for k,v in sorted(m.items(),key=lambda x:-sum(x[1].values())): o.append(f"- {k}({sum(v.values())}): "+", ".join(f"{a}({b})" for a,b in v.most_common(6)))
open("sector_cmp.md","w").write("\n".join(o))
