# -*- coding: utf-8 -*-
"""KIS로 ETF 수급·NAV·좌수 정보를 얻을 수 있는지 점검(읽기 전용). 종목별 투자자 수급이 ETF에서 값이 나오는지가 핵심."""
import os,time,json,datetime as dt,requests,importlib
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KEY=os.environ.get("KIS_APP_KEY",""); SEC=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.2)
    try:
        r=requests.get(B+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":tr,"custtype":"P"})
        return r.json()
    except Exception as e: return {"error":str(e)}
def rows(j):
    for k in ("output","output1","output2"):
        v=j.get(k)
        if isinstance(v,list) and v: return k,v
        if isinstance(v,dict) and v: return k,[v]
    return None,[]
def show(tag,j,pick=None):
    k,v=rows(j)
    log(f"- **{tag}** rt_cd={j.get('rt_cd')} msg={str(j.get('msg1') or j.get('error') or '')[:60]} · {k or '-'} {len(v)}행")
    if v and len(v)>1:
        ne=[r for r in v if any(r.get(k) not in (None,"","0","0.00") for k in r if "ntby" in k)]
        log(f"  수급값 있는 날 {len(ne)}/{len(v)}")
        if ne: log("  최근 값 있는 행: "+json.dumps({a:ne[0][a] for a in ne[0] if a in ("stck_bsop_date","stck_clpr","prsn_ntby_qty","frgn_ntby_qty","orgn_ntby_qty","prsn_ntby_tr_pbmn","frgn_ntby_tr_pbmn","orgn_ntby_tr_pbmn")},ensure_ascii=False))
    if v:
        log("  키: "+", ".join(v[0].keys()))
        x={a:b for a,b in v[0].items() if (not pick or a in pick)}
        log("  예: "+json.dumps(x,ensure_ascii=False)[:420])
    return v
D=dt.date.today()
while D.weekday()>=5: D-=dt.timedelta(days=1)
BD=D.strftime("%Y%m%d")
ETF=[("069500","KODEX 200"),("360750","TIGER 미국S&P500"),("122630","KODEX 레버리지"),("091160","KODEX 반도체")]
log(f"# KIS ETF 수급·NAV 점검 (기준 {BD})\n")
for code,nm in ETF:
    log(f"\n## {code} {nm}")
    J=lambda p,t,pr:kget("/uapi/domestic-stock/v1/quotations/"+p,t,pr)
    v=show("A 종목별 투자자 일별(FHPTJ04160001: 시세+수급 30일)",J("investor-trade-by-stock-daily","FHPTJ04160001",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":BD,"FID_ORG_ADJ_PRC":"0","FID_ETC_CLS_CODE":"0"}))
    o2=J("investor-trade-by-stock-daily","FHPTJ04160001",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":(D-dt.timedelta(days=1)).strftime("%Y%m%d"),"FID_ORG_ADJ_PRC":"0","FID_ETC_CLS_CODE":"0"}).get("output2") or []
    log(f"  A output2(일별) {len(o2)}행"+(" 예: "+json.dumps(o2[0],ensure_ascii=False)[:420] if o2 else ""))
    if v:
        fl=[k for k in v[0] if "ntby" in k]
        nz=sum(1 for r in v for k in fl if r.get(k) not in (None,"","0","0.00"))
        log(f"  수급 필드 {len(fl)}개 · 0 아닌 값 {nz}/{len(v)*max(1,len(fl))}")
    show("B 투자자 현재(FHKST01010900)",J("inquire-investor","FHKST01010900",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code}))
    E=lambda p,t,pr:kget("/uapi/etfetn/v1/quotations/"+p,t,pr)
    show("C ETF 현재가(NAV·괴리율·좌수)",E("inquire-price","FHPST02400000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code}))
    show("D NAV 비교추이 일별",E("nav-comparison-daily-trend","FHPST02440200",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":(D-dt.timedelta(days=30)).strftime("%Y%m%d"),"FID_INPUT_DATE_2":BD}))
    show("E 프로그램매매 일별",J("program-trade-by-stock-daily","FHPPG04650201",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":BD}))
    if code!=ETF[0][0] and code!="360750": pass
open("kis_etf_flow_probe.md","w",encoding="utf-8").write("\n".join(L))
