# -*- coding: utf-8 -*-
"""13F 제출 기관 CIK 탐색(읽기 전용): 이름으로 EDGAR 검색 → CIK·기관명·최신 13F 보고기준일."""
import os, re, time, requests, urllib.parse
H={"User-Agent":os.environ.get("SEC_UA") or "StockRadarResearch","Accept-Encoding":"gzip, deflate"}
Q=["National Pension Service","Norges Bank","Dalal Street","Pabrai","Appaloosa","Greenlight Capital","Oaktree Capital","Icahn Carl","ARK Investment Management","Viking Global","Elliott Investment","Citadel Advisors","Two Sigma Investments","D. E. Shaw","Millennium Management","Point72","Lone Pine Capital","Maverick Capital","Glenview Capital","Markel","Fairfax Financial","Daily Journal","Gotham Asset","Southeastern Asset Management","Children's Investment Fund","Trian Fund Management","Berkshire Hathaway","Pershing Square Capital","Scion Asset","Tiger Global","Coatue","Soros Fund","Duquesne","Himalaya Capital","Baupost","Third Point","Bridgewater","Renaissance Technologies","Sequoia Fund","Akre Capital","Fundsmith","Cantillon","Egerton Capital","Altimeter Capital","D1 Capital","Dragoneer","Whale Rock","Jana Partners","Starboard Value","ValueAct","Cevian"]
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
for q in Q:
    try:
        u="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company="+urllib.parse.quote(q)+"&type=13F-HR&owner=include&count=40&output=atom"
        r=requests.get(u,headers=H,timeout=30); time.sleep(0.25)
        if r.status_code!=200: log(f"- {q}: HTTP {r.status_code}"); continue
        t=r.text
        # atom은 company-info 형태. 목록 검색이면 entry 여러 개
        ents=re.findall(r"<conformed-name>([^<]+)</conformed-name>.*?<cik>(\d+)</cik>",t,flags=re.S)
        if not ents:
            ents=re.findall(r"<title>([^<]+)</title>.*?CIK=(\d+)",t,flags=re.S)
        log(f"## {q}: "+" | ".join(f"{n.strip()} ({int(c)})" for n,c in ents[:6]) if ents else f"## {q}: 결과 없음 (len {len(t)}) {t[:150]!r}")
    except Exception as e: log(f"- {q}: 실패 {type(e).__name__} {str(e)[:80]}")
open("f13_find.md","w",encoding="utf-8").write("\n".join(L))
