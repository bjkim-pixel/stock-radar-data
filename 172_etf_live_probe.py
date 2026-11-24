# -*- coding: utf-8 -*-
"""장중 실행: ETF에서도 자동매매 조건 3종(외인·기관 잠정, 체결강도, 프로그램매매)이 KIS에서 나오는지 점검. 읽기 전용."""
import os,json,time,importlib,datetime as dt,requests
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KEY=os.environ["KIS_APP_KEY"]; SEC=os.environ["KIS_APP_SECRET"]; B="https://openapi.koreainvestment.com:9443"
tok=importlib.import_module("72_kis_token").get_token_cached()
def get(path,tr,params):
    time.sleep(0.25)
    r=requests.get(B+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":tr,"custtype":"P"})
    try: return r.json()
    except Exception: return {"msg1":r.text[:80]}
def rows(j):
    for k in ("output","output1","output2"):
        v=j.get(k)
        if isinstance(v,list) and v: return k,v
        if isinstance(v,dict) and v: return k,[v]
    return None,[]
log(f"# ETF 장중 조건 점검 {dt.datetime.utcnow()+dt.timedelta(hours=9):%Y-%m-%d %H:%M} KST\n")
for code,nm in [("005930","삼성전자(기준)"),("069500","KODEX 200"),("360750","TIGER 미국S&P500"),("091160","KODEX 반도체"),("305720","KODEX 2차전지산업")]:
    log(f"## {code} {nm}")
    j=get("/uapi/domestic-stock/v1/quotations/investor-trend-estimate","HHPTJ04160200",{"MKSC_SHRN_ISCD":code})
    k,v=rows(j); log(f"- 외인·기관 잠정 HHPTJ04160200: rt_cd={j.get('rt_cd')} {str(j.get('msg1'))[:40]} · {k} {len(v)}행")
    for r in v[:6]: log("  "+json.dumps({a:b for a,b in r.items() if any(t in a for t in ("hour","frgn","orgn","sum"))},ensure_ascii=False)[:300])
    j=get("/uapi/domestic-stock/v1/quotations/inquire-ccnl","FHKST01010300",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code})
    k,v=rows(j); log(f"- 체결(체결강도) FHKST01010300: rt_cd={j.get('rt_cd')} · {len(v)}행 · 예 "+(json.dumps({a:b for a,b in v[0].items() if a in ("stck_cntg_hour","stck_prpr","tday_rltv","cntg_vol")},ensure_ascii=False) if v else ""))
    j=get("/uapi/domestic-stock/v1/quotations/program-trade-by-stock","FHPPG04650100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code})
    k,v=rows(j); log(f"- 프로그램매매(종목, 시간별) FHPPG04650100: rt_cd={j.get('rt_cd')} {str(j.get('msg1'))[:40]} · {len(v)}행 · 예 "+(json.dumps(v[0],ensure_ascii=False)[:260] if v else ""))
    j=get("/uapi/domestic-stock/v1/quotations/inquire-price","FHKST01010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code})
    o=j.get("output") or {}; log(f"- 현재가: 거래대금 {o.get('acml_tr_pbmn')} · 시총 {o.get('hts_avls')} · 상장주식수 {o.get('lstn_stcn')} · 종목상태 {o.get('iscd_stat_cls_code')} · 대표시장 {o.get('rprs_mrkt_kor_name')}")
open("etf_live_probe.md","w",encoding="utf-8").write("\n".join(L))
