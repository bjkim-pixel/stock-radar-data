# -*- coding: utf-8 -*-
"""사이트가 쓰는 주요 PostgREST 요청의 응답 시간·크기 측정(읽기 전용). 브라우저와 같은 anon 키/요청 형태 사용."""
import re,time,json,requests,urllib.parse as up
html=open("web/index.html",encoding="utf-8").read()
URL=re.search(r'url:\s*"(https://[^"]+)"',html).group(1); KEY=re.search(r'key:\s*"(eyJ[^"]+)"',html).group(1)
H={"apikey":KEY,"Authorization":"Bearer "+KEY}
def get(path):
    t=time.time(); r=requests.get(f"{URL}/rest/v1/{path}",headers=H,timeout=120); dt=(time.time()-t)*1000
    try: n=len(r.json())
    except Exception: n=-1
    return r.status_code,dt,len(r.content),n,r
st,_,_,_,r=get("v_market_overview?select=trade_date&order=trade_date.desc&limit=1"); D=r.json()[0]["trade_date"]
sec=up.quote("반도체")
Q=[("stocks 목록","stocks?select=code,name&security_type=eq.STOCK&order=name.asc"),
("etf_master","etf_master?select=code,name,field&order=name.asc"),
("v_market_overview 전체이력","v_market_overview?select=*&order=trade_date.asc"),
("v_market_amount_real 전체이력","v_market_amount_real?select=*&order=trade_date.asc"),
("market_daily KOSPI","market_daily?select=trade_date,index_close,index_ma20,regime&market=eq.KOSPI&order=trade_date.asc"),
("v_data_status","v_data_status?select=*"),
("v_sector_rank","v_sector_rank?select=*"),
("v_sector_flow_daily(업종1)","v_sector_flow_daily?select=*&sector=eq."+sec+"&order=trade_date.asc"),
("v_sector_stocks(업종1,오늘)",f"v_sector_stocks?select=*&sector=eq.{sec}&trade_date=eq.{D}&order=trade_amount.desc"),
("v_screener 상위8",f"v_screener?select=code,name,smart_cum5&trade_date=eq.{D}&order=smart_cum5.desc&limit=8"),
("v_screener 일부컬럼 전체",f"v_screener?select=code,pct_from_high,is_new_high_all,is_new_high&trade_date=eq.{D}"),
("v_screener select=* 전체",f"v_screener?select=*&trade_date=eq.{D}"),
("v_stock_flow_periods 전체","v_stock_flow_periods?select=*"),
("flow_cap_ratio 전체","flow_cap_ratio?select=code,a_3m,a_1m,a_1w,r_3m,r_1m,r_1w"),
("rpc flow_rank_on",None),
("v_flow_rank_today(뷰)",f"v_flow_rank_today?select=*&trade_date=eq.{D}"),
("daily_flow 하루 전종목",f"daily_flow?select=code,foreign_net,inst_net,corp_other_net,individual_net&trade_date=eq.{D}"),
("daily_flow 종목1 5일(N+1 1건)","daily_flow?select=trade_date,individual_net&code=eq.000660&order=trade_date.desc&limit=5"),
("v_stock_chart 종목1 전체이력","v_stock_chart?select=*&code=eq.000660&order=trade_date.asc"),
("v_stock_summary 종목1","v_stock_summary?select=*&code=eq.000660"),
("v_stock_flow_periods 종목1","v_stock_flow_periods?select=*&code=eq.000660"),
("v_stock_sector(업종필터)","v_stock_sector?select=code,sector&order=code.asc&limit=1000&offset=0"),
("smart_money_state 전체(페이지1)","smart_money_state?select=*&order=code.asc&limit=1000&offset=0"),
("sector_flow_daily 6/1~(페이지1)","sector_flow_daily?select=trade_date,market,sector,trade_amount,pe_net&trade_date=gte.2026-06-01&order=trade_date.asc&limit=1000&offset=0"),
("v_kospi_flow_daily","v_kospi_flow_daily?select=*&order=trade_date.asc"),
("signals 오늘 V4",f"signals?select=code,signal_type,grade,score,reason_text,trade_date&trade_date=eq.{D}&limit=500"),
("v_etf_screener 오늘",f"v_etf_screener?select=*&trade_date=eq.{D}"),
("stock_earnings 종목1","stock_earnings?select=*&code=eq.000660&order=period.asc"),
("v_market_flow_periods","v_market_flow_periods?select=*"),
("v_sector_cluster 오늘",f"v_sector_cluster?select=*&trade_date=eq.{D}"),
("rpc data_version(캐시 버전)","rpc/data_version")]
rows=[]
for name,p in Q:
    for k in range(2):   # 1회차=콜드, 2회차=웜
        if p is None:
            t=time.time(); r=requests.get(f"{URL}/rest/v1/rpc/flow_rank_on",params={"d":D},headers=H,timeout=120); dt=(time.time()-t)*1000
            res=(r.status_code,dt,len(r.content),len(r.json()) if r.ok else -1)
        else:
            s,dt,b,n,_=get(p); res=(s,dt,b,n)
        if k==0: first=res
    rows.append((name,first,res))
rep=[f"# 요청 성능 측정 (기준일 {D}, GitHub Runner→Supabase, 브라우저 구간 제외)","","| 요청 | 상태 | 1회(ms) | 2회(ms) | 크기(KB) | 행수 |","|---|---|---|---|---|---|"]
for n,a,b in sorted(rows,key=lambda x:-x[1][1]):
    rep.append(f"| {n} | {a[0]} | {a[1]:.0f} | {b[1]:.0f} | {a[2]/1024:.0f} | {a[3]} |")
open("perf_probe_report.md","w",encoding="utf-8").write("\n".join(rep)+"\n"); print("\n".join(rep))
