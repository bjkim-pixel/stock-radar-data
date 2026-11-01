# -*- coding: utf-8 -*-
"""KIS 장내채권 API 사용 가능성 점검 (읽기 전용 GET만, DB/사이트 변경 없음).
어떤 엔드포인트가 이 앱키로 응답하는지, 이자율·수익률·만기·신용등급 필드가 채워지는지 기록."""
import os, sys, time, json, datetime, requests, zipfile, io
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
KIS_BASE="https://openapi.koreainvestment.com:9443"
L=[]
def log(m=""):
    print(m,flush=True); L.append(m)
def get_token():
    t=os.environ.get("KIS_ACCESS_TOKEN","").strip()
    if t: return t
    import importlib
    return importlib.import_module("72_kis_token").get_token_cached()
log(f"# KIS 채권 API 점검 ({datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC)\n")
try: tok=get_token(); log("- 토큰: OK")
except Exception as e: tok=None; log(f"- 토큰 실패: {str(e)[:150]}")
def kget(path,tr,params):
    time.sleep(0.2)
    try:
        r=requests.get(KIS_BASE+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
        try: return r.status_code,r.json()
        except Exception: return r.status_code,{"raw":r.text[:200]}
    except Exception as e: return 0,{"raw":str(e)[:150]}
def show(d,n=40):
    out=[]
    for k in ("output","output1","output2"):
        o=d.get(k)
        if isinstance(o,list): out.append(f"{k}=list[{len(o)}]"); o=o[0] if o else None
        if isinstance(o,dict):
            filled={a:b for a,b in o.items() if str(b).strip() not in ("","0","0.000000","0.0000")}
            out.append(f"{k} 필드 {len(o)}개(값있음 {len(filled)}): "+json.dumps(dict(list(filled.items())[:n]),ensure_ascii=False))
    return " | ".join(out) or str(d)[:200]
# 1) 채권 코드 후보 확보: KIS 마스터 파일 시도
codes=[]
log("## 1) 채권 종목 코드 확보")
for url in ("https://new.real.download.dws.co.kr/common/master/bond_code.mst.zip","https://new.real.download.dws.co.kr/common/master/bondmst.zip"):
    try:
        r=requests.get(url,timeout=20); log(f"- {url.split('/')[-1]}: HTTP {r.status_code} {len(r.content)}B")
        if r.status_code==200 and r.content[:2]==b"PK":
            z=zipfile.ZipFile(io.BytesIO(r.content)); nm=z.namelist()[0]; raw=z.read(nm).decode("cp949","ignore")
            lines=[x for x in raw.splitlines() if x.strip()]; log(f"  - {nm}: {len(lines)}행 · 예: {lines[:3]}")
            for x in lines[:4000]:
                import re
                m=re.search(r"KR[0-9A-Z]{10}",x)
                if m: codes.append(m.group(0))
    except Exception as e: log(f"- {url.split('/')[-1]}: 예외 {str(e)[:80]}")
codes=list(dict.fromkeys(codes))
log(f"- 마스터에서 추출한 코드 {len(codes)}개 · 예 {codes[:5]}")
cand=codes[:3]+[c for c in ("KR103502GD93","KR103501G988","KR101501DB94","KR6005931A66") if c not in codes]
if tok:
    log("\n## 2) 채권 기본/발행정보")
    good=None
    for c in cand[:8]:
        for pt in ("300","302"):
            st,d=kget("/uapi/domestic-bond/v1/quotations/search-bond-info","CTPF1114R",{"PDNO":c,"PRDT_TYPE_CD":pt})
            log(f"- search-bond-info {c}/{pt}: HTTP {st} rt_cd={d.get('rt_cd')} msg={str(d.get('msg1',d.get('raw','')))[:70]}")
            if d.get("rt_cd")=="0" and d.get("output"):
                log("  - "+show(d)); good=(c,pt); break
        if good: break
    st,d=kget("/uapi/domestic-bond/v1/quotations/issue-info","CTPF1101R",{"PDNO":(good or (cand[0],"300"))[0],"PRDT_TYPE_CD":(good or (cand[0],"300"))[1]})
    log(f"- issue-info: HTTP {st} rt_cd={d.get('rt_cd')} msg={str(d.get('msg1',d.get('raw','')))[:70]}"); log("  - "+show(d))
    log("\n## 3) 시세(현재가·호가·체결·일별·차트)")
    pn=(good or (cand[0],"300"))[0]
    for nm,path,tr,p in (
        ("현재가(시세)","inquire-price","FHKBJ773400C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":pn}),
        ("현재가(호가)","inquire-asking-price","FHKBJ773401C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":pn}),
        ("현재가(체결)","inquire-ccnl","FHKBJ773403C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":pn}),
        ("현재가(일별)","inquire-daily-price","FHKBJ773404C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":pn}),
        ("기간별시세(일)","inquire-daily-itemchartprice","FHKBJ773701C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":pn,"FID_INPUT_DATE_1":(datetime.date.today()-datetime.timedelta(days=60)).strftime("%Y%m%d"),"FID_INPUT_DATE_2":datetime.date.today().strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D"}),
        ("평균단가","avg-unit","CTPF2005R",{"INQR_STRT_DT":(datetime.date.today()-datetime.timedelta(days=7)).strftime("%Y%m%d"),"INQR_END_DT":datetime.date.today().strftime("%Y%m%d"),"PDNO":pn,"PRDT_TYPE_CD":"300","VRFC_KIND_CD":"00","CTX_AREA_NK30":"","CTX_AREA_FK100":""}),
    ):
        st,d=kget("/uapi/domestic-bond/v1/quotations/"+path,tr,p)
        log(f"- {nm} ({tr}): HTTP {st} rt_cd={d.get('rt_cd')} msg={str(d.get('msg1',d.get('raw','')))[:70]}"); log("  - "+show(d))
    log("\n## 4) 금리 종합(국내채권/금리)")
    for tr,path in (("FHPST07020000","comp-interest"),):
        st,d=kget("/uapi/domestic-stock/v1/quotations/"+path,tr,{"FID_COND_MRKT_DIV_CODE":"I","FID_COND_SCR_DIV_CODE":"20702","FID_DIV_CLS_CODE":"1","FID_DIV_CLS_CODE1":""})
        log(f"- 금리종합 {tr}: HTTP {st} rt_cd={d.get('rt_cd')} msg={str(d.get('msg1',d.get('raw','')))[:70]}"); log("  - "+show(d,12))
        for k in ("output1","output2"):
            o=d.get(k)
            if isinstance(o,list):
                for row in o[:25]: log("    · "+json.dumps(row,ensure_ascii=False)[:230])
open(sys.argv[sys.argv.index('--report')+1] if '--report' in sys.argv else 'bond_probe_report.md','w',encoding='utf-8').write("\n".join(L))
