# -*- coding: utf-8 -*-
"""종목별 실적·예상실적 수집 → stock_earnings 업서트.
  확정 실적: KIS 손익계산서·재무비율(2023~, 분기는 누적값을 단일 분기로 환산)
  예상(컨센서스): 네이버 증권 모바일 API (isConsensus=Y 구간)
대상: stocks 중 is_active & security_type='STOCK'(시총 상위 300 유니버스). 환경변수: KIS_APP_KEY/SECRET, SUPABASE_DB_URL
"""
import os,sys,time,importlib,requests,psycopg2
from psycopg2.extras import execute_values
KIS_KEY=os.environ["KIS_APP_KEY"]; KIS_SECRET=os.environ["KIS_APP_SECRET"]
BASE="https://openapi.koreainvestment.com:9443"; FROM_YEAR=2023
LIMIT=int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 0
tok=importlib.import_module("72_kis_token").get_token_cached()
NH={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36","Referer":"https://m.stock.naver.com/"}
def num(v):
    if v is None: return None
    s=str(v).replace(",","").strip()
    if s in("","-","N/A"): return None
    try: return float(s)
    except: return None
def kis(path,tr,code,div):
    time.sleep(0.12)
    for _ in range(3):
        try:
            r=requests.get(BASE+path,params={"fid_cond_mrkt_div_code":"J","fid_input_iscd":code,"FID_DIV_CLS_CODE":div},timeout=20,
              headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
            j=r.json()
            if j.get("rt_cd")=="0": return j.get("output") or []
            if "초당" in str(j.get("msg1","")): time.sleep(1); continue
            return []
        except Exception: time.sleep(1)
    return []
def naver(code,per):
    time.sleep(0.15)
    for _ in range(3):
        try:
            r=requests.get(f"https://m.stock.naver.com/api/stock/{code}/finance/{per}",headers=NH,timeout=20)
            if r.status_code==200: return r.json().get("financeInfo") or {}
            time.sleep(1.5)
        except Exception: time.sleep(1.5)
    return {}
F=("sales","op_profit","net_income","eps","bps","roe")
def merge(d,key,vals,est,src):
    row=d.setdefault(key,{"is_est":est,"src":src,**{f:None for f in F}})
    for f,v in vals.items():
        if v is not None and (row[f] is None or src=="kis"): row[f]=v
    if est: row["is_est"]=True
def build(code):
    out={}
    # 1) 네이버(실적+컨센서스)
    for per,fq in(("annual","A"),("quarter","Q")):
        fi=naver(code,per); cols=fi.get("trTitleList") or []; rows={r.get("title"):r.get("columns",{}) for r in fi.get("rowList",[])}
        for c in cols:
            k=c["key"]
            if int(k[:4])<FROM_YEAR: continue
            g=lambda t:num((rows.get(t,{}).get(k) or {}).get("value"))
            merge(out,(fq,k),{"sales":g("매출액"),"op_profit":g("영업이익"),"net_income":g("당기순이익"),"eps":g("EPS"),"roe":g("ROE")},c.get("isConsensus")=="Y","naver")
    # 2) KIS 확정 실적 (네이버보다 우선: 매출·영업이익·순이익·EPS·BPS·ROE)
    ia=kis("/uapi/domestic-stock/v1/finance/income-statement","FHKST66430200",code,"0")
    ra=kis("/uapi/domestic-stock/v1/finance/financial-ratio","FHKST66430300",code,"0")
    iq=kis("/uapi/domestic-stock/v1/finance/income-statement","FHKST66430200",code,"1")
    rq=kis("/uapi/domestic-stock/v1/finance/financial-ratio","FHKST66430300",code,"1")
    rma={r["stac_yymm"]:r for r in ra}
    for r in ia:
        k=r["stac_yymm"]
        if k[4:]!="12" or int(k[:4])<FROM_YEAR: continue
        f=rma.get(k,{})
        merge(out,("A",k),{"sales":num(r.get("sale_account")),"op_profit":num(r.get("bsop_prti")),"net_income":num(r.get("thtr_ntin")),
            "eps":num(f.get("eps")),"bps":num(f.get("bps")),"roe":num(f.get("roe_val"))},False,"kis")
    cum={r["stac_yymm"]:r for r in iq}; rmq={r["stac_yymm"]:r for r in rq}
    for k,r in cum.items():
        y,m=int(k[:4]),int(k[4:])
        if y<FROM_YEAR or m not in(3,6,9,12): continue
        prev=cum.get(f"{y}{m-3:02d}") if m>3 else None
        pf=rmq.get(f"{y}{m-3:02d}") if m>3 else None
        if m>3 and prev is None: continue   # 직전 분기 누적이 없으면 단일 분기 환산 불가
        f=rmq.get(k,{})
        def dif(a,b):
            x,z=num(a),num(b) if b is not None else 0.0
            return None if x is None or z is None else x-z
        vals={"sales":dif(r.get("sale_account"),prev.get("sale_account") if prev else None),
              "op_profit":dif(r.get("bsop_prti"),prev.get("bsop_prti") if prev else None),
              "net_income":dif(r.get("thtr_ntin"),prev.get("thtr_ntin") if prev else None),
              "eps":dif(f.get("eps"),pf.get("eps") if pf else None) if f else None,"bps":num(f.get("bps")) if f else None}
        merge(out,("Q",k),vals,False,"kis")
    return out
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"125_earnings.sql"),encoding="utf-8").read())
cur.execute("select code from stocks where is_active and security_type='STOCK' order by code")
codes=[r[0] for r in cur.fetchall()]
if LIMIT: codes=codes[:LIMIT]
print("대상",len(codes),"종목",flush=True)
ok=fail=nrows=est=0; failed=[]
for i,code in enumerate(codes,1):
    try:
        d=build(code)
        if not d: raise RuntimeError("no data")
        vals=[(code,fq,k,v["is_est"],*[v[f] for f in F],v["src"]) for (fq,k),v in d.items()]
        execute_values(cur,"""insert into stock_earnings(code,freq,period,is_est,sales,op_profit,net_income,eps,bps,roe,src) values %s
          on conflict(code,freq,period) do update set is_est=excluded.is_est,sales=excluded.sales,op_profit=excluded.op_profit,
          net_income=excluded.net_income,eps=excluded.eps,bps=excluded.bps,roe=excluded.roe,src=excluded.src,updated_at=now()""",vals)
        ok+=1; nrows+=len(vals); est+=sum(1 for v in vals if v[3])
    except Exception as e:
        fail+=1; failed.append(code); print("FAIL",code,e,flush=True)
    if i%50==0: print(f"{i}/{len(codes)} ok={ok} fail={fail}",flush=True)
cur.execute("select count(*),count(distinct code),sum(case when is_est then 1 else 0 end),pg_size_pretty(pg_total_relation_size('stock_earnings')) from stock_earnings")
t=cur.fetchone()
rep=f"# 실적 수집 결과\n- 대상 {len(codes)}종목 · 성공 {ok} · 실패 {fail}\n- 이번 업서트 {nrows}행(예상 {est}행)\n- 테이블 총 {t[0]}행 · {t[1]}종목 · 예상 {t[2]}행 · 크기 {t[3]}\n- 실패 종목: {', '.join(failed[:60]) or '없음'}\n"
cur.execute("select code,freq,period,is_est,sales,op_profit,net_income,eps,bps,roe from stock_earnings where code='000660' order by freq,period")
rep+="\n## 000660 샘플\n```\n"+"\n".join(str(r) for r in cur.fetchall())+"\n```\n"
open("earnings_report.md","w",encoding="utf-8").write(rep); print(rep)
