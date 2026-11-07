# -*- coding: utf-8 -*-
"""예상실적(컨센서스) 소스 점검 — 읽기 전용. 네이버 모바일 API / 네이버 메인 / FnGuide."""
import sys,json,re,requests
CODE=sys.argv[1] if len(sys.argv)>1 else "000660"
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36","Referer":"https://m.stock.naver.com/"}
def get(name,url,show=1500,**kw):
    print("\n"+"="*70+f"\n## {name}\n{url}",flush=True)
    try:
        r=requests.get(url,headers=H,timeout=20,**kw)
    except Exception as e:
        print("ERR",e);return None
    print("http",r.status_code,"len",len(r.content),"ctype",r.headers.get("content-type"))
    return r
for base in ["https://m.stock.naver.com/api/stock","https://api.stock.naver.com/stock"]:
    for per in ["annual","quarter"]:
        r=get(f"네이버 모바일 finance/{per} ({base.split('/')[2]})",f"{base}/{CODE}/finance/{per}")
        if r is not None and r.status_code==200:
            try:
                j=r.json(); fi=j.get("financeInfo",{})
                print("keys",list(j.keys()))
                print("trTitleList",json.dumps(fi.get("trTitleList"),ensure_ascii=False)[:900])
                for row in fi.get("rowList",[])[:12]:
                    print(" ",row.get("title"),{k:v.get("value") for k,v in list(row.get("columns",{}).items())})
            except Exception as e: print("parse",e,r.text[:600])
r=get("네이버 PC 메인 기업실적분석",f"https://finance.naver.com/item/main.naver?code={CODE}")
if r is not None and r.status_code==200:
    t=r.content.decode("euc-kr","ignore")
    i=t.find("기업실적분석"); print("has 기업실적분석",i>=0)
    seg=re.sub(r"<[^>]+>"," ",t[i:i+9000]); seg=re.sub(r"\s+"," ",seg); print(seg[:1800])
r=get("네이버 wisereport(FnGuide)",f"https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd={CODE}")
if r is not None and r.status_code==200:
    t=r.text; print("has 컨센서스",("컨센서스" in t), "has (E)",("(E)" in t)); print(re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",t))[:800])
r=get("FnGuide Main",f"https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A{CODE}&cID=&MenuYn=Y&ReportGB=D&NewMenuID=101&stkGb=701")
if r is not None and r.status_code==200:
    t=r.text; i=t.find("(E)"); print("has (E)",i>=0)
    seg=re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",t[max(0,i-3000):i+4000])); print(seg[:2500])
r=get("FnGuide 컨센서스 JSON(wisereport)",f"https://navercomp.wisereport.co.kr/v2/company/ajax/cF1001.aspx?cmp_cd={CODE}&fin_typ=0&freq_typ=Y&encparam=&id=")
