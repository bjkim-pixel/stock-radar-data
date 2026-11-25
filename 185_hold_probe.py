# -*- coding: utf-8 -*-
"""외국인 보유율 이력 점검 2: 네이버 종목 trend API의 최대 pageSize와 과거로 넘기는 방법 확인(읽기 전용)"""
import time,json,requests
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
H={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json"}
b="https://m.stock.naver.com/api/stock/005930/trend"
def t(tag,params):
    try:
        r=requests.get(b,params=params,headers=H,timeout=20); a=r.json() if r.status_code==200 and r.text else []
        a=a if isinstance(a,list) else []
        log(f"- {tag} {params} → {r.status_code} · {len(a)}행 · {a[0]['bizdate'] if a else '-'} ~ {a[-1]['bizdate'] if a else '-'}" + ("" if a else " · "+r.text[:120]))
    except Exception as e: log(f"- {tag} 오류 {e}")
    time.sleep(0.3)
log("# 네이버 trend pageSize·페이지 점검\n")
for n in (30,50,60,80,100,120,150,200,250,300): t("size",{"pageSize":n})
for k in ("page","pageNo","pageNum","pageIndex","startIdx","offset","start"): t(k,{"pageSize":20,k:2})
for k in ("page","pageNo","pageNum"): t(k+"=0",{"pageSize":20,k:0})
t("bizdate",{"pageSize":20,"bizdate":"20261028"}); t("endDate",{"pageSize":20,"endDate":"20261028"}); t("toDate",{"pageSize":20,"toDate":"20261028"})
t("무파라미터",{})
open("hold_probe.md","w",encoding="utf-8").write("\n".join(L))
