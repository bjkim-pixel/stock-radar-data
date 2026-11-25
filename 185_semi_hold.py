# -*- coding: utf-8 -*-
"""반도체 추종 2차 수집: 반도체 업종 종목의 외국인 보유율(소진율) 일별 → semi_hold_daily.
사용법: python 185_semi_hold.py            매일 저녁: KIS 일자별 시세(FHKST01010400, 최근 30거래일, hts_frgn_ehrt)로 갱신
        python 185_semi_hold.py backfill 20250901   과거 채우기: 네이버 모바일 종목 trend(pageSize=20, page 증가)에서 보유율·순매수수량
여러 번 실행해도 안전(업서트). 점검 결과(2026-11-25): 두 출처의 삼성전자 보유율이 45.90%로 일치."""
import os,sys,time,datetime as dt,requests,importlib,psycopg2
from psycopg2.extras import execute_values
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
def num(x):
    try: s=str(x).replace(",","").replace("%","").replace("+","").strip(); return float(s) if s not in ("","-") else None
    except Exception: return None
def d8(s): return dt.datetime.strptime(s,"%Y%m%d").date()
today=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
UP="insert into semi_hold_daily(trade_date,code,frgn_ratio,frgn_net_qty,src) values %s on conflict (trade_date,code) do update set frgn_ratio=excluded.frgn_ratio,frgn_net_qty=coalesce(excluded.frgn_net_qty,semi_hold_daily.frgn_net_qty),src=excluded.src,updated_at=now()"
def kis_daily(cur,codes):
    KEY=os.environ["KIS_APP_KEY"]; SEC=os.environ["KIS_APP_SECRET"]
    tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
    B="https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-price"
    n=err=0
    for i,c in enumerate(codes):
        for k in range(3):
            time.sleep(0.22)
            try:
                j=requests.get(B,params={"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":c,"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"1"},timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":"FHKST01010400","custtype":"P"}).json()
                if j.get("rt_cd")=="0": break
                if "초당" in str(j.get("msg1","")): time.sleep(1.5*(k+1)); continue
                err+=1; j={}; break
            except Exception: time.sleep(1.5*(k+1)); j={}
        rows=[]
        for r in j.get("output") or []:
            if not r.get("stck_bsop_date"): continue
            d=d8(r["stck_bsop_date"]); v=num(r.get("hts_frgn_ehrt"))
            if v is None: continue
            if d==today and dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).hour<16: continue   # 장 마감 전 잠정값은 넣지 않음
            rows.append((d,c,v,None if num(r.get("frgn_ntby_qty")) is None else int(num(r.get("frgn_ntby_qty"))),"KIS"))
        if rows: execute_values(cur,UP,rows); n+=len(rows)
        if (i+1)%20==0: log(f"  … {i+1}/{len(codes)} · {n}행")
    return n,err
H={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json"}
def naver_backfill(cur,codes,start):
    n=err=0
    for i,c in enumerate(codes):
        page=1; got=0
        while page<=40:
            time.sleep(0.12)
            try:
                r=requests.get(f"https://m.stock.naver.com/api/stock/{c}/trend",params={"pageSize":20,"page":page},headers=H,timeout=20)
                a=r.json() if r.status_code==200 else []
            except Exception: a=[]; err+=1
            if not a: break
            rows=[]; ds=[]
            for x in a:
                try: d=d8(x["bizdate"])
                except Exception: continue
                ds.append(d); v=num(x.get("foreignerHoldRatio"))
                if v is None or d<start: continue
                q=num(x.get("foreignerPureBuyQuant"))
                rows.append((d,c,v,None if q is None else int(q),"NAVER"))
            if rows: execute_values(cur,UP,rows); got+=len(rows)
            if not ds or min(ds)<=start or len(a)<20: break
            page+=1
        n+=got
        if (i+1)%10==0: log(f"  … {i+1}/{len(codes)} 종목 · {n}행")
    return n,err
def main():
    a=sys.argv[1:]; backfill=bool(a and a[0]=="backfill"); start=d8(a[1]) if backfill else None
    conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
    cur.execute(open("185_semi_hold.sql",encoding="utf-8").read())
    cur.execute("select code from v_stock_sector where sector='반도체' order by code"); codes=[r[0] for r in cur.fetchall()]
    for c in ("005930","000660"):
        if c not in codes: codes.append(c)
    log(f"# 외국인 보유율 수집 ({'백필 '+str(start) if backfill else '일일'}) · 업종 종목 {len(codes)}개"); t0=time.time()
    n,err=naver_backfill(cur,codes,start) if backfill else kis_daily(cur,codes)
    log(f"- 적재 {n}행 · 오류 {err}건 · {time.time()-t0:.0f}초")
    cur.execute("select count(*),count(distinct code),min(trade_date),max(trade_date) from semi_hold_daily"); log(f"- semi_hold_daily: {cur.fetchone()}")
    cur.execute("select code,trade_date,frgn_ratio,src from semi_hold_daily where code in ('005930','000660') order by trade_date desc,code limit 6"); log("- 최근(삼성·하이닉스): "+" | ".join(str(r) for r in cur.fetchall()))
    open("semi_hold_report.md","w",encoding="utf-8").write("\n".join(L))
if __name__=="__main__": main()
