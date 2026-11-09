# -*- coding: utf-8 -*-
"""이사 지분율 데이터 점검(읽기 전용): DART 임원·주요주주 소유보고(elestock), 최대주주 현황(hyslrSttus), 사내이사 대조."""
import os,sys,io,zipfile,json,time,collections,requests,xml.etree.ElementTree as ET
KEY=os.environ.get("DART_API_KEY","").strip()
if not KEY: sys.exit("DART_API_KEY 미설정")
B="https://opendart.fss.or.kr/api/"
def js(ep,**p):
    time.sleep(0.2); return requests.get(B+ep,params={"crtfc_key":KEY,**p},timeout=30).json()
r=requests.get(B+"corpCode.xml",params={"crtfc_key":KEY},timeout=60); z=zipfile.ZipFile(io.BytesIO(r.content)); x=ET.fromstring(z.read(z.namelist()[0]))
m={(e.findtext("stock_code") or "").strip():(e.findtext("corp_code"),e.findtext("corp_name")) for e in x.iter("list")}
for sc in ["192820","161890","005930"]:
    cc,nm=m[sc]; print(f"\n# {nm} {sc}")
    ex=js("exctvSttus.json",corp_code=cc,bsns_year="2026",reprt_code="11012").get("list") or []
    inner=[e["nm"].replace(" ","") for e in ex if e.get("rgist_exctv_at") in("사내이사","기타비상무이사")]
    print("사내이사(등기):",inner)
    j=js("elestock.json",corp_code=cc); L=j.get("list") or []
    print("elestock status",j.get("status"),j.get("message"),"행",len(L))
    if L: print("키:",list(L[0].keys()))
    last={}
    for it in sorted(L,key=lambda i:i.get("rcept_dt","")):
        last[it["repror"].replace(" ","")]=it
    for n in inner:
        it=last.get(n)
        print("  ",n,"→",None if not it else (it.get("rcept_dt"),it.get("isu_exctv_ofcps"),it.get("isu_main_shrholdr"),it.get("sp_stock_lmp_cnt"),it.get("sp_stock_lmp_rate")))
    print("  (소유보고서에 있는 전체 보고자 수:",len(last),")")
    hs=js("hyslrSttus.json",corp_code=cc,bsns_year="2026",reprt_code="11012").get("list") or []
    for h in hs:
        if h.get("stock_knd")=="보통주": print("   hyslr",h["nm"],h["relate"],h["trmend_posesn_stock_co"],h["trmend_posesn_stock_qota_rt"])
