# -*- coding: utf-8 -*-
"""시장 전체 시가총액(코스피·코스닥) 일별 이력 소스 점검(읽기 전용)"""
import re,json,requests
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
print("# A. KRX 전체지수 시세(MDCSTAT00101) — 상장시가총액 컬럼")
for d in ["20261109","20261102"]:
    for ind in ["02","03"]:
        try:
            s=requests.Session(); s.get("http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201010101",headers=UA,timeout=20)
            r=s.post("http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd",headers={**UA,"Referer":"http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201010101"},
                data={"bld":"dbms/MDC/STAT/standard/MDCSTAT00101","idxIndMidclssCd":ind,"trdDd":d,"share":"2","money":"3","csvxls_isNo":"false"},timeout=25)
            print(d,ind,r.status_code,r.text[:700].replace("\n"," "))
        except Exception as e: print("ERR",d,ind,e)
print("\n# B. 네이버 지수 integration/basic")
for u in ["https://m.stock.naver.com/api/index/KOSPI/integration","https://m.stock.naver.com/api/index/KOSPI/basic",
          "https://m.stock.naver.com/api/index/KOSPI/price?pageSize=3&page=1","https://m.stock.naver.com/api/index/KOSDAQ/integration"]:
    try:
        r=requests.get(u,headers={**UA,"Accept":"application/json"},timeout=20); t=r.text
        i=t.find("시가총액"); print(r.status_code,u.split("naver.com")[1],len(t),t[max(0,i-100):i+250].replace("\n"," ") if i>=0 else t[:300])
    except Exception as e: print("ERR",u,e)
