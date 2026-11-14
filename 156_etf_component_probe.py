# -*- coding: utf-8 -*-
"""ETF 구성종목·부가정보 확인(읽기 전용): 국내 주식형 액티브 ETF 중 시총 1위(TIGER 배당커버드콜액티브 472150)."""
import os,time,json,requests,importlib,sys
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
L=[]
def log(m=""): print(m,flush=True); L.append(m)
def kget(path,tr,params):
    time.sleep(0.15)
    try: r=requests.get(B+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"}); return r.json()
    except Exception as e: return {"error":str(e)}
CODE=sys.argv[1] if len(sys.argv)>1 else "472150"
log(f"# ETF 구성종목·부가정보 점검 — {CODE}\n")
def show(title,d,keys=None,n=3):
    log(f"## {title}\n- rt_cd={d.get('rt_cd')} · msg={d.get('msg1')}")
    for k in ("output","output1","output2"):
        v=d.get(k)
        if v is None: continue
        if isinstance(v,list):
            log(f"- `{k}` 리스트 {len(v)}행. 필드: {list(v[0].keys()) if v else []}")
            for x in v[:n]: log("  "+json.dumps(x,ensure_ascii=False)[:600])
        else:
            log(f"- `{k}` 필드/값:\n```\n"+json.dumps(v,ensure_ascii=False,indent=0)[:2500]+"\n```")
    log()
# 1) 구성종목 시세
d=kget("/uapi/etfetn/v1/quotations/inquire-component-stock-price","FHKST121600C0",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE,"FID_COND_SCR_DIV_CODE":"11216"})
show("1. ETF 구성종목시세 (inquire-component-stock-price)",d,n=100)
# 2) ETF 현재가(NAV·괴리율·추적오차 등)
d=kget("/uapi/etfetn/v1/quotations/inquire-price","FHPST02400000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE}); show("2. ETF/ETN 현재가",d)
# 3) NAV 비교추이(종목)
d=kget("/uapi/etfetn/v1/quotations/nav-comparison-trend","FHPST02440000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE}); show("3. NAV 비교추이(종목)",d)
# 4) NAV 비교추이(일별)
import datetime
T=datetime.date.today()
d=kget("/uapi/etfetn/v1/quotations/nav-comparison-daily-trend","FHPST02440200",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE,"FID_INPUT_DATE_1":(T-datetime.timedelta(days=40)).strftime("%Y%m%d"),"FID_INPUT_DATE_2":T.strftime("%Y%m%d")}); show("4. NAV 비교추이(일별)",d,n=3)
# 5) 일봉(가격) 참고
d=kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice","FHKST03010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE,"FID_INPUT_DATE_1":(T-datetime.timedelta(days=10)).strftime("%Y%m%d"),"FID_INPUT_DATE_2":T.strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"}); show("5. 일봉(참고)",d,n=2)
# 6) 투자자별 매매동향(ETF도 되는지)
d=kget("/uapi/domestic-stock/v1/quotations/inquire-investor","FHKST01010900",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE}); show("6. 투자자별 매매동향(ETF)",d,n=3)
open("etf_component_probe.md","w",encoding="utf-8").write("\n".join(L))
