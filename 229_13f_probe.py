# -*- coding: utf-8 -*-
"""SEC EDGAR 13F-HR 수집 가능성 점검(읽기 전용): 제출 목록 → 최근 2개 분기 infotable → 신규/청산/증감 계산."""
import re, time, requests, xml.etree.ElementTree as ET
import os
H={"User-Agent":os.environ.get("SEC_UA") or "StockRadarResearch","Accept-Encoding":"gzip, deflate"}
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
def get(url):
    time.sleep(0.2)
    r=requests.get(url,headers=H,timeout=30); return r
INV={"버크셔 해서웨이":1067983,"브리지워터":1350694,"사이언(마이클 버리)":1649339,"퍼싱스퀘어(빌 애크먼)":1336528,"소로스 펀드":1029160,"르네상스":1037389,"듀케인(드러켄밀러)":1536411,"타이거 글로벌":1167483,"코튜":1135730,"서드포인트":1040273,"바우포스트":1061768,"히말라야(모니시 파브라이)":1709323}
def filings(cik):
    r=get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
    if r.status_code!=200: return None,r.status_code
    j=r.json(); f=j["filings"]["recent"]; out=[]
    for i,form in enumerate(f["form"]):
        if form in ("13F-HR",): out.append((f["filingDate"][i],f["reportDate"][i],f["accessionNumber"][i],f["primaryDocument"][i]))
    return (j.get("name"),out),200
def infotable(cik,acc):
    a=acc.replace("-","")
    r=get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{a}/")
    if r.status_code!=200: return None
    links=re.findall(r'href="([^"]+\.xml)"',r.text)
    cand=[l for l in links if "primary_doc" not in l.lower()]
    for l in cand:
        u=l if l.startswith("http") else "https://www.sec.gov"+l
        x=get(u)
        if x.status_code==200 and b"infoTable" in x.content[:5000]+x.content[-2000:] or (x.status_code==200 and b"informationTable" in x.content[:3000]):
            return x.content
    return None
def parse(xml):
    xml=re.sub(rb'xmlns(:\w+)?="[^"]+"',b"",xml); xml=re.sub(rb"<(/?)\w+:",rb"<\1",xml)
    root=ET.fromstring(xml); pos={}
    for it in root.iter("infoTable"):
        g=lambda t:(it.findtext(t) or "").strip()
        cusip=g("cusip"); name=g("nameOfIssuer"); val=float(g("value") or 0)
        sh=it.find("shrsOrPrnAmt"); n=float((sh.findtext("sshPrnamt") if sh is not None else "0") or 0)
        pc=g("putCall")
        key=(cusip,pc)
        d=pos.setdefault(key,{"name":name,"val":0,"sh":0,"pc":pc}); d["val"]+=val; d["sh"]+=n
    return pos
t0=time.time()
log("# 13F 수집 가능성 점검 (SEC EDGAR)\n")
for nm,cik in INV.items():
    try:
        res,st=filings(cik)
        if not res: log(f"- {nm}: 제출 목록 HTTP {st}"); continue
        name,fl=res; log(f"\n## {nm} ({name}, CIK {cik}) · 13F-HR {len(fl)}건 · 최신 {fl[0][:2] if fl else None}")
        if len(fl)<2: continue
        cur=parse(infotable(cik,fl[0][2])); prv=parse(infotable(cik,fl[1][2]))
        tot=sum(v["val"] for v in cur.values()); log(f"  보유 {len(cur)}종목 · 평가액 합계 ${tot/1e9:,.1f}B · 직전 분기({fl[1][1]}) {len(prv)}종목")
        top=sorted(cur.items(),key=lambda x:-x[1]["val"])[:5]
        log("  상위: "+", ".join(f"{v['name']} {v['val']/tot*100:.1f}%" for k,v in top))
        new=[(k,v) for k,v in cur.items() if k not in prv]; ex=[(k,v) for k,v in prv.items() if k not in cur]
        inc=[(k,v,prv[k]) for k,v in cur.items() if k in prv and prv[k]["sh"]>0 and v["sh"]/prv[k]["sh"]-1>=0.2]
        dec=[(k,v,prv[k]) for k,v in cur.items() if k in prv and prv[k]["sh"]>0 and v["sh"]/prv[k]["sh"]-1<=-0.2]
        log(f"  신규 {len(new)} · 청산 {len(ex)} · 20%↑ 증가 {len(inc)} · 20%↓ 감소 {len(dec)}")
        log("  신규 상위: "+", ".join(f"{v['name']}(${v['val']/1e6:,.0f}M)" for k,v in sorted(new,key=lambda x:-x[1]['val'])[:5]))
        log("  청산 상위: "+", ".join(f"{v['name']}(${v['val']/1e6:,.0f}M)" for k,v in sorted(ex,key=lambda x:-x[1]['val'])[:5]))
    except Exception as e: log(f"- {nm}: 실패 {type(e).__name__} {str(e)[:100]}")
log(f"\n총 소요 {time.time()-t0:.0f}초")
open("f13_probe.md","w",encoding="utf-8").write("\n".join(L))
