# -*- coding: utf-8 -*-
"""배당 정보 외부 출처 점검(읽기 전용): 네이버(국내 종목·ETF·해외), KRX, DART, stockanalysis, Nasdaq."""
import os, re, json, time, requests
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36","Accept":"application/json,text/html,*/*","Accept-Language":"ko,en;q=0.8"}
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
RE=re.compile(r"div|배당|yield|분배|dvd|payout",re.I)
def walk(o,path="",out=None,depth=0):
    out=[] if out is None else out
    if depth>7: return out
    if isinstance(o,dict):
        for k,v in o.items():
            p=f"{path}.{k}" if path else k
            if isinstance(v,(dict,list)): walk(v,p,out,depth+1)
            elif RE.search(str(k)) or (isinstance(v,str) and RE.search(v) and len(v)<40): out.append((p,str(v)[:80]))
    elif isinstance(o,list):
        for i,v in enumerate(o[:60]): walk(v,f"{path}[{i}]",out,depth+1)
    return out
def get(url,**kw):
    try:
        r=requests.get(url,headers=H,timeout=20,**kw); return r
    except Exception as e: log(f"  요청 실패 {type(e).__name__}: {str(e)[:80]}"); return None
log("# 배당 외부 출처 점검\n")
log("## 1. 네이버 증권 — 국내 종목·ETF")
for code,nm in (("005930","삼성전자"),("017800","현대엘리베이터"),("161510","PLUS 고배당주(ETF)"),("466940","TIGER 은행고배당플러스TOP10(ETF)")):
    for ep in ("integration","basic"):
        r=get(f"https://m.stock.naver.com/api/stock/{code}/{ep}")
        if not r: continue
        log(f"- {nm} {code} /{ep}: HTTP {r.status_code} · {len(r.content)}B")
        if r.status_code==200:
            try:
                for p,v in walk(r.json())[:14]: log(f"    {p} = {v}")
            except Exception as e: log(f"    JSON 아님 {e}")
        time.sleep(0.4)
log("\n## 2. 네이버 증권 — 해외(월드)")
for code,nm in (("SCHD.K","SCHD(ETF)"),("JEPI.K","JEPI(ETF)"),("VYM.K","VYM(ETF)"),("KO.N","코카콜라"),("O.N","리얼티인컴"),("AAPL.O","애플")):
    for ep in ("basic","integration","overview"):
        r=get(f"https://api.stock.naver.com/stock/{code}/{ep}")
        if not r: continue
        log(f"- {nm} {code} /{ep}: HTTP {r.status_code} · {len(r.content)}B")
        if r.status_code==200:
            try:
                f=walk(r.json())
                for p,v in f[:12]: log(f"    {p} = {v}")
            except Exception as e: log(f"    JSON 아님")
        time.sleep(0.4)
log("\n## 3. KRX 정보데이터시스템 — 개별종목 배당수익률")
try:
    s=requests.Session(); s.headers.update(H); s.headers["Referer"]="http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020502"
    s.get("http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020502",timeout=20)
    r=s.post("http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd",data={"bld":"dbms/MDC/STAT/standard/MDCSTAT03501","searchType":"1","mktId":"ALL","trdDd":"20261127","isuCd":"KR7005930003","csvxls_isNo":"false"},timeout=25)
    log(f"- HTTP {r.status_code} · {len(r.content)}B · {r.text[:300].replace(chr(10),' ')}")
except Exception as e: log(f"- 실패 {type(e).__name__}: {str(e)[:100]}")
log("\n## 4. DART 배당에 관한 사항(alotMatter)")
k=os.environ.get("DART_API_KEY","")
if k:
    r=get("https://opendart.fss.or.kr/api/alotMatter.json",params={"crtfc_key":k,"corp_code":"00126380","bsns_year":"2025","reprt_code":"11011"})
    if r:
        try:
            j=r.json(); log(f"- status {j.get('status')} {j.get('message')} · 행 {len(j.get('list') or [])}")
            for x in (j.get("list") or [])[:12]: log(f"    {x.get('se')} | {x.get('stock_knd')} | 당기 {x.get('thstrm')} | 전기 {x.get('frmtrm')}")
        except Exception as e: log(f"- JSON 아님 {e}")
else: log("- DART 키 없음")
log("\n## 5. 해외 — stockanalysis.com / Nasdaq")
for url,nm in (("https://stockanalysis.com/etf/schd/dividend/","SCHD 분배 이력"),("https://stockanalysis.com/etf/schd/","SCHD 요약"),("https://stockanalysis.com/stocks/ko/dividend/","KO 배당 이력"),("https://api.nasdaq.com/api/quote/SCHD/dividends?assetclass=etf","Nasdaq SCHD 배당 API"),("https://api.nasdaq.com/api/quote/KO/dividends?assetclass=stocks","Nasdaq KO 배당 API")):
    r=get(url)
    if not r: continue
    log(f"- {nm}: HTTP {r.status_code} · {len(r.content)}B")
    if r.status_code==200:
        t=r.text
        m=re.findall(r"(Dividend Yield[^<]{0,60}|Annual Dividend[^<]{0,60}|Payout Ratio[^<]{0,60}|Dividend Growth[^<]{0,60}|Years[^<]{0,40})",t)[:6]
        log("    텍스트 힌트: "+" / ".join(x.strip()[:70] for x in m) if m else f"    앞부분: {t[:200]!r}")
    time.sleep(0.5)
log("\n## 6. 해외 배당 ETF 후보 리스트(참고): 이름만 확인, 등록 여부는 별도 결정")
open("div_ext_probe.md","w",encoding="utf-8").write("\n".join(L))
