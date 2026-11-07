#!/usr/bin/env python3
"""한국 금리 데이터 소스 점검 2차(읽기 전용, 임시)."""
import requests, re, json
rep=[]
def log(m=""): print(m); rep.append(m)
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36","Accept-Language":"ko-KR,ko;q=0.9"}
def t(name,fn):
    try: fn()
    except Exception as e: log(f"- {name}: 예외 {str(e)[:140]}")
def get(url,**kw):
    r=requests.get(url,headers=H,timeout=kw.pop("timeout",60),**kw)
    return r

def fred():
    for u in ("https://fred.stlouisfed.org/graph/fredgraph.csv?id=IRLTLT01KRM156N","https://fred.stlouisfed.org/data/IRLTLT01KRM156N.txt"):
        r=get(u,timeout=90); log(f"- FRED {u[-40:]}: HTTP {r.status_code} · {len(r.text.splitlines())}행 · {r.text[-80:]!r}")
t("FRED",fred)

def nmain():
    r=get("https://finance.naver.com/marketindex/"); r.encoding="euc-kr"
    log(f"- Naver 시장지표 메인: HTTP {r.status_code} · {len(r.text)}자")
    for m in re.findall(r'href="(/marketindex/[^"]*(?:interest|bond|IRR)[^"]*)"',r.text)[:12]: log(f"  링크 {m}")
t("naver main",nmain)

def napi():
    for u in ("https://api.stock.naver.com/marketindex/bond/KR10YT=RR","https://api.stock.naver.com/marketindex/bond/KR10YT=RR/prices?page=1&pageSize=5",
              "https://m.stock.naver.com/front-api/marketIndex/prices?category=bond&reutersCode=KR10YT%3DRR&page=1&pageSize=5",
              "https://api.stock.naver.com/marketindex/bond/KR3YT=RR/prices?page=1&pageSize=5"):
        r=get(u); log(f"- {u[:95]}: HTTP {r.status_code} · {r.text[:160]!r}")
t("naver api",napi)

def ecos():
    r=get("https://ecos.bok.or.kr/api/StatisticSearch/sample/json/kr/1/3/817Y002/D/20260101/20260110/010210000"); log(f"- ECOS sample키: HTTP {r.status_code} · {r.text[:160]!r}")
t("ecos",ecos)

def wgb():
    r=get("https://www.worldgovernmentbonds.com/country/south-korea/"); log(f"- worldgovernmentbonds: HTTP {r.status_code} · {len(r.text)}자")
t("wgb",wgb)

def inv():
    r=get("https://query1.finance.yahoo.com/v1/finance/search?q=korea%2010%20year%20bond%20yield"); log(f"- Yahoo search: HTTP {r.status_code} · {[ (q.get('symbol'),q.get('shortname')) for q in r.json().get('quotes',[])][:8]}")
t("ysearch",inv)
open("kr_rate_probe.md","w",encoding="utf-8").write("# 한국 금리 소스 점검 2\n"+"\n".join(rep)+"\n")
