# -*- coding: utf-8 -*-
"""2027 예상실적 소스 점검(읽기 전용): 네이버 finance/annual 컬럼·컨센서스 여부, KIS 종목추정실적, DB에 저장된 연간 예상 분포."""
import os,sys,json,time,importlib,requests,psycopg2,collections
NH={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36","Referer":"https://m.stock.naver.com/"}
CODES=["005930","000660","192820","161890","373220"]
print("# 1. 네이버 모바일 finance/annual")
for c in CODES:
    for host in ["https://m.stock.naver.com/api/stock","https://api.stock.naver.com/stock"]:
        try:
            r=requests.get(f"{host}/{c}/finance/annual",headers=NH,timeout=20); j=r.json().get("financeInfo") or {}
            cols=[(t["key"],t.get("isConsensus"),t.get("title")) for t in j.get("trTitleList",[])]
            rows={x["title"]:x["columns"] for x in j.get("rowList",[])}
            print(c,host.split('/')[2],r.status_code,cols)
            last=cols[-1][0] if cols else None
            if last: print("   마지막 열",last,{t:(rows[t].get(last) or {}).get("value") for t in ["매출액","영업이익","당기순이익","EPS","주당배당금"] if t in rows})
        except Exception as e: print(c,host,"ERR",e)
        time.sleep(0.2)
print("\n# 2. 네이버 PC 메인(기업실적분석 표 헤더)")
try:
    r=requests.get("https://finance.naver.com/item/main.naver?code=005930",headers={"User-Agent":NH["User-Agent"]},timeout=20); r.encoding="euc-kr"
    import re
    t=r.text; i=t.find("기업실적분석"); seg=t[i:i+6000] if i>0 else ""
    print("http",r.status_code,"len",len(t)); print(re.findall(r"20\d\d\.\d\d(?:\(E\))?",seg)[:12])
except Exception as e: print("ERR",e)
print("\n# 3. KIS 종목추정실적(FHKST668300C0)")
try:
    tok=importlib.import_module("72_kis_token").get_token_cached(); K=os.environ["KIS_APP_KEY"]; S=os.environ["KIS_APP_SECRET"]
    for c in ["005930","192820"]:
        r=requests.get("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/estimate-perform",params={"SHT_CD":c},
           headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":K,"appsecret":S,"tr_id":"HHKST668300C0","custtype":"P"},timeout=20)
        print(c,r.status_code,r.text[:2500]); time.sleep(0.3)
except Exception as e: print("KIS ERR",e)
print("\n# 4. DB 연간 예상 기간 분포")
try:
    cur=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
    cur.execute("select period,count(*),count(sales),count(op_profit),count(eps) from stock_earnings where freq='A' and is_est group by period order by period"); print(cur.fetchall())
    cur.execute("select freq,period,sales,op_profit,eps,updated_at from stock_earnings where code='000660' and is_est order by freq,period"); print(cur.fetchall())
except Exception as e: print("DB ERR",e)
