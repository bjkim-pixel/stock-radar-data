#!/usr/bin/env python3
"""네이버 한국 국채 10년 일별 시세 깊이 점검(읽기 전용, 임시)."""
import requests, json
rep=[]
def log(m=""): print(m); rep.append(m)
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
U="https://api.stock.naver.com/marketindex/bond/KR10YT=RR/prices"
r=requests.get(U,params={"page":1,"pageSize":3},headers=H,timeout=30); log("샘플: "+r.text[:700])
for p in (1,10,50,100,200,400,800,1200):
    r=requests.get(U,params={"page":p,"pageSize":60},headers=H,timeout=60)
    j=r.json() if r.status_code==200 else []
    log(f"page {p} (60개씩): HTTP {r.status_code} · {len(j)}행 · {j[0]['localTradedAt'][:10] if j else r.text[:100]} ~ {j[-1]['localTradedAt'][:10] if j else ''}")
    if not j: break
open("kr_rate_probe.md","w",encoding="utf-8").write("# 네이버 국채10년 깊이\n"+"\n".join(rep)+"\n")
