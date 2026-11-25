# -*- coding: utf-8 -*-
"""반도체 추종 2단계 점검(읽기 전용): KIS로 공매도·신용잔고·시장 전체 투자자(연기금) 시계열을 받을 수 있는지, 값이 실제로 들어오는지 확인."""
import os,time,json,datetime as dt,requests,importlib
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KEY=os.environ.get("KIS_APP_KEY",""); SEC=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.25)
    try:
        r=requests.get(B+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":tr,"custtype":"P"})
        return r.json()
    except Exception as e: return {"error":str(e)}
def show(tag,j,n=2):
    ks=[k for k in ("output","output1","output2") if j.get(k)]
    log(f"- **{tag}** rt_cd={j.get('rt_cd')} msg={str(j.get('msg1') or j.get('error') or '')[:70]} · 블록 {ks or '-'}")
    for k in ks:
        v=j[k]; v=v if isinstance(v,list) else [v]
        log(f"  [{k}] {len(v)}행 · 키: "+", ".join(v[0].keys()))
        for r in v[:n]: log("  예: "+json.dumps(r,ensure_ascii=False)[:520])
    return j
D=dt.date.today()
while D.weekday()>=5: D-=dt.timedelta(days=1)
BD=D.strftime("%Y%m%d"); B30=(D-dt.timedelta(days=40)).strftime("%Y%m%d")
Q="/uapi/domestic-stock/v1/quotations/"
log(f"# KIS 공매도·신용·시장 투자자 점검 (기준 {BD})\n")
for code,nm in (("005930","삼성전자"),("000660","SK하이닉스"),("042700","한미반도체")):
    log(f"\n## {code} {nm}")
    show("A 공매도 일별추이(FHPST04830000)",kget(Q+"daily-short-sale","FHPST04830000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":B30,"FID_INPUT_DATE_2":BD}))
    show("B 신용잔고 일별추이(FHPST04760000)",kget(Q+"daily-credit-balance","FHPST04760000",{"FID_COND_MRKT_DIV_CODE":"J","FID_COND_SCR_DIV_CODE":"20476","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":BD}))
log("\n## 시장 전체")
for iscd,sub,nm in (("0001","KSP","코스피"),("1001","KSQ","코스닥")):
    show(f"C 시장별 투자자매매동향 일별(FHPTJ04040000) {nm}",kget(Q+"inquire-investor-daily-by-market","FHPTJ04040000",{"FID_COND_MRKT_DIV_CODE":"U","FID_INPUT_ISCD":iscd,"FID_INPUT_DATE_1":BD,"FID_INPUT_ISCD_1":sub,"FID_INPUT_DATE_2":BD,"FID_INPUT_ISCD_2":iscd}),3)
show("D 공매도 상위종목(FHPST04820000)",kget("/uapi/domestic-stock/v1/ranking/short-sale","FHPST04820000",{"FID_APLY_RANG_VOL":"0","FID_COND_MRKT_DIV_CODE":"J","FID_COND_SCR_DIV_CODE":"20482","FID_INPUT_ISCD":"0000","FID_PERIOD_DIV_CODE":"D","FID_INPUT_CNT_1":"0","FID_TRGT_EXLS_CLS_CODE":"","FID_TRGT_CLS_CODE":"","FID_APLY_RANG_PRC_1":"","FID_APLY_RANG_PRC_2":""}),2)
for p,tr,nm in (("inquire-investor-time-by-market","FHPTJ04030000","시장별 투자자 당일 시간대"),("inquire-index-daily-price","FHPUP02120000","업종 일자별")):
    show(f"E {nm}({tr})",kget(Q+p,tr,{"FID_COND_MRKT_DIV_CODE":"U","FID_INPUT_ISCD":"0001","FID_INPUT_DATE_1":BD,"FID_PERIOD_DIV_CODE":"D","FID_INPUT_ISCD_1":"KSP","FID_INPUT_ISCD_2":"0001"}),1)
open("short_probe.md","w",encoding="utf-8").write("\n".join(L))
