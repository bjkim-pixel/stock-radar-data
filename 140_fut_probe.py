# -*- coding: utf-8 -*-
"""선물 투자자별 순매수 이력 소스 점검(읽기 전용): DB에 쌓인 일수, 네이버 일자별/기간 이력 엔드포인트 존재 여부"""
import os,re,json,requests,psycopg2
UA={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json, text/html"}
print("# A. DB market_investor_daily 일수")
cur=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
cur.execute("select market,count(*),min(trade_date),max(trade_date) from market_investor_daily group by 1 order by 1")
for r in cur: print(r)
print("\n# B. 네이버 m.stock trend 원본/파라미터")
for u in ["https://m.stock.naver.com/api/index/FUT/trend","https://m.stock.naver.com/api/index/FUT/trend?bizdate=20261102",
          "https://m.stock.naver.com/api/index/FUT/trend?page=2&pageSize=20","https://m.stock.naver.com/api/index/KOSPI/trend?bizdate=20261102",
          "https://m.stock.naver.com/api/index/FUT/investor","https://m.stock.naver.com/api/index/FUT/investorTrend",
          "https://m.stock.naver.com/api/index/KOSPI200/trend","https://m.stock.naver.com/api/index/FUT/trend/daily"]:
    try:
        r=requests.get(u,headers=UA,timeout=20); print(r.status_code,u.split("naver.com")[1],r.text[:400].replace("\n"," "))
    except Exception as e: print("ERR",u,e)
print("\n# C. 네이버 금융 PC 페이지(일자별)")
for u in ["https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20261109&sosok=01",
          "https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20261109&sosok=03",
          "https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20261109&sosok=04",
          "https://finance.naver.com/sise/sise_investor_futures.naver","https://finance.naver.com/sise/investorDealTrendTime.naver?bizdate=20261109&sosok=03"]:
    try:
        r=requests.get(u,headers={**UA,"Referer":"https://finance.naver.com/"},timeout=20); r.encoding="euc-kr"; t=re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",r.text))
        print(r.status_code,u.split("naver.com")[1],len(r.text),t[:500])
    except Exception as e: print("ERR",u,e)
