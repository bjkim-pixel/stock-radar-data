# -*- coding: utf-8 -*-
import os, re, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor(); o=[]
nz=lambda s:re.sub(r"\s","",s or "")
c.execute("select s.code,s.name,v.sector from stocks s left join v_stock_sector v on v.code=s.code where s.security_type='STOCK'")
ST=c.fetchall(); by={nz(n):(code,n,sec) for code,n,sec in ST}
def setsec(code,sec,note):
    c.execute("insert into sector_override(code,sector_override,note) values(%s,%s,%s) on conflict (code) do update set sector_override=excluded.sector_override,note=excluded.note",(code,sec,note))
o.append("## 증권(이름에 '증권' 포함)")
for code,n,sec in ST:
    if "증권" in n: setsec(code,"증권","이름에 증권 포함"); o.append(f"- {code} {n} ({sec} → 증권)")
c.execute("select code,coalesce(name_ko,name_en),sector_std from us_master where not is_etf and coalesce(name_ko,'') like '%%증권%%'")
for code,n,sec in c.fetchall():
    c.execute("update us_master set sector_std='증권',sector_std_src='manual' where code=%s",(code,)); o.append(f"- 해외 {code} {n} ({sec} → 증권)")
o.append("\n## 기계·장비 → 기계")
for code,n,sec in ST:
    if sec=="기계·장비": setsec(code,"기계","기계·장비 통합"); o.append(f"- {code} {n}")
o.append("\n## 삼성전자우 = 삼성전자")
a=by.get("삼성전자"); b=by.get("삼성전자우")
if a and b: setsec(b[0],a[2],"삼성전자와 동일"); o.append(f"- 삼성전자 {a[2]} → 삼성전자우 {b[1]} ({b[2]} → {a[2]})")
o.append("\n## 빙그레 = 롯데웰푸드·삼양식품·농심")
refs={n:by.get(nz(n)) for n in ("롯데웰푸드","삼양식품","농심")}
secs={n:(r[2] if r else None) for n,r in refs.items()}; o.append(f"- 기준: {secs}")
vals={v for v in secs.values() if v}
if len(vals)==1 and by.get("빙그레"):
    s=vals.pop(); setsec(by["빙그레"][0],s,"롯데웰푸드·삼양식품·농심과 동일"); o.append(f"- 빙그레 → {s}")
else: o.append("- 기준 업종이 일치하지 않거나 없음 → 빙그레 미적용")
o.append("\n## 보안: 안랩")
r=by.get("안랩")
if r: setsec(r[0],"보안","안랩 보안"); o.append(f"- {r[0]} {r[1]} ({r[2]} → 보안)")
else: o.append("- 안랩: DB에 없음")
o.append("\n## 자이에스앤디 = GS건설? (확인만)")
g=by.get("GS건설"); z=by.get("자이에스앤디"); o.append(f"- GS건설: {g[2] if g else 'DB에 없음'} · 자이에스앤디: {z[2] if z else '없음'}")
cn.commit()
c.execute("select v.sector,count(*) from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK' group by 1 order by 2 desc"); o.append("\n## 국내 업종 분포\n"+", ".join(f"{a}({b})" for a,b in c.fetchall()))
open("sector_merge.md","w").write("# 업종 통합 결과\n"+"\n".join(o))
