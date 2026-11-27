# -*- coding: utf-8 -*-
"""SK바이오팜(326030) 손익비 판단 재현 — 엔진(auto-exec.js calcTarget/buildProfile) 계산을 그대로 옮겨 이력 길이별로 비교. 읽기 전용."""
import os, math, json, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
TICKS = [(2000,1),(5000,5),(20000,10),(50000,50),(200000,100),(500000,500)]
def tick(p):
    for lim,t in TICKS:
        if p < lim: return t
    return 1000
def floor_tick(p): t=tick(p); return math.floor(p/t+1e-9)*t
def below(p):
    f=floor_tick(p)
    if f>=p-1e-9: f-=tick(f-1)
    return f
def profile(rows, curp, n=24):
    lo=curp*0.7; hi=curp*1.7; size=(hi-lo)/n
    b=[0.0]*n
    for r in rows:
        i=min(n-1,max(0,math.floor((float(r["close"])-lo)/size))); b[i]+=(float(r["ind"] or 0))/1e8
    return [(lo+i*size, lo+(i+1)*size, v) for i,v in enumerate(b)]
def target(curp, prof, cap_eok, prev_high, stop=5, rr=3):
    above=sorted([b for b in prof if b[0]>=curp-1e-9], key=lambda b:b[0])
    cum=0; ri=-1
    for i,b in enumerate(above):
        v=max(0,b[2])
        if cum+v<=cap_eok: cum+=v; ri=i
        else: break
    rest=[b for b in above[ri+1:] if b[2]>0]
    if rest:
        top = rest[0] if ri<0 else max(rest,key=lambda b:b[2])
        return {"mode":"blocked" if ri<0 else "normal","target":below(top[0]),"topLo":round(top[0]),"topV":round(top[2],1),"cum":round(cum,1)}
    rrT=floor_tick(curp*(1+stop/100*rr)); return {"mode":"no-supply","target":max(floor_tick(prev_high) if prev_high>curp else 0, rrT),"rrT":rrT}
cur.execute("select trade_date, close, high, trade_amount, individual_net from v_stock_chart where code='326030' order by trade_date")
cols=["d","close","high","amt","ind"]; R=[dict(zip(cols,r)) for r in cur.fetchall()]
log(f"# SK바이오팜 326030 · 이력 {len(R)}행 · {R[0]['d']} ~ {R[-1]['d']}")
log("최근 3행: "+json.dumps([[str(r['d']),float(r['close']),float(r['ind'] or 0)/1e8] for r in R[-3:]],ensure_ascii=False))
curp=96800.0
last5=R[-5:]; avg5=sum(float(r["amt"] or 0) for r in last5)/len(last5)/1e8
log(f"현재가 가정 {curp:,.0f} · 최근5일 평균 거래대금 {avg5:,.1f}억 (cap)")
for name,start in (("전체 이력",None),("2026-06-01~",'2026-06-01'),("최근 126일",R[-126]['d'] if len(R)>126 else None),("최근 252일",R[-252]['d'] if len(R)>252 else None)):
    rows=[r for r in R if (start is None or str(r['d'])>=str(start))]
    ph=max(float(r['high'] or r['close']) for r in rows)
    pr=profile(rows,curp); res=target(curp,pr,avg5,ph)
    ab=[(round(b[0]),round(b[1]),round(b[2],1)) for b in pr if b[0]>=curp-1e-9 and b[2]!=0]
    log(f"\n## {name} · {len(rows)}행 · 기간 최고가 {ph:,.0f}\n- 목표 계산: {res}\n- 현재가 위 0이 아닌 가격대(억): {ab}")
open("diag_sk.md","w",encoding="utf-8").write("\n".join(L))
