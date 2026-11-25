# -*- coding: utf-8 -*-
"""반도체 추종 2차 점검(읽기 전용): 외국인 보유율(소진율) 일별 이력을 어디서 받을 수 있는지 확인.
 A. 네이버 모바일 API 종목 trend (페이지 크기·페이지 이동·과거 한계)  B. KIS 현재가·일자별 시세에 보유율 필드가 있는지"""
import os,time,json,requests,importlib,datetime as dt
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
H={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json"}
def nv(tag,url):
    try:
        r=requests.get(url,headers=H,timeout=20); t=r.text
        try: j=r.json()
        except Exception: j=None
        n=len(j) if isinstance(j,list) else (len(j.get("trendList") or j.get("list") or []) if isinstance(j,dict) else 0)
        log(f"- **{tag}** {r.status_code} · {url}\n  길이 {len(t)} · 행수 {n}")
        rows=j if isinstance(j,list) else (j.get("trendList") or j.get("list") or []) if isinstance(j,dict) else []
        if rows:
            log("  키: "+", ".join(rows[0].keys())); log("  첫행: "+json.dumps(rows[0],ensure_ascii=False)[:500]); log("  끝행: "+json.dumps(rows[-1],ensure_ascii=False)[:500])
        else: log("  원문: "+t[:600])
    except Exception as e: log(f"- **{tag}** 오류 {e}")
log("# 외국인 보유율 이력 점검\n")
b="https://m.stock.naver.com/api/stock/005930/trend"
for tag,u in (("A1 기본",b),("A2 pageSize=5",b+"?pageSize=5"),("A3 pageSize=400",b+"?pageSize=400"),("A4 page=2",b+"?pageSize=20&page=2"),("A5 integration",
    "https://m.stock.naver.com/api/stock/005930/integration")):
    nv(tag,u); time.sleep(0.4)
nv("A6 구 PC 페이지 frgn","https://finance.naver.com/item/frgn.naver?code=005930&page=1")
KEY=os.environ.get("KIS_APP_KEY",""); SEC=os.environ.get("KIS_APP_SECRET","")
try:
    tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
    B="https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/"
    def kg(tag,path,tr,p):
        time.sleep(0.3)
        j=requests.get(B+path,params=p,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":tr,"custtype":"P"}).json()
        for k in ("output","output1","output2"):
            v=j.get(k)
            if v:
                v=v if isinstance(v,list) else [v]; ks=list(v[0].keys())
                log(f"- **{tag}** [{k}] {len(v)}행 · 보유 관련 키: "+", ".join(x for x in ks if "frgn" in x.lower() or "hldn" in x.lower() or "ehrt" in x.lower()))
                log("  예: "+json.dumps(v[0],ensure_ascii=False)[:700])
        if not any(j.get(k) for k in ("output","output1","output2")): log(f"- **{tag}** {j.get('rt_cd')} {j.get('msg1')}")
    kg("B1 현재가(FHKST01010100)","inquire-price","FHKST01010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":"005930"})
    kg("B2 일자별(FHKST01010400)","inquire-daily-price","FHKST01010400",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":"005930","FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"1"})
    kg("B3 투자자(FHKST01010900)","inquire-investor","FHKST01010900",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":"005930"})
except Exception as e: log(f"KIS 점검 오류 {e}")
open("hold_probe.md","w",encoding="utf-8").write("\n".join(L))
