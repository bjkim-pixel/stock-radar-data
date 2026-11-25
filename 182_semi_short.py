# -*- coding: utf-8 -*-
"""반도체 추종 2단계 수집(KIS): 반도체 업종 종목의 공매도 일별·신용잔고 일별 + 시장 전체 투자자별(연기금 포함) 순매수.
사용법: python 182_semi_short.py [최근 며칠(기본 7)]   |   python 182_semi_short.py backfill 20250901
 · 공매도: 종목당 40일 창으로 호출(한 번에 약 30거래일). 오늘 행은 공시 전이라 건너뜀(다음 날 채워짐)
 · 신용: 기준일을 거꾸로 밀며 호출(한 번에 30행)
 · 시장 투자자: 코스피·코스닥 각각 기준일을 거꾸로 밀며 호출(한 번에 최대 약 300거래일). 금액 단위는 market_investor_daily(억원)와 비교해 자동 판정
여러 번 실행해도 안전(업서트)."""
import os,sys,time,statistics,datetime as dt,requests,importlib,psycopg2
from psycopg2.extras import execute_values
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KEY=os.environ.get("KIS_APP_KEY",""); SEC=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"; Q="/uapi/domestic-stock/v1/quotations/"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
ERR=[0]
def kget(path,tr,params):
    for k in range(3):
        time.sleep(0.22)
        try:
            r=requests.get(B+Q+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":tr,"custtype":"P"})
            j=r.json()
            if j.get("rt_cd")=="0": return j
            if "초당" in str(j.get("msg1","")) or r.status_code==429: time.sleep(1.5*(k+1)); continue
            ERR[0]+=1; return j
        except Exception as e: time.sleep(1.5*(k+1))
    ERR[0]+=1; return {}
def num(x):
    try: s=str(x).replace(",","").strip(); return float(s) if s not in ("","-") else None
    except Exception: return None
def d8(s): return dt.datetime.strptime(s,"%Y%m%d").date()
today=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
def windows(start,end,step=38):
    out=[]; e=end
    while e>=start:
        s=max(start,e-dt.timedelta(days=step)); out.append((s,e)); e=s-dt.timedelta(days=1)
    return out
def short_stock(cur,code,start,end):
    n=0
    for s,e in windows(start,end):
        j=kget("daily-short-sale","FHPST04830000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":s.strftime("%Y%m%d"),"FID_INPUT_DATE_2":e.strftime("%Y%m%d")})
        rows=[]
        for r in j.get("output2") or []:
            if not r.get("stck_bsop_date"): continue
            d=d8(r["stck_bsop_date"])
            if d>=today: continue
            rows.append((d,code,num(r.get("stck_clpr")),num(r.get("acml_vol")),num(r.get("ssts_cntg_qty")),num(r.get("ssts_vol_rlim")),num(r.get("ssts_tr_pbmn")),num(r.get("ssts_tr_pbmn_rlim"))))
        if rows:
            execute_values(cur,"insert into kis_short_daily(trade_date,code,close,vol,short_qty,short_vol_ratio,short_amt,short_amt_ratio) values %s on conflict (trade_date,code) do update set close=excluded.close,vol=excluded.vol,short_qty=excluded.short_qty,short_vol_ratio=excluded.short_vol_ratio,short_amt=excluded.short_amt,short_amt_ratio=excluded.short_amt_ratio,updated_at=now()",rows); n+=len(rows)
    return n
def credit_stock(cur,code,start,end):
    n=0; anchor=end
    for _ in range(40):
        j=kget("daily-credit-balance","FHPST04760000",{"FID_COND_MRKT_DIV_CODE":"J","FID_COND_SCR_DIV_CODE":"20476","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":anchor.strftime("%Y%m%d")})
        o=j.get("output") or []; rows=[]; ds=[]
        for r in o:
            if not r.get("deal_date"): continue
            d=d8(r["deal_date"]); ds.append(d)
            if d>=start: rows.append((d,code,num(r.get("whol_loan_rmnd_stcn")),num(r.get("whol_loan_rmnd_amt")),num(r.get("whol_loan_rmnd_rate")),num(r.get("whol_loan_gvrt")),num(r.get("whol_stln_rmnd_stcn"))))
        if rows:
            execute_values(cur,"insert into kis_credit_daily(trade_date,code,loan_qty,loan_amt,loan_rate,loan_gvrt,stln_qty) values %s on conflict (trade_date,code) do update set loan_qty=excluded.loan_qty,loan_amt=excluded.loan_amt,loan_rate=excluded.loan_rate,loan_gvrt=excluded.loan_gvrt,stln_qty=excluded.stln_qty,updated_at=now()",rows); n+=len(rows)
        if not ds or min(ds)<=start: break
        anchor=min(ds)-dt.timedelta(days=1)
    return n
FLD=[("foreign_net","frgn_ntby_tr_pbmn"),("personal","prsn_ntby_tr_pbmn"),("inst","orgn_ntby_tr_pbmn"),("fin_inv","scrt_ntby_tr_pbmn"),("inv_trust","ivtr_ntby_tr_pbmn"),("pe","pe_fund_ntby_tr_pbmn"),
     ("bank","bank_ntby_tr_pbmn"),("insurance","insu_ntby_tr_pbmn"),("other_fin","mrbn_ntby_tr_pbmn"),("pension","fund_ntby_tr_pbmn"),("etc_corp","etc_corp_ntby_tr_pbmn")]
