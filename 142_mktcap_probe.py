# -*- coding: utf-8 -*-
import re,json,requests
UA={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json"}
for u in ["https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1&pageSize=5",
          "https://m.stock.naver.com/api/stocks/marketValue/KOSDAQ?page=1&pageSize=5",
          "https://m.stock.naver.com/api/index/KOSPI/integration"]:
    try:
        r=requests.get(u,headers=UA,timeout=20); t=r.text
        print(r.status_code,u.split("naver.com")[1],len(t),t[:900].replace("\n"," "))
        if "integration" in u:
            for m in re.finditer(r'"key":"([^"]+)","value":"([^"]+)"',t): print("   ",m.group(1),m.group(2))
    except Exception as e: print("ERR",u,e)
# 페이지 수/총 종목 수 확인
for mk in ["KOSPI","KOSDAQ"]:
    tot=0;n=0;pg=1
    while pg<40:
        r=requests.get(f"https://m.stock.naver.com/api/stocks/marketValue/{mk}?page={pg}&pageSize=100",headers=UA,timeout=20)
        try: j=r.json()
        except Exception: print(mk,pg,"nonjson",r.status_code,r.text[:200]);break
        st=j.get("stocks") if isinstance(j,dict) else j
        if not st: print(mk,"end",pg,list(j.keys()) if isinstance(j,dict) else type(j)); break
        if pg==1: print(mk,"keys",list(j.keys()) if isinstance(j,dict) else "", json.dumps(st[0],ensure_ascii=False)[:600], j.get("totalCount") if isinstance(j,dict) else "")
        n+=len(st); pg+=1
    print(mk,"종목수",n)
