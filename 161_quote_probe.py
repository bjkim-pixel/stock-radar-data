# -*- coding: utf-8 -*-
"""매매 2단계용 KIS 시세 필드 점검(읽기 전용, DB 변경 없음). 호가(10단계)·현재가·체결 응답의 실제 필드명을 출력."""
import os,sys,time,json,importlib,requests
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
BASE="https://openapi.koreainvestment.com:9443"
CODE=(sys.argv[1] if len(sys.argv)>1 else "005930")
tok=importlib.import_module("72_kis_token").get_token_cached()
def call(name,path,tr,params):
    print("\n"+"="*70+f"\n## {name}  {path}  tr_id={tr}",flush=True)
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
                for row in v[:2]: print("   ",json.dumps(row,ensure_ascii=False))
            else:
                print(f"-- {k}:",json.dumps(v,ensure_ascii=False))
P={"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":CODE}
call("주식현재가 시세","/uapi/domestic-stock/v1/quotations/inquire-price","FHKST01010100",P)
call("주식현재가 호가/예상체결","/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn","FHKST01010200",P)
call("주식현재가 체결","/uapi/domestic-stock/v1/quotations/inquire-ccnl","FHKST01010300",P)
