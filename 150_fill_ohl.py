# -*- coding: utf-8 -*-
"""시가·고가·저가가 0으로 저장된 날을 KIS 일봉(FHKST03010100)으로 다시 채움. 종가가 DB와 일치(±0.5%)하는 행만 고친다.
사용: python 150_fill_ohl.py 20261028 20261029"""
import os,sys,time,importlib,requests,psycopg2
D1,D2=sys.argv[1],sys.argv[2]
KEY=os.environ["KIS_APP_KEY"]; SEC=os.environ["KIS_APP_SECRET"]
tok=importlib.import_module("72_kis_token").get_token_cached()
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute("""select p.code, p.trade_date, p.close from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
               where p.trade_date between %s and %s and (p.open<=0 or p.high<=0 or p.low<=0 or p.open is null)""",(D1,D2))
need={}
for c,d,cl in cur.fetchall(): need.setdefault(c,{})[d.strftime("%Y%m%d")]=float(cl)
H={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":"FHKST03010100","custtype":"P"}
fixed=mism=miss=0; ex=[]
for c,ds in need.items():
    out=None
    for adj in ("0","1"):
        for _ in range(3):
            time.sleep(0.13)
            try:
                j=requests.get("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
                    params={"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":c,"FID_INPUT_DATE_1":D1,"FID_INPUT_DATE_2":D2,"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":adj},headers=H,timeout=20).json()
                if "초당" in str(j.get("msg1","")): time.sleep(1); continue
                out={r["stck_bsop_date"]:r for r in (j.get("output2") or []) if r.get("stck_bsop_date")}; break
            except Exception: time.sleep(1)
        if out and all(d in out and abs(float(out[d]["stck_clpr"])/cl-1)<=0.005 for d,cl in ds.items()): break
    for d,cl in ds.items():
        r=(out or {}).get(d)
        if not r: miss+=1; continue
        o,h,l,k=(float(r[x]) for x in ("stck_oprc","stck_hgpr","stck_lwpr","stck_clpr"))
        if abs(k/cl-1)>0.005 or min(o,h,l)<=0: mism+=1; ex.append(f"{c} {d} DB종가 {cl:.0f} / KIS {k:.0f}"); continue
        cur.execute("update daily_price set open=%s, high=%s, low=%s where code=%s and trade_date=%s",(o,h,l,c,d)); fixed+=1
print(f"# 시·고·저 다시 채움 {D1}~{D2}\n- 대상 {sum(len(v) for v in need.values())}행({len(need)}종목) · 고침 {fixed} · 종가 불일치로 건너뜀 {mism} · KIS에 없음 {miss}")
if ex: print("- 건너뜀 예: "+", ".join(ex[:8]))
cur.execute("select trade_date, count(*) filter (where open<=0 or high<=0 or low<=0) from daily_price where trade_date between %s and %s group by 1 order by 1",(D1,D2))
print("- 남은 0 행: "+", ".join(f"{d} {n}" for d,n in cur))
