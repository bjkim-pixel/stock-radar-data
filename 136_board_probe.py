# -*- coding: utf-8 -*-
"""이사회 구성 데이터 점검(읽기 전용): DART 임원현황·사외이사·최대주주 API, 코스맥스/한국콜마/삼성전자."""
import os,sys,io,zipfile,json,time,requests,xml.etree.ElementTree as ET
KEY=os.environ.get("DART_API_KEY","").strip()
if not KEY: sys.exit("DART_API_KEY 미설정")
B="https://opendart.fss.or.kr/api/"
def js(ep,**p):
    time.sleep(0.2); return requests.get(B+ep,params={"crtfc_key":KEY,**p},timeout=30).json()
r=requests.get(B+"corpCode.xml",params={"crtfc_key":KEY},timeout=60); z=zipfile.ZipFile(io.BytesIO(r.content)); x=ET.fromstring(z.read(z.namelist()[0]))
m={(e.findtext("stock_code") or "").strip():(e.findtext("corp_code"),e.findtext("corp_name")) for e in x.iter("list")}
for sc in ["192820","161890","005930"]:
    cc,nm=m[sc]; print(f"\n# {nm} {sc} corp_code={cc}")
    for yr,rc in [("2026","11012"),("2025","11011")]:
        for ep in ["exctvSttus","outcmpnyDrctrNdChangeSttus","hyslrSttus"]:
            j=js(ep+".json",corp_code=cc,bsns_year=yr,reprt_code=rc)
            L=j.get("list") or []
            print(f"\n## {yr} {rc} {ep}: status={j.get('status')} {j.get('message')} 행={len(L)}")
            for it in L[:14]: print(json.dumps(it,ensure_ascii=False))
    if sc!="005930": pass
    else: break
