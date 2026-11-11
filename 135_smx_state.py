# -*- coding: utf-8 -*-
"""스마트머니 매집·이탈 진단 → smx_state. 사용법: SUPABASE_DB_URL=... python 135_smx_state.py
계산은 web/index.html smxModel()과 동일: 외국인+기관합계 일별 순매수 누적(기간 첫날=0)의 고점·직전 저점으로 매집분/회수율/상태 판정."""
import os,datetime as dt,collections,psycopg2
from psycopg2.extras import execute_values
EOK=1e8; WINS=[("63",63),("126",126),("all",None)]
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"135_smx_state.sql"),encoding="utf-8").read())
cur.execute("""select p.code,p.trade_date,coalesce(f.foreign_net,0)+coalesce(f.inst_net,0),
    coalesce(f.foreign_net,0),coalesce(f.fin_inv_net,0),coalesce(f.inv_trust_net,0),coalesce(f.pension_net,0),coalesce(f.pe_net,0),coalesce(f.inst_net,0)
  from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
  left join daily_flow f on f.trade_date=p.trade_date and f.code=p.code
  where p.close>0 order by p.code,p.trade_date""")
by=collections.defaultdict(list)
for c,d,n,fo,fi,it,pn,pe,ins in cur: by[c].append((d,float(n),float(fo),float(fi),float(it),float(pn),float(pe),float(ins)))
def model(rows):
    n=len(rows); L=n-1
    combo=[0.0]*n
    for i in range(1,n): combo[i]=combo[i-1]+rows[i][1]/EOK
    pk=0
    for i in range(n):
        if combo[i]>combo[pk]: pk=i
    tr=0
    for i in range(pk+1):
        if combo[i]<combo[tr]: tr=i
    build=combo[pk]-combo[tr]; dd=combo[pk]-combo[L]; since=L-pk
    r20=combo[L]-combo[max(0,L-20)]; ratio=dd/build if build>0 else None
    if build<=0: st="OUT" if combo[L]<0 else "NONE"
    elif since<=5: st="CONT"
    elif ratio<0.1: st="STALL"
    elif ratio<0.5: st="LEAVE" if r20<0 else "STALL"
    else: st="HEAVY"
    # 주도 세력: 매집 구간(저점→고점) 순매수가 가장 큰 주체(매집 구간이 없으면 기간 순매수). 추세는 그 주체의 최근 5·20일 순매수 방향. 화면(renderLead)과 같은 규칙
    def cum(col):
        v=[0.0]*n
        for i in range(1,n): v[i]=v[i-1]+col(rows[i])/EOK
        return v
    subs=[("외국인",cum(lambda r:r[2])),("금융투자",cum(lambda r:r[3])),("투신",cum(lambda r:r[4])),("연기금",cum(lambda r:r[5])),("사모",cum(lambda r:r[6])),
          ("기타기관",cum(lambda r:r[7]-r[3]-r[4]-r[5]-r[6]))]
    best=None
    for nm,v in subs:
        if all(abs(z)<0.5 for z in v): continue
        sc=(v[pk]-v[tr]) if build>0 else v[L]
        if best is None or sc>best[1]: best=(nm,sc,v[L]-v[max(0,L-5)],v[L]-v[max(0,L-20)])
    lead=(None,None,None)
    if best and best[1]>0:
        nm,sc,a5,a20=best; T=0.5
        if a20>T and a5>T: tr_="UP"
        elif a20>T: tr_="SLOW"
        elif a20<-T and a5<-T: tr_="DOWN"
        elif a20<-T: tr_="REBUY"
        elif a5>T: tr_="RESUME"
        elif a5<-T: tr_="TURN"
        else: tr_="FLAT"
        lead=(nm,tr_,round(sc,1))
    return st,build,combo[L],ratio,rows[pk][0],since,r20,combo[pk],lead
out=[]; cnt=collections.Counter()
for code,rs in by.items():
    for wn,w in WINS:
        sub=rs[-w:] if w else rs
        if len(sub)<10: continue
        st,b,now,ratio,pd_,since,r20,pke,lead=model(sub)
        out.append((code,wn,sub[-1][0],st,round(b,1),round(now,1),None if ratio is None else round(ratio,4),pd_,since,round(r20,1),round(pke,1),lead[0],lead[1],lead[2]))
        cnt[(wn,st)]+=1
cur.execute("delete from smx_state")
execute_values(cur,"insert into smx_state(code,win,as_of,st,build_eok,now_eok,ratio,peak_date,since,r20_eok,peak_eok,lead_nm,lead_trend,lead_eok) values %s",out,page_size=2000)
lines=["# smx_state 갱신",f"- 종목 {len(by)} · 행 {len(out)}"]
for wn,_ in WINS: lines.append(f"- {wn}: "+", ".join(f"{k[1]} {v}" for k,v in sorted(cnt.items()) if k[0]==wn))
cur.execute("select * from smx_state where code='005930' order by win"); lines+= ["- 005930: "+str(r) for r in cur]
open("smx_report.md","w",encoding="utf-8").write("\n".join(lines)); print("\n".join(lines))
