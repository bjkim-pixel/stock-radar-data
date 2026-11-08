# -*- coding: utf-8 -*-
"""KIS 예탁원 배당일정 → stock_dividends 업서트. 사용법: python 132_dividend_collect.py [종목수 제한]
대상: stocks 중 is_active & security_type='STOCK'. 종목별로 2023-01-01 ~ 내년 말을 한 번에 조회.
덮어쓰기 규칙: 기준일이 120일 이상 지난 행은 값을 고정(이미 저장된 행은 건드리지 않고, 없는 행만 추가). 최근·예정 행은 갱신.
dps<=0(아직 미정으로 0원 표기된 예정 행)은 저장하지 않으며, 이미 저장돼 있던 같은 행이 0이 되면 삭제하지 않고 그대로 둡니다."""
import os,sys,time,datetime as dt,importlib,requests,psycopg2
from psycopg2.extras import execute_values
LIMIT=int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 0
KIS_KEY=os.environ["KIS_APP_KEY"]; KIS_SECRET=os.environ["KIS_APP_SECRET"]
tok=importlib.import_module("72_kis_token").get_token_cached()
BASE="https://openapi.koreainvestment.com:9443"
today=dt.date.today(); F_DT="20230101"; T_DT=f"{today.year+1}1231"
def d8(s):
    s=(s or "").replace("/","").replace("-","").strip()
    return dt.datetime.strptime(s,"%Y%m%d").date() if len(s)==8 and s.isdigit() else None
def num(v):
    try: return float(str(v).replace(",","").strip())
    except: return None
def fetch(code):
    time.sleep(0.12)
    for _ in range(3):
        try:
            r=requests.get(BASE+"/uapi/domestic-stock/v1/ksdinfo/dividend",
              params={"CTS":"","GB1":"0","F_DT":F_DT,"T_DT":T_DT,"SHT_CD":code,"HIGH_GB":""},timeout=20,
              headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":"HHKDB669102C0","custtype":"P"})
            j=r.json()
            if j.get("rt_cd")=="0": return j.get("output1") or []
            if "초당" in str(j.get("msg1","")): time.sleep(1); continue
            raise RuntimeError(str(j.get("msg1")))
        except RuntimeError: raise
        except Exception: time.sleep(1)
    raise RuntimeError("요청 실패")
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"132_dividends.sql"),encoding="utf-8").read())
cur.execute("select code from stocks where is_active and security_type='STOCK' order by code")
codes=[r[0] for r in cur.fetchall()]
if LIMIT: codes=codes[:LIMIT]
print("대상",len(codes),"종목",flush=True)
ok=fail=nrows=0; failed=[]; withdiv=0
for i,code in enumerate(codes,1):
    try:
        rows={}
        for r in fetch(code):
            rd=d8(r.get("record_date")); dps=num(r.get("per_sto_divi_amt"))
            if not rd or dps is None or dps<=0 or r.get("sht_cd")!=code: continue
            rows[(code,rd,r.get("divi_kind") or "")]=(code,rd,r.get("divi_kind") or "",dps,d8(r.get("divi_pay_dt")),r.get("stk_kind"))
        if rows:
            withdiv+=1
            execute_values(cur,"""insert into stock_dividends(code,record_date,divi_kind,dps,pay_date,stk_kind) values %s
              on conflict(code,record_date,divi_kind) do update set dps=excluded.dps,pay_date=excluded.pay_date,stk_kind=excluded.stk_kind,updated_at=now()
              where stock_dividends.record_date>=current_date-120""",list(rows.values()))
            nrows+=len(rows)
        ok+=1
    except Exception as e:
        fail+=1; failed.append(code); print("FAIL",code,e,flush=True)
    if i%50==0: print(f"{i}/{len(codes)} ok={ok} fail={fail}",flush=True)
cur.execute("select count(*),count(distinct code),max(record_date),pg_size_pretty(pg_total_relation_size('stock_dividends')) from stock_dividends")
t=cur.fetchone()
rep=f"# 배당 수집 결과 (KIS 예탁원)\n- 대상 {len(codes)}종목 · 성공 {ok} · 실패 {fail} · 배당 있는 종목 {withdiv}\n- 이번 업서트 시도 {nrows}행\n- 테이블 총 {t[0]}행 · {t[1]}종목 · 최대 기준일 {t[2]} · 크기 {t[3]}\n- 실패 종목: {', '.join(failed[:60]) or '없음'}\n"
cur.execute("select code,record_date,divi_kind,dps,pay_date from stock_dividends where code=%s order by record_date",("005930" if "005930" in codes else codes[0],))
rep+="\n## 샘플\n```\n"+"\n".join(str(r) for r in cur.fetchall())+"\n```\n"
open("dividend_report.md","w",encoding="utf-8").write(rep); print(rep)
