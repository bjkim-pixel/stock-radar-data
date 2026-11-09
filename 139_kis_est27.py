# -*- coding: utf-8 -*-
"""KIS 종목추정실적(estimate-perform, HHKST668300C0) → stock_earnings 연간 예상(2027.12E 등, 네이버 컨센서스가 아직 없는 해)만 저장.
- 한 증권사(애널리스트) 최신 보고서 추정치임: est_by(애널리스트)·est_date(보고서일)와 함께 src='kis_est'로 저장.
- 값 배율: KIS EPS·ROE·증감률은 10배 값으로 내려옴 → 확정 2025 열을 DB 2025 값과 비교해 배율(10 또는 1)을 종목별로 검증. 어긋나면 그 종목은 건너뜀.
- 네이버 컨센서스(src='naver')가 이미 있는 연도는 덮어쓰지 않음. 사용법: python 139_kis_est27.py [종목수 제한]"""
import os,sys,time,importlib,requests,psycopg2
from psycopg2.extras import execute_values
LIMIT=int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 0
KEY=os.environ["KIS_APP_KEY"]; SEC=os.environ["KIS_APP_SECRET"]
tok=importlib.import_module("72_kis_token").get_token_cached()
URL="https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/estimate-perform"
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute("alter table public.stock_earnings add column if not exists est_by text, add column if not exists est_date date")
cur.execute("select code from stocks where is_active and security_type='STOCK' order by code"); codes=[r[0] for r in cur.fetchall()]
if LIMIT: codes=codes[:LIMIT]
cur.execute("select code,eps,sales from stock_earnings where freq='A' and period='202512' and not is_est"); base={r[0]:(r[1],r[2]) for r in cur.fetchall()}
def num(v):
    try:
        f=float(str(v).replace(",","").strip()); return f
    except: return None
def call(code):
    for _ in range(3):
        time.sleep(0.13)
        try:
            j=requests.get(URL,params={"SHT_CD":code},timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":"HHKST668300C0","custtype":"P"}).json()
            if "초당" in str(j.get("msg1","")): time.sleep(1); continue
            return j
        except Exception: time.sleep(1)
    return {}
rows=[]; stat={"empty":0,"no_est_col":0,"scale_bad":0,"ok":0}; bad=[]; scale_cnt={10:0,1:0,"?":0}
for i,code in enumerate(codes,1):
    j=call(code); o1=j.get("output1") or {}; o2=j.get("output2") or []; o3=j.get("output3") or []; o4=j.get("output4") or []
    if not o4 or len(o2)<5 or len(o3)<6: stat["empty"]+=1; continue
    cols=[(x.get("dt") or "").strip() for x in o4]
    def v(rowlist,r,c):
        return num(rowlist[r].get(f"data{c+1}")) if r<len(rowlist) else None
    # 배율 검증: 확정 2025.12 열(EPS ÷ 10 ≈ DB EPS)
    div=None
    if "2025.12" in cols and code in base and base[code][0] is not None:
        c25=cols.index("2025.12"); e=v(o3,1,c25); db=float(base[code][0])
        if e and db and e/db>0:
            for d in(10,1):
                if 0.85<=abs(e/d/db)<=1.18: div=d; break
    if div is None:
        # 검증 불가(2025 EPS 없음)면 매출액만으로 단위 확인 후 기본 10 적용 — 매출이 ±20% 이내일 때만
        if "2025.12" in cols and code in base and base[code][1] is not None and v(o2,0,cols.index("2025.12")):
            ratio=v(o2,0,cols.index("2025.12"))/float(base[code][1])
            div=10 if 0.8<=ratio<=1.25 else None
    scale_cnt[div if div in(10,1) else "?"]+=1
    if div is None: stat["scale_bad"]+=1; bad.append(code); continue
    est_by=(o1.get("name1") or "").strip() or None; ed=(o1.get("estdate") or "").strip(); est_date=f"{ed[:4]}-{ed[4:6]}-{ed[6:8]}" if len(ed)==8 else None
    got=0
    for c,dt in enumerate(cols):
        if not dt.endswith("E") or int(dt[:4])<2027: continue
        period=dt[:4]+dt[5:7]
        sales,op,ni=v(o2,0,c),v(o2,2,c),v(o2,4,c); eps,roe=v(o3,1,c),v(o3,5,c)
        if sales is None and op is None and eps is None: continue
        rows.append((code,"A",period,True,sales,op,ni,None if eps is None else eps/div,None if roe is None else roe/div,"kis_est",est_by,est_date)); got+=1
    if got: stat["ok"]+=1
    else: stat["no_est_col"]+=1
    if i%50==0: print(f"{i}/{len(codes)} {stat}",flush=True)
if rows:
    execute_values(cur,"""insert into stock_earnings(code,freq,period,is_est,sales,op_profit,net_income,eps,roe,src,est_by,est_date) values %s
      on conflict(code,freq,period) do update set is_est=true,sales=excluded.sales,op_profit=excluded.op_profit,net_income=excluded.net_income,eps=excluded.eps,roe=excluded.roe,
        src=excluded.src,est_by=excluded.est_by,est_date=excluded.est_date,updated_at=now()
      where stock_earnings.src is distinct from 'naver'""",rows)
cur.execute("select period,count(*),count(eps) from stock_earnings where src='kis_est' group by period order by period"); dist=cur.fetchall()
cur.execute("select code,period,sales,op_profit,net_income,eps,roe,est_by,est_date from stock_earnings where src='kis_est' and code in('192820','161890','000120') order by code,period"); smp=cur.fetchall()
rep=f"# KIS 추정실적(2027E) 수집\n- 대상 {len(codes)}종목 · {stat} · 배율 {scale_cnt} · 저장 {len(rows)}행\n- 배율 불일치 종목(앞 30): {', '.join(bad[:30]) or '없음'}\n- 저장 분포(period,행,EPS있는 행): {dist}\n- 샘플: \n"+"\n".join(str(r) for r in smp)+"\n"
open("kis_est27_report.md","w",encoding="utf-8").write(rep); print(rep)