def market(cur,start,end):
    cur.execute("select trade_date,foreign_net from market_investor_daily where market='KOSPI' and foreign_net is not null order by trade_date desc limit 60")
    ref={r[0]:float(r[1]) for r in cur.fetchall()}
    scale=None; n=0
    for iscd,sub,mk in (("0001","KSP","KOSPI"),("1001","KSQ","KOSDAQ")):
        anchor=end; raw=[]
        for _ in range(8):
            j=kget("inquire-investor-daily-by-market","FHPTJ04040000",{"FID_COND_MRKT_DIV_CODE":"U","FID_INPUT_ISCD":iscd,"FID_INPUT_DATE_1":anchor.strftime("%Y%m%d"),"FID_INPUT_ISCD_1":sub,"FID_INPUT_DATE_2":anchor.strftime("%Y%m%d"),"FID_INPUT_ISCD_2":iscd})
            o=[r for r in (j.get("output") or []) if r.get("stck_bsop_date")]
            if not o: break
            raw+=o; ds=[d8(r["stck_bsop_date"]) for r in o]
            if min(ds)<=start or len(o)<50: break
            anchor=min(ds)-dt.timedelta(days=1)
        if mk=="KOSPI" and scale is None:
            rs=[abs(num(r.get("frgn_ntby_tr_pbmn")) or 0)/abs(ref[d8(r["stck_bsop_date"])]) for r in raw if d8(r["stck_bsop_date"]) in ref and abs(ref[d8(r["stck_bsop_date"])])>50]
            med=statistics.median(rs) if rs else None
            scale=min((1,100,1e4,1e6,1e8),key=lambda s:abs((med or 100)-s)) if med else 100
            log(f"- 금액 단위 판정: KIS 값 ÷ 억원 중앙값 {med and round(med,2)} → 나누기 {scale:g} ({len(rs)}일 비교)")
        rows=[]
        for r in raw:
            d=d8(r["stck_bsop_date"])
            if d<start or d>=today and False: continue
            rows.append((d,mk,*[(None if num(r.get(k)) is None else num(r.get(k))/scale) for _,k in FLD]))
        rows=list({(x[0],x[1]):x for x in rows}.values())
        if rows:
            cols=",".join(c for c,_ in FLD)
            execute_values(cur,f"insert into market_investor_detail(trade_date,market,{cols}) values %s on conflict (trade_date,market) do update set "+",".join(f"{c}=excluded.{c}" for c,_ in FLD)+",updated_at=now()",rows); n+=len(rows)
    return n
def main():
    a=sys.argv[1:]
    if a and a[0]=="backfill": start=d8(a[1]); mode="backfill"
    else: start=today-dt.timedelta(days=int(a[0]) if a and a[0].isdigit() else 7); mode="daily"
    conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
    cur.execute(open("182_semi_short.sql",encoding="utf-8").read())
    cur.execute("select code from v_stock_sector where sector='반도체' order by code"); codes=[r[0] for r in cur.fetchall()]
    for c in ("005930","000660"):
        if c not in codes: codes.append(c)
    log(f"# 반도체 추종 2단계 수집 ({mode}) {start} ~ {today} · 업종 종목 {len(codes)}개")
    t0=time.time(); nm=market(cur,start,today); log(f"- 시장 투자자별: {nm}행 ({time.time()-t0:.0f}초)")
    ns=nc=0
    for i,c in enumerate(codes):
        ns+=short_stock(cur,c,start,today); nc+=credit_stock(cur,c,start,today)
        if (i+1)%20==0: log(f"  … {i+1}/{len(codes)} 종목 · 공매도 {ns}행 · 신용 {nc}행 · {time.time()-t0:.0f}초")
        if time.time()-t0>33*60: log("⚠ 시간 제한 — 남은 종목은 다음 실행에서"); break
    log(f"- 공매도 {ns}행 · 신용 {nc}행 · KIS 오류 {ERR[0]}건")
    for t,k in (("kis_short_daily","code"),("kis_credit_daily","code"),("market_investor_detail","market")):
        cur.execute(f"select count(*),count(distinct {k}),min(trade_date),max(trade_date) from {t}"); log(f"- {t}: {cur.fetchone()}")
    cur.execute("select d.trade_date,d.foreign_net,m.foreign_net,d.pension,d.pe from market_investor_detail d left join market_investor_daily m on m.trade_date=d.trade_date and m.market=d.market where d.market='KOSPI' order by d.trade_date desc limit 5")
    log("- 검증(KOSPI 외국인 순매수 억원: KIS vs 네이버, 연기금, 사모): "+" | ".join(f"{r[0]} {r[1]} vs {r[2]} · {r[3]} · {r[4]}" for r in cur.fetchall()))
    open("semi_short_report.md","w",encoding="utf-8").write("\n".join(L))
if __name__=="__main__": main()
