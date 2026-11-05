import os, subprocess, requests, json, sys
out=[]
def log(m): print(m,flush=True); out.append(str(m))
H={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json"}
log("## Naver")
for c in ["VKOSPI","KSVKOSPI","KOSPI_VOLATILITY","VKOSPI200"]:
    for ep in ["basic","price?pageSize=3&page=1"]:
        try:
            r=requests.get(f"https://m.stock.naver.com/api/index/{c}/{ep}",headers=H,timeout=15)
            log(f"- {c}/{ep}: {r.status_code} {r.text[:250]}")
        except Exception as e: log(f"- {c}/{ep}: ERR {e}")
log("## KIS")
tok=subprocess.run([sys.executable,"72_kis_token.py"],capture_output=True,text=True).stdout.strip()
K,S=os.environ["KIS_APP_KEY"],os.environ["KIS_APP_SECRET"]
base="https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/"
def h(tr): return {"authorization":f"Bearer {tok}","appkey":K,"appsecret":S,"tr_id":tr,"custtype":"P"}
import datetime
d=datetime.date.today().strftime("%Y%m%d")
for iscd in ["0001","0101","0201","VKOSPI","1101","3001","4001","5001"]:
    for path,tr,p in [("inquire-index-price","FHPUP02100000",{"FID_COND_MRKT_DIV_CODE":"U","FID_INPUT_ISCD":iscd}),
                      ("inquire-index-daily-price","FHPUP02120000",{"FID_PERIOD_DIV_CODE":"D","FID_COND_MRKT_DIV_CODE":"U","FID_INPUT_ISCD":iscd,"FID_INPUT_DATE_1":d})]:
        try:
            r=requests.get(base+path,headers=h(tr),params=p,timeout=15); j=r.json()
            o=j.get("output") or j.get("output1")
            log(f"- {iscd} {path}: {r.status_code} rt={j.get('rt_cd')} {j.get('msg1','')} | {str(o)[:200]}")
        except Exception as e: log(f"- {iscd} {path}: ERR {e}")
open("vkospi_report.md","w").write("\n".join(out))
