# -*- coding: utf-8 -*-
"""시장별 투자자 매매동향 과거분 채우기(코스피·코스닥·선물, 억원): 네이버 m.stock.naver.com/api/index/{KOSPI|KOSDAQ|FUT}/trend?bizdate=YYYYMMDD
요청일과 응답 bizdate가 다르면(휴장일) 건너뜀. 사용: SUPABASE_DB_URL=... python 141_market_investor_backfill.py [일수=200] [--report r.md]"""
import os,sys,time,datetime,requests,psycopg2
H={"User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36","Accept":"application/json"}
def num(v):
    try: return int(str(v).replace(",","").replace("+",""))
    except ValueError: return None
days=int(next((a for a in sys.argv[1:] if a.isdigit()),200))
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"115_market_investor.sql"),encoding="utf-8").read()); conn.commit()
today=datetime.date.today(); lines=["# 시장별 투자자 과거분 채우기"]; saved={"KOSPI":0,"KOSDAQ":0,"FUT":0}; skipped=0
for k in range(days):
    d=today-datetime.timedelta(days=k)
    if d.weekday()>=5: continue
    for m in saved:
        try:
            r=requests.get(f"https://m.stock.naver.com/api/index/{m}/trend?bizdate={d:%Y%m%d}",headers=H,timeout=20); j=r.json()
            if j.get("bizdate")!=f"{d:%Y%m%d}": skipped+=1; continue
            p,f,i=num(j.get("personalValue")),num(j.get("foreignValue")),num(j.get("institutionalValue"))
            if None in (p,f,i): skipped+=1; continue
            cur.execute("""insert into market_investor_daily(trade_date,market,personal,foreign_net,inst,updated_at) values(%s,%s,%s,%s,%s,now())
              on conflict(trade_date,market) do update set personal=excluded.personal,foreign_net=excluded.foreign_net,inst=excluded.inst,updated_at=now()""",(d,m,p,f,i))
            saved[m]+=1
        except Exception as e:
            skipped+=1
    conn.commit(); time.sleep(0.1)
# 휴장일(주식 시세가 없는 날)로 저장된 행 정리 — 네이버가 휴장일에도 값을 돌려줄 수 있음
cur.execute("select count(*) from market_investor_daily where trade_date not in (select distinct trade_date from daily_price)"); nh=cur.fetchone()[0]
cur.execute("delete from market_investor_daily where trade_date not in (select distinct trade_date from daily_price)"); conn.commit()
lines.append(f"- 휴장일 행 삭제 {nh}")
lines.append(f"- 저장 {saved} · 건너뜀 {skipped}")
cur.execute("select market,count(*),min(trade_date),max(trade_date) from market_investor_daily group by 1 order by 1"); lines+=[f"- {r}" for r in cur]
rep=sys.argv[sys.argv.index("--report")+1] if "--report" in sys.argv else None
print("\n".join(lines)); 
if rep: open(rep,"w",encoding="utf-8").write("\n".join(lines)+"\n")
