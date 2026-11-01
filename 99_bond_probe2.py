# -*- coding: utf-8 -*-
"""KIS 채권 2차 점검(읽기 전용): 거래되는 국고채·회사채·금융채 등에서 표면금리/수익률/등급이 채워지는지."""
import os,sys,time,json,datetime,re,zipfile,io,requests
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
KIS_BASE="https://openapi.koreainvestment.com:9443"
L=[]
def log(m=""): print(m,flush=True); L.append(m)
import importlib
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.2)
    try:
        r=requests.get(KIS_BASE+"/uapi/domestic-bond/v1/quotations/"+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
        return r.json()
    except Exception as e: return {"rt_cd":"x","msg1":str(e)[:80]}
log(f"# KIS 채권 2차 점검 ({datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC)\n")
raw=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/bond_code.mst.zip",timeout=30).content))
raw=raw.read(raw.namelist()[0]).decode("cp949","ignore").splitlines()
today=datetime.date.today().strftime("%Y%m%d")
rows=[]
for x in raw:
    m=re.search(r"KR[0-9A-Z]{10}",x)
    if not m: continue
    code=m.group(0); rest=x[m.end():]
    nm=re.match(r"(.{0,40}?)\s{2,}",rest+"  "); nm=(nm.group(1) if nm else rest[:30]).strip()
    d=re.findall(r"\d{8}",rest)
    mat=max(d) if d else ""
    if mat and mat<today: continue
    rows.append((x[:2],code,nm,mat))
log(f"- 마스터 {len(raw)}행 · 만기 미도래 {len(rows)}개; 앞 2글자 분포: "+json.dumps({k:sum(1 for r in rows if r[0]==k) for k in sorted({r[0] for r in rows})}))
cats={"국고채":lambda n:n.startswith("국고"),"소매(A0)":lambda n:False,"한전/산금/기금":lambda n:re.search("한국전력|산금|산업|예보|주택금융|토지|도로|철도|가스|공사",n),"회사채":lambda n:re.search("삼성|현대|SK|LG|롯데|포스코|신한|KB|하나|우리|한화|CJ|GS|두산|대한항공",n)}
pick=[]
for cat,f in cats.items():
    c=[r for r in rows if (r[0]=="A0" if cat=="소매(A0)" else f(r[2]))][:6]
    log(f"- 후보 {cat}: {len(c)}개 예 {[ (r[1],r[2][:14],r[3]) for r in c[:3]]}")
    pick+= [(cat,)+r for r in c]
if not pick: pick=[("기타",)+r for r in rows[:12]]
log("\n## 종목별 결과 (표면금리 / 현재가 / 수익률 / 매수·매도호가 수익률 / 등급)")
for cat,tp,code,nm,mat in pick:
    out={"cat":cat,"code":code,"name":nm,"mat":mat}
    for pt in ("302","300"):
        d=kget("search-bond-info","CTPF1114R",{"PDNO":code,"PRDT_TYPE_CD":pt})
        if d.get("rt_cd")=="0" and d.get("output"):
            o=d["output"]; out["pt"]=pt
            out["coupon"]=o.get("ksd_rcvg_bond_srfc_inrt"); out["이자지급"]=o.get("int_caltm_mcnt"); out["만기수익"]=o.get("bond_expd_asrc_erng_rt")
            out["등급필드"]={k:v for k,v in o.items() if "grad" in k and str(v).strip()}
            break
    d=kget("issue-info","CTPF1101R",{"PDNO":code,"PRDT_TYPE_CD":out.get("pt","302")}); o=d.get("output") or {}
    out["발행액"]=o.get("issu_amt"); out["issue등급"]={k:v for k,v in o.items() if "grad" in k and str(v).strip()}; out["issue표면"]=o.get("srfc_inrt")
    d=kget("inquire-price","FHKBJ773400C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":code}); o=d.get("output") or {}
    out["현재가"]=o.get("bond_prpr"); out["수익률"]=o.get("ernn_rate")
    d=kget("inquire-asking-price","FHKBJ773401C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":code}); o=d.get("output") or {}
    out["매수1수익률"]=o.get("shnu_ernn_rate1"); out["매도1수익률"]=o.get("seln_ernn_rate1"); out["매도1호가"]=o.get("bond_askp1")
    d=kget("avg-unit","CTPF2005R",{"INQR_STRT_DT":(datetime.date.today()-datetime.timedelta(days=10)).strftime("%Y%m%d"),"INQR_END_DT":today,"PDNO":code,"PRDT_TYPE_CD":out.get("pt","302"),"VRFC_KIND_CD":"00","CTX_AREA_NK30":"","CTX_AREA_FK100":""})
    ou=d.get("output") if isinstance(d.get("output"),list) else d.get("output1")
    out["평균단가"]=(json.dumps(ou[0],ensure_ascii=False)[:300] if ou else f"rt={d.get('rt_cd')} {str(d.get('msg1'))[:30]}")
    log("- "+json.dumps(out,ensure_ascii=False))
open('bond_probe2_report.md','w',encoding='utf-8').write("\n".join(L))
