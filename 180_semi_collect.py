# -*- coding: utf-8 -*-
"""반도체 추종: KRX OpenAPI 선물 일별매매 → krx_fut_daily, 그리고 사이드카 '추정'일 → market_events(kind=sidecar, source=krx)
사용법: python 180_semi_collect.py [최근 며칠(기본 5)]   |   python 180_semi_collect.py backfill 20250901 [끝날짜]
 · 코스피200 선물(K200), 삼성전자 선물(SEC), SK하이닉스 선물(HYX): 정규장 행 중 거래량이 가장 큰 월물 1개
 · 사이드카 추정 = 코스피200 선물 장중 고가/저가가 전일 종가 대비 ±5% 이상 (실제 발동은 1분 지속·현물 ±1% 조건이 더 붙으므로 '추정')
KRX 인증키는 환경변수 KRX_API_KEY(GitHub Secret)로만 읽고 로그·리포트에는 출력하지 않는다. 여러 번 실행해도 안전(업서트)."""
import os,sys,time,datetime as dt,requests,psycopg2
import holidays
KEY=os.environ.get("KRX_API_KEY","").strip()
BASE="https://data-dbg.krx.co.kr/svc/apis"
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
def num(x):
    try:
        s=str(x).replace(",","").strip()
        return float(s) if s not in ("","-") else None
    except Exception: return None
today=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
KR=holidays.country_holidays("KR",years=range(2025,today.year+2))
def is_open(d): return d.weekday()<5 and d not in KR and not (d.month==12 and d.day==31)
def get(path,bd):
    for k in range(3):
        try:
            r=requests.get(f"{BASE}/{path}",params={"basDd":bd},headers={**UA,"AUTH_KEY":KEY},timeout=30)
            if r.status_code==200: return r.json().get("OutBlock_1") or []
            if r.status_code in (401,403,404): log(f"- {path} {bd}: HTTP {r.status_code}"); return None
        except Exception as e: log(f"- {path} {bd}: {str(e).replace(KEY,'***')[:100]}")
        time.sleep(1.5*(k+1))
    return None
def norm(s): return str(s or "").replace(" ","")
def pick(rows,match):
    """정규장 행 중 match(PROD_NM)가 참이고 거래량이 가장 큰 월물"""
    c=[x for x in rows if "야간" not in str(x.get("MKT_NM","")) and match(norm(x.get("PROD_NM")))]
    c=[x for x in c if num(x.get("TDD_CLSPRC")) is not None]
    return max(c,key=lambda x:num(x.get("ACC_TRDVOL")) or 0) if c else None
def k200(n): return n=="코스피200선물" or (n.endswith("선물") and "코스피200" in n and not any(w in n for w in ("미니","변동성","섹터","배당","KRX","옵션","레버리지","인버스","코스닥")))
SYMS=[("K200","drv/fut_bydd_trd",k200),
      ("SEC","drv/eqsfu_stk_bydd_trd",lambda n:n=="삼성전자선물"),
      ("HYX","drv/eqsfu_stk_bydd_trd",lambda n:n=="SK하이닉스선물")]
def day(cur,d):
    bd=d.strftime("%Y%m%d"); cache={}; got=[]; ev=0
    for sym,path,m in SYMS:
        if path not in cache: cache[path]=get(path,bd)
        rows=cache[path]
        if rows is None: continue
        x=pick(rows,m)
        if not x: continue
        c=num(x.get("TDD_CLSPRC")); chg=num(x.get("CMPPREVDD_PRC"))
        cur.execute("""insert into krx_fut_daily(trade_date,sym,isu_nm,close,chg,open,high,low,spot,vol,amt,oi) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
          on conflict (trade_date,sym) do update set isu_nm=excluded.isu_nm,close=excluded.close,chg=excluded.chg,open=excluded.open,high=excluded.high,low=excluded.low,spot=excluded.spot,vol=excluded.vol,amt=excluded.amt,oi=excluded.oi,updated_at=now()""",
          (d,sym,str(x.get("ISU_NM","")).strip(),c,chg,num(x.get("TDD_OPNPRC")),num(x.get("TDD_HGPRC")),num(x.get("TDD_LWPRC")),num(x.get("SPOT_PRC")),
           int(num(x.get("ACC_TRDVOL")) or 0),num(x.get("ACC_TRDVAL")),int(num(x.get("ACC_OPNINT_QTY")) or 0)))
        got.append(sym)
        if sym=="K200" and c is not None and chg is not None and c-chg>0:
            pv=c-chg; hi=num(x.get("TDD_HGPRC")); lo=num(x.get("TDD_LWPRC"))
            hp=(hi/pv-1)*100 if hi else 0; lp=(lo/pv-1)*100 if lo else 0
            for kind,cond,ttl in (("buy",hp>=5,"매수 사이드카 추정"),("sell",lp<=-5,"매도 사이드카 추정")):
                if cond:
                    cur.execute("""insert into market_events(ev_key,event_date,kind,title,detail,source) values (%s,%s,'sidecar',%s,%s,'krx')
                      on conflict (ev_key) do update set title=excluded.title,detail=excluded.detail,updated_at=now()""",
                      (f"sidecar|{d}||{kind}",d,ttl,f"코스피200 선물 장중 고가 {hp:+.1f}% · 저가 {lp:+.1f}% (전일 종가 대비) — ±5% 기준 추정, 실제 발동은 1분 지속·현물 ±1% 조건이 더 붙음"))
                    ev+=1
    return got,ev
def main():
    if not KEY: log("KRX_API_KEY 없음"); sys.exit(1)
    a=sys.argv[1:]
    if a and a[0]=="backfill":
        d0=dt.datetime.strptime(a[1],"%Y%m%d").date(); d1=dt.datetime.strptime(a[2],"%Y%m%d").date() if len(a)>2 else today
    else:
        n=int(a[0]) if a and a[0].isdigit() else 5; d1=today; d0=today-dt.timedelta(days=n)
    conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
    cur.execute(open("180_semi.sql",encoding="utf-8").read())
    log(f"# 반도체 추종 선물 수집 {d0} ~ {d1}")
    d=d0; days=0; rows=0; evs=0; miss=0
    while d<=d1:
        if is_open(d):
            got,ev=day(cur,d); days+=1; rows+=len(got); evs+=ev
            if len(got)<3: miss+=1; log(f"- {d}: 일부 없음 {sorted({'K200','SEC','HYX'}-set(got))}")
            time.sleep(0.25)
        d+=dt.timedelta(days=1)
    cur.execute("select sym,count(*),min(trade_date),max(trade_date),max(isu_nm) from krx_fut_daily group by sym order by sym")
    log(f"\n- 처리 {days}거래일 · 행 {rows} · 사이드카 추정 {evs}건 · 누락일 {miss}")
    for r in cur.fetchall(): log(f"- {r[0]}: {r[1]}행 {r[2]} ~ {r[3]} · {r[4]}")
    cur.execute("select event_date,title from market_events where kind='sidecar' order by event_date desc limit 12")
    for r in cur.fetchall(): log(f"  · {r[0]} {r[1]}")
    open("semi_collect_report.md","w",encoding="utf-8").write("\n".join(L))
if __name__=="__main__": main()
