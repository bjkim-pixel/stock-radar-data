# -*- coding: utf-8 -*-
"""종목별 실적·예상실적 수집 → stock_earnings 업서트. 사용법: python 125_earnings_collect.py <est|actual> [종목수 제한]
  actual : KIS 확정 실적(손익계산서·재무비율, 분기는 누적→단일 분기 환산). 실적 시즌(5·8·11월 1~20일, 2~3월, 4월 초)에만 실행.
           ★ 확정 구간(분기 2026Q2 이하, 연간 2025 이하)은 DB 값을 더 이상 API로 갱신하지 않음 — 이미 저장된 확정 행은 절대 덮어쓰지 않고,
             그 구간 행이 하나도 없는 신규 종목만 한 번 채움(예상(E)로 남은 행은 확정값으로 교체).
  est    : 네이버 컨센서스(isConsensus=Y) 예상치만 평일 매일. 확정(is_est=false) 행은 건드리지 않음.
대상: stocks 중 is_active & security_type='STOCK'. 환경변수: KIS_APP_KEY/SECRET(actual), SUPABASE_DB_URL
"""
import os,sys,time,importlib,requests,psycopg2
from psycopg2.extras import execute_values
MODE=sys.argv[1] if len(sys.argv)>1 and sys.argv[1] in("est","actual") else "est"
LIMIT=int(sys.argv[2]) if len(sys.argv)>2 and sys.argv[2].isdigit() else 0
KIS_KEY=KIS_SECRET=tok=None
if MODE=="actual":
    KIS_KEY=os.environ["KIS_APP_KEY"]; KIS_SECRET=os.environ["KIS_APP_SECRET"]
    tok=importlib.import_module("72_kis_token").get_token_cached()
BASE="https://openapi.koreainvestment.com:9443"; FROM_YEAR=2023
FROZEN_Q="202606"; FROZEN_A="202512"      # 이 기간 이하 확정 실적은 DB 값 고정(갱신 안 함)
def frozen(fq,k): return k<=(FROZEN_Q if fq=="Q" else FROZEN_A)
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
def build(code,full):
    """full=True: 네이버 실적 포함 전 구간(신규 종목 최초 적재). False: 확정 구간 제외"""
    out={}
    # 1) 네이버(실적+컨센서스) — actual 모드에서는 full(신규 종목)일 때만, est 모드에서는 컨센서스 열만
    for per,fq in(("annual","A"),("quarter","Q")):
        if MODE=="actual" and not full: continue
        fi=naver(code,per); cols=fi.get("trTitleList") or []; rows={r.get("title"):r.get("columns",{}) for r in fi.get("rowList",[])}
        for c in cols:
            k=c["key"]
            if int(k[:4])<FROM_YEAR: continue
            if MODE=="est" and c.get("isConsensus")!="Y": continue
            g=lambda t:num((rows.get(t,{}).get(k) or {}).get("value"))
            merge(out,(fq,k),{"sales":g("매출액"),"op_profit":g("영업이익"),"net_income":g("당기순이익"),"eps":g("EPS"),"roe":g("ROE")},c.get("isConsensus")=="Y","naver")
    if MODE=="est": return out
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
    if not full: out={k:v for k,v in out.items() if not frozen(*k)}   # 확정 구간은 쓰지 않음
    return out
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"125_earnings.sql"),encoding="utf-8").read())
cur.execute("select code from stocks where is_active and security_type='STOCK' order by code")
codes=[r[0] for r in cur.fetchall()]
if LIMIT: codes=codes[:LIMIT]
print("대상",len(codes),"종목",flush=True)
# 확정 구간 행이 하나도 없는 종목 = 신규 종목 → actual 모드에서 한 번만 전 구간 적재
cur.execute("select distinct code from stock_earnings where (freq='Q' and period<=%s) or (freq='A' and period<=%s)",(FROZEN_Q,FROZEN_A))
have=set(r[0] for r in cur.fetchall())
ok=fail=nrows=est=0; failed=[]; newc=0
# 덮어쓰기 규칙: est 모드=기존 예상(E) 행만 / actual 모드=예상(E) 행이거나 확정 구간 밖(2026Q3~, 2026 연간~) 행
COND="stock_earnings.is_est" if MODE=="est" else "(stock_earnings.is_est or (stock_earnings.freq='Q' and stock_earnings.period>'%s') or (stock_earnings.freq='A' and stock_earnings.period>'%s'))"%(FROZEN_Q,FROZEN_A)
for i,code in enumerate(codes,1):
    try:
        full=(MODE=="actual" and code not in have)
        newc+=full
        d=build(code,full)
        if not d:
            if MODE=="est" or not full: ok+=1; continue     # 컨센서스 없음 / 새로 공시된 분기 없음은 정상
            raise RuntimeError("no data")
        vals=[(code,fq,k,v["is_est"],*[v[f] for f in F],v["src"]) for (fq,k),v in d.items()]
        execute_values(cur,"""insert into stock_earnings(code,freq,period,is_est,sales,op_profit,net_income,eps,bps,roe,src) values %s
          on conflict(code,freq,period) do update set is_est=excluded.is_est,sales=excluded.sales,op_profit=excluded.op_profit,
          net_income=excluded.net_income,eps=excluded.eps,bps=excluded.bps,roe=excluded.roe,src=excluded.src,updated_at=now()
          where """+COND,vals)
        ok+=1; nrows+=len(vals); est+=sum(1 for v in vals if v[3])
    except Exception as e:
        fail+=1; failed.append(code); print("FAIL",code,e,flush=True)
    if i%50==0: print(f"{i}/{len(codes)} ok={ok} fail={fail}",flush=True)
cur.execute("select count(*),count(distinct code),sum(case when is_est then 1 else 0 end),pg_size_pretty(pg_total_relation_size('stock_earnings')) from stock_earnings")
t=cur.fetchone()
rep=f"# 실적 수집 결과 ({MODE})\n- 신규 종목 전 구간 적재 {newc}종목\n- 대상 {len(codes)}종목 · 성공 {ok} · 실패 {fail}\n- 이번 업서트 {nrows}행(예상 {est}행)\n- 테이블 총 {t[0]}행 · {t[1]}종목 · 예상 {t[2]}행 · 크기 {t[3]}\n- 실패 종목: {', '.join(failed[:60]) or '없음'}\n"
cur.execute("select code,freq,period,is_est,sales,op_profit,net_income,eps,bps,roe from stock_earnings where code=%s order by freq,period",("000660" if "000660" in codes else codes[0],))
rep+="\n## 샘플\n```\n"+"\n".join(str(r) for r in cur.fetchall())+"\n```\n"
open(f"earnings_{MODE}_report.md","w",encoding="utf-8").write(rep); print(rep)
