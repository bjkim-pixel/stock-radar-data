# -*- coding: utf-8 -*-
"""미국 개별 종목을 사이트에 넣을 수 있는지 점검(읽기 전용, DB 변경 없음).
  1) Yahoo 차트 API: 일봉 OHLCV 개수·최신일·거래소 (이미 글로벌 시황이 쓰는 경로)
  2) KIS 해외주식 시세(REST): 기간별시세 / 현재가상세 — 이 앱키로 권한이 있는지, 몇 건 오는지, 시총·주식수 필드가 있는지
  3) DB: 현재 global_series_daily/etf_holdings 규모, 미국 보유종목(고유) 수
결과는 마크다운 리포트로 저장."""
import os, sys, time, json, datetime, requests, psycopg2
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
log(f"# 미국 개별 종목 수집 가능성 점검 ({datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC)\n")
log("## 1) Yahoo Finance 일봉 (OHLCV)")
for sym in ("AAPL","NVDA","JPM","BRK-B"):
    try:
        r=requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}",params={"interval":"1d","range":"1y"},headers={"User-Agent":"Mozilla/5.0"},timeout=15)
        if r.status_code!=200: log(f"- {sym}: HTTP {r.status_code}"); continue
        res=r.json()["chart"]["result"][0]; q=res["indicators"]["quote"][0]; ts=res["timestamp"]
        n=sum(1 for c in q["close"] if c is not None)
        log(f"- {sym}: {n}봉 · 필드 {[k for k in q.keys()]} · 거래소 {res['meta'].get('exchangeName')} · 통화 {res['meta'].get('currency')} · 최신 {datetime.datetime.utcfromtimestamp(ts[-1]):%Y-%m-%d} 종가 {q['close'][-1]}")
    except Exception as e: log(f"- {sym}: 예외 {str(e)[:100]}")
log("\n## 2) KIS 해외주식 시세 (이 앱키 권한 확인)")
try:
    tok=get_token(); log("- 토큰 발급/캐시 사용: OK")
except Exception as e:
    tok=None; log(f"- 토큰 실패: {str(e)[:120]}")
def kget(path,tr,params):
    time.sleep(0.15)
    r=requests.get(KIS_BASE+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
    try: return r.status_code,r.json()
    except Exception: return r.status_code,{"raw":r.text[:200]}
if tok:
    for excd,sym in (("NAS","AAPL"),("NYS","JPM"),("NAS","NVDA")):
        st,d=kget("/uapi/overseas-price/v1/quotations/dailyprice","HHDFS76240000",{"AUTH":"","EXCD":excd,"SYMB":sym,"GUBN":"0","BYMD":"","MODP":"1"})
        rows=d.get("output2") or []
        log(f"- 기간별시세(HHDFS76240000) {excd}:{sym}: HTTP {st} rt_cd={d.get('rt_cd')} msg={str(d.get('msg1',''))[:60]} · output2 {len(rows)}건"+(f" · 최신 {rows[0].get('xymd')} 종가 {rows[0].get('clos')} 거래량 {rows[0].get('tvol')} 거래대금 {rows[0].get('tamt')}" if rows else ""))
        if rows and sym=="AAPL": log(f"  - 필드: {list(rows[0].keys())}")
    st,d=kget("/uapi/overseas-price/v1/quotations/price-detail","HHDFS76200200",{"AUTH":"","EXCD":"NAS","SYMB":"AAPL"})
    o=d.get("output") or {}
    log(f"- 현재가상세(HHDFS76200200) NAS:AAPL: HTTP {st} rt_cd={d.get('rt_cd')} msg={str(d.get('msg1',''))[:60]}")
    if o: log(f"  - 시총(tomv)={o.get('tomv')} 상장주식수(shar)={o.get('shar')} PER={o.get('perx')} EPS={o.get('epsx')} 52주고={o.get('h52p')} 저={o.get('l52p')} 필드수 {len(o)}")
log("\n## 3) DB 현황")
try:
    c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur=c.cursor()
    cur.execute("select count(*),count(distinct symbol),min(trade_date),max(trade_date) from global_series_daily"); log(f"- global_series_daily: 행/티커/기간 = {cur.fetchone()}")
    cur.execute("select count(*),count(distinct stock_code) from etf_holdings where etf_symbol not like 'KR:%'"); log(f"- 미국 ETF 보유종목 행/고유 종목 = {cur.fetchone()}")
    cur.execute("select stock_code,stock_name,exch,count(*) from etf_holdings where etf_symbol not like 'KR:%' group by 1,2,3 order by 4 desc limit 15"); log(f"- 상위 보유종목 예: {cur.fetchall()}")
    cur.execute("select pg_size_pretty(pg_database_size(current_database()))"); log(f"- DB 전체 용량: {cur.fetchone()[0]} (Supabase 무료 한도 500MB)")
except Exception as e: log(f"- DB 조회 실패: {str(e)[:150]}")
open(sys.argv[sys.argv.index('--report')+1] if '--report' in sys.argv else 'us_probe_report.md','w',encoding='utf-8').write("\n".join(L))
