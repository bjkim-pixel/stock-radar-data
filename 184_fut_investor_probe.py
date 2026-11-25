# -*- coding: utf-8 -*-
"""KIS에서 코스피200 선물 투자자별(외국인) 순매수 이력을 받을 수 있는지 점검(읽기 전용)."""
import os,time,json,datetime as dt,requests,importlib
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KEY=os.environ.get("KIS_APP_KEY",""); SEC=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.25)
    try: return requests.get(B+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":tr,"custtype":"P"}).json()
    except Exception as e: return {"error":str(e)}
D=dt.date.today()
while D.weekday()>=5: D-=dt.timedelta(days=1)
BD=D.strftime("%Y%m%d")
def show(tag,j):
    o=j.get("output") or j.get("output1") or j.get("output2") or []
    o=o if isinstance(o,list) else [o]
    ds=[r.get("stck_bsop_date") for r in o if r.get("stck_bsop_date")]
    log(f"- {tag}: rt_cd={j.get('rt_cd')} msg={str(j.get('msg1') or j.get('error') or '')[:50]} · {len(o)}행"+(f" · {min(ds)}~{max(ds)}" if ds else ""))
    if o:
        r=o[0]; log("  "+json.dumps({k:r[k] for k in r if k in ("stck_bsop_date","bstp_nmix_prpr","frgn_ntby_qty","frgn_ntby_tr_pbmn","prsn_ntby_tr_pbmn","orgn_ntby_tr_pbmn")} ,ensure_ascii=False))
Q="/uapi/domestic-stock/v1/quotations/"
log(f"# KIS 선물 투자자 점검 (기준 {BD})\n## 시장별 투자자매매동향 일별(FHPTJ04040000) — 선물 코드 후보")
for iscd,sub in (("K2I","K2I"),("K2I","KSP"),("2001","KSP"),("2001","K2I"),("FUT","FUT"),("0001","K2I"),("0001","FUT"),("K200","K200"),("101","FUT")):
    show(f"ISCD={iscd} ISCD_1={sub}",kget(Q+"inquire-investor-daily-by-market","FHPTJ04040000",{"FID_COND_MRKT_DIV_CODE":"U","FID_INPUT_ISCD":iscd,"FID_INPUT_DATE_1":BD,"FID_INPUT_ISCD_1":sub,"FID_INPUT_DATE_2":BD,"FID_INPUT_ISCD_2":iscd}))
log("\n## 시장별 투자자매매동향 당일(FHPTJ04030000)")
for iscd in ("K2I","0001","2001"):
    show(f"ISCD={iscd}",kget(Q+"inquire-investor-time-by-market","FHPTJ04030000",{"FID_INPUT_ISCD":iscd,"FID_INPUT_ISCD_2":iscd}))
log("\n## 국내선물옵션 경로 후보(투자자·시세)")
FO="/uapi/domestic-futureoption/v1/quotations/"
for p,tr,pr in (("inquire-price","FHMIF10000000",{"FID_COND_MRKT_DIV_CODE":"F","FID_INPUT_ISCD":"101W12"}),
                ("inquire-daily-fuopchartprice","FHKIF03020100",{"FID_COND_MRKT_DIV_CODE":"F","FID_INPUT_ISCD":"101W12","FID_INPUT_DATE_1":"20250901","FID_INPUT_DATE_2":BD,"FID_PERIOD_DIV_CODE":"D"}),
                ("investor-trend","FHKIF10010000",{"FID_COND_MRKT_DIV_CODE":"F","FID_INPUT_ISCD":"101W12"}),
                ("inquire-investor","FHPTJ04030000",{"FID_COND_MRKT_DIV_CODE":"F","FID_INPUT_ISCD":"101W12"})):
    j=kget(FO+p,tr,pr); log(f"- {p}({tr}): rt_cd={j.get('rt_cd')} msg={str(j.get('msg1') or j.get('error') or '')[:60]} · 블록 {[k for k in j if k.startswith('output') and j[k]]}")
    for k in [k for k in j if k.startswith('output') and j[k]]:
        v=j[k] if isinstance(j[k],list) else [j[k]]; log(f"  [{k}] {len(v)}행 키: "+", ".join(list(v[0].keys())[:30]))
open("fut_investor_probe.md","w",encoding="utf-8").write("\n".join(L))
