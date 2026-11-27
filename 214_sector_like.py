# -*- coding: utf-8 -*-
"""지정한 국내 종목과 같은 업종으로 해외 종목 sector_std 설정."""
import os, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor()
REF={"HD":"267260","SE":"009150","HO":"042660","LX":"001120","PO":"047050","LG":"066570"}
sec={}; o=["# 기준 국내 종목 업종\n"]
for k,code in REF.items():
    c.execute("select s.name,v.sector from stocks s left join v_stock_sector v on v.code=s.code where s.code=%s",(code,))
    r=c.fetchone(); sec[k]=r[1] if r else None; o.append(f"- {code} {r[0] if r else '(없음)'} → {sec[k]}")
T=[("6501.T","HD"),("6503.T","SE"),("7011.T","HO"),("7012.T","HO"),("1810.HK","LG"),("81810.HK","LG"),("AAPL","LG")]
if sec["LX"] and sec["LX"]==sec["PO"]: T+=[(x,"LX") for x in ("8001.T","8002.T","8015.T","8031.T","8053.T","8058.T")]; o.append(f"\n종합상사: LX·포스코인터 동일 업종({sec['LX']}) → 적용")
else: o.append(f"\n종합상사: LX={sec['LX']} 포스코인터={sec['PO']} → 불일치, 미적용")
o.append("\n# 적용")
for code,k in T:
    if not sec[k]: o.append(f"- {code} 건너뜀(기준 업종 없음)"); continue
    c.execute("update us_master set sector_std=%s,sector_std_src='manual' where code=%s returning name_ko",(sec[k],code))
    r=c.fetchone(); o.append(f"- {code} {r[0] if r else '(코드 없음)'} → {sec[k]}")
cn.commit(); open("sector_like.md","w").write("\n".join(o))
