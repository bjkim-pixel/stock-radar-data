# -*- coding: utf-8 -*-
"""배당 정보 소스 점검(읽기 전용, DB 변경 없음): KIS 예탁원 배당일정·배당률상위 / 네이버 모바일 API·PC 메인."""
import os,sys,time,json,re,importlib,requests
CODE=sys.argv[1] if len(sys.argv)>1 else "005930"
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
BASE="https://openapi.koreainvestment.com:9443"
tok=importlib.import_module("72_kis_token").get_token_cached()
def kis(name,path,tr,params):
    print("\n"+"="*70+f"\n## KIS {name}  {path}  tr_id={tr}\nparams={params}",flush=True)
    time.sleep(0.4)
    try:
        r=requests.get(BASE+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8",
            "authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
        j=r.json()
    except Exception as e:
        print("ERR",e);return
    print("http",r.status_code,"rt_cd",j.get("rt_cd"),"msg",j.get("msg1"))
    for k,v in j.items():
        if k.startswith("output"):
            if isinstance(v,list):
                print(f"-- {k}: list[{len(v)}]")
                for row in v[:5]: print("   ",json.dumps(row,ensure_ascii=False))
            else: print(f"-- {k}:",json.dumps(v,ensure_ascii=False))
kis("예탁원 배당일정(종목)","/uapi/domestic-stock/v1/ksdinfo/dividend","HHKDB669102C0",
    {"CTS":"","GB1":"0","F_DT":"20240101","T_DT":"20261231","SHT_CD":CODE,"HIGH_GB":""})
kis("예탁원 배당일정(전체 기간 일부)","/uapi/domestic-stock/v1/ksdinfo/dividend","HHKDB669102C0",
    {"CTS":"","GB1":"0","F_DT":"20261101","T_DT":"20261231","SHT_CD":"","HIGH_GB":""})
kis("배당률 상위","/uapi/domestic-stock/v1/ranking/dividend-rate","HHKDB13470100",
    {"CTS_AREA":"","GB1":"1","UPJONG":"0001","GB2":"0","GB3":"2","F_DT":"20250101","T_DT":"20251231","GB4":"0"})
kis("재무비율(배당 필드 있나)","/uapi/domestic-stock/v1/finance/financial-ratio","FHKST66430300",
    {"fid_cond_mrkt_div_code":"J","fid_input_iscd":CODE,"FID_DIV_CLS_CODE":"0"})
kis("현재가 시세(배당 필드 있나)","/uapi/domestic-stock/v1/quotations/inquire-price","FHKST01010100",
    {"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE})
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36","Referer":"https://m.stock.naver.com/"}
def get(name,url):
    print("\n"+"="*70+f"\n## {name}\n{url}",flush=True)
    try: r=requests.get(url,headers=H,timeout=20)
    except Exception as e: print("ERR",e);return None
    print("http",r.status_code,"len",len(r.content)); return r
r=get("네이버 모바일 integration",f"https://m.stock.naver.com/api/stock/{CODE}/integration")
if r is not None and r.status_code==200:
    j=r.json(); print("keys",list(j.keys()))
    for t in j.get("totalInfos",[]):
        if any(w in json.dumps(t,ensure_ascii=False) for w in ["배당","dividend","Dividend"]): print("  totalInfos:",json.dumps(t,ensure_ascii=False))
    for k,v in j.items():
        s=json.dumps(v,ensure_ascii=False)
        if "배당" in s and k!="totalInfos": print("  배당 포함 키:",k,s[:600])
for per in ["annual","quarter"]:
    r=get(f"네이버 모바일 finance/{per}",f"https://m.stock.naver.com/api/stock/{CODE}/finance/{per}")
    if r is not None and r.status_code==200:
        fi=r.json().get("financeInfo",{})
        print("기간:",[t.get("title") for t in fi.get("trTitleList",[])])
        for row in fi.get("rowList",[]):
            if any(w in str(row.get("title")) for w in ["배당","DPS","dps"]): print(" ",row.get("title"),{k:v.get("value") for k,v in row.get("columns",{}).items()})
        print("  전체 행 제목:",[row.get("title") for row in fi.get("rowList",[])])
r=get("네이버 PC 메인",f"https://finance.naver.com/item/main.naver?code={CODE}")
if r is not None and r.status_code==200:
    t=r.content.decode("euc-kr","ignore"); txt=re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",t))
    for m in re.finditer(r"(배당수익률|주당배당금|시가배당률|배당성향)",txt): print("  PC:",txt[max(0,m.start()-30):m.start()+120]); 
