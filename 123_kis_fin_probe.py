# -*- coding: utf-8 -*-
"""KIS 실적/추정실적/투자의견 API 점검(읽기 전용, DB 변경 없음). 한 종목의 원본 응답 구조를 그대로 출력."""
import os,sys,time,json,importlib,requests
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
BASE="https://openapi.koreainvestment.com:9443"
CODE=(sys.argv[1] if len(sys.argv)>1 else "000660")
tok=importlib.import_module("72_kis_token").get_token_cached()
def call(name,path,tr,params):
    print("\n"+"="*70+f"\n## {name}  {path}  tr_id={tr}  params={params}",flush=True)
    time.sleep(0.3)
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
                for row in v[:6]: print("   ",json.dumps(row,ensure_ascii=False))
            else:
                print(f"-- {k}:",json.dumps(v,ensure_ascii=False))
P={"fid_cond_mrkt_div_code":"J","fid_input_iscd":CODE}
call("손익계산서(연간)","/uapi/domestic-stock/v1/finance/income-statement","FHKST66430200",{**P,"FID_DIV_CLS_CODE":"0"})
call("손익계산서(분기)","/uapi/domestic-stock/v1/finance/income-statement","FHKST66430200",{**P,"FID_DIV_CLS_CODE":"1"})
call("종목추정실적","/uapi/domestic-stock/v1/quotations/estimate-perform","HHKST668300C0",{"SHT_CD":CODE})
call("종목투자의견","/uapi/domestic-stock/v1/quotations/invest-opinion","FHKST663300C0",
     {"FID_COND_MRKT_DIV_CODE":"J","FID_COND_SCR_DIV_CODE":"16633","FID_INPUT_ISCD":CODE,"FID_INPUT_DATE_1":"20250101","FID_INPUT_DATE_2":"20261108"})
call("증권사별투자의견","/uapi/domestic-stock/v1/quotations/invest-opbysec","FHKST663400C0",
     {"FID_COND_MRKT_DIV_CODE":"J","FID_COND_SCR_DIV_CODE":"16634","FID_INPUT_ISCD":"99999","FID_DIV_CLS_CODE":"0","FID_INPUT_DATE_1":"20261001","FID_INPUT_DATE_2":"20261108"})
call("성장성비율","/uapi/domestic-stock/v1/finance/growth-ratio","FHKST66430800",{**P,"FID_DIV_CLS_CODE":"0"})
call("재무비율","/uapi/domestic-stock/v1/finance/financial-ratio","FHKST66430300",{**P,"FID_DIV_CLS_CODE":"0"})
