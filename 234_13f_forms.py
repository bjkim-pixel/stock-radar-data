# -*- coding: utf-8 -*-
"""13F 누락 펀드 진단(읽기 전용): CIK별 최근 공시 형식·보고기준일, 대체 CIK 검색, 노르웨이 중앙은행 파일 구성."""
import os, re, time, requests, urllib.parse
H={"User-Agent":os.environ.get("SEC_UA") or "StockRadarResearch","Accept-Encoding":"gzip, deflate"}
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
def get(u):
    time.sleep(0.2); return requests.get(u,headers=H,timeout=45)
for nm,cik in [("퍼싱스퀘어",1336528),("아팔루사",1006438),("그린라이트",1079114),("포인트72",1698051),("매버릭",928617),("마켈",1034180),("캔틸런",1352269),("에저턴",1083657)]:
    j=get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json").json(); f=j["filings"]["recent"]
    rows=[(f["filingDate"][i],f["form"][i],f["reportDate"][i]) for i in range(len(f["form"])) if f["form"][i].startswith("13F")][:6]
    log(f"## {nm} {cik} [{j.get('name')}] 최근 13F류: {rows}")
for q in ["Point72 Asset Management","Greenlight Capital Inc","Appaloosa Management","Maverick Capital","Egerton Capital","Cantillon Capital","Markel Gayner","Pershing Square"]:
    r=get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company="+urllib.parse.quote(q)+"&type=13F-HR&owner=include&count=40&output=atom")
    ents=re.findall(r"<conformed-name>([^<]+)</conformed-name>.*?<cik>(\d+)</cik>",r.text,flags=re.S)
    log(f"- 검색 {q}: {ents[:5]}")
# 노르웨이 중앙은행 2026-09-30 공시의 XML 구성
j=get("https://data.sec.gov/submissions/CIK0001374170.json").json(); f=j["filings"]["recent"]
for i,form in enumerate(f["form"]):
    if form=="13F-HR" and f["reportDate"][i] in ("2026-09-30","2026-03-31"):
        a=f["accessionNumber"][i].replace("-","")
        it=get(f"https://www.sec.gov/Archives/edgar/data/1374170/{a}/index.json").json()["directory"]["item"]
        log(f"## NBIM {f['reportDate'][i]} {a}: "+", ".join(f"{x['name']}({x.get('size')})" for x in it))
open("f13_forms.md","w",encoding="utf-8").write("\n".join(L))
