# -*- coding: utf-8 -*-
"""반도체 추종 3단계 검증(읽기 전용): 각 신호가 '다음 거래일' 삼성전자·SK하이닉스(평균) 수익률과 어떤 관계였는지 2025-09-01 이후로 집계.
결과 = 신호 구간별 표본 수 · 다음날 평균(%) · 상승 비율 · 다음 3일 합 · 다음날 갭(시가)/장중(시가→종가) · 전반부/후반부 평균(안정성)."""
import os,psycopg2,numpy as np,pandas as pd,datetime as dt
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True,autocommit=True)
def Q(s): return pd.read_sql(s,c)
P=Q("select trade_date d,code,open,close,change_pct from daily_price where code in ('005930','000660') and trade_date>='2025-08-01' order by 1")
P["d"]=pd.to_datetime(P["d"]); w=P.pivot(index="d",columns="code")
df=pd.DataFrame(index=w.index)
for c_,k in (("005930","s"),("000660","h")):
    cl=w["close"][c_].astype(float); op=w["open"][c_].astype(float)
    df[k+"_r"]=cl.pct_change()*100; df[k+"_gap"]=(op/cl.shift(1)-1)*100; df[k+"_in"]=(cl/op-1)*100
df["big"]=df[["s_r","h_r"]].mean(axis=1); df["gap"]=df[["s_gap","h_gap"]].mean(axis=1); df["intra"]=df[["s_in","h_in"]].mean(axis=1)
df["y1"]=df["big"].shift(-1); df["y3"]=df["big"].shift(-1)+df["big"].shift(-2)+df["big"].shift(-3); df["g1"]=df["gap"].shift(-1); df["i1"]=df["intra"].shift(-1)
F=Q("select trade_date d,close,chg,oi from krx_fut_daily where sym='K200' order by 1"); F["d"]=pd.to_datetime(F["d"]); F=F.set_index("d").astype(float)
df["k_ret"]=F["chg"]/(F["close"]-F["chg"])*100; df["oi"]=F["oi"]; df["doi"]=F["oi"].diff(); df["k_hi"]=None
M=Q("select trade_date d,market,foreign_net from market_investor_daily where market in ('KOSPI','FUT') order by 1"); M["d"]=pd.to_datetime(M["d"])
mw=M.pivot(index="d",columns="market",values="foreign_net").astype(float); df["fK"]=mw["KOSPI"]; df["fF"]=mw["FUT"]
X=Q("select trade_date d,pension,personal,pe from market_investor_detail where market='KOSPI' order by 1"); X["d"]=pd.to_datetime(X["d"]); X=X.set_index("d").astype(float)
df["pen"]=X["pension"]; df["prs"]=X["personal"]
V=Q("select trade_date d,close from vkospi_daily order by 1"); V["d"]=pd.to_datetime(V["d"]); df["vk"]=V.set_index("d")["close"].astype(float); df["dvk5"]=df["vk"]-df["vk"].shift(5)
E=Q("select event_date d,title,source from market_events where kind='sidecar'"); E["d"]=pd.to_datetime(E["d"]); E["dir"]=np.where(E["title"].str.contains("매수"),"buy","sell")
df["sc"]="없음"
for d,g in E.groupby("d"):
    if d in df.index: df.loc[d,"sc"]="+".join(sorted(set(g["dir"])))
S=Q("select trade_date d,code,short_amt_ratio r from kis_short_daily where code in ('005930','000660') order by 1"); S["d"]=pd.to_datetime(S["d"])
df["sh"]=S.pivot(index="d",columns="code",values="r").astype(float).mean(axis=1)
df["sh_z"]=(df["sh"]-df["sh"].rolling(40,min_periods=20).mean())/df["sh"].rolling(40,min_periods=20).std()
A=Q("select trade_date d,code,amount from etf_daily where code in ('122630','252670','114800','0193T0','0193W0','0197X0','0193L0') and trade_date>='2025-08-01'"); A["d"]=pd.to_datetime(A["d"])
aw=A.pivot(index="d",columns="code",values="amount").astype(float).fillna(0)
def share(L,I):
    l=aw[[x for x in L if x in aw]].sum(axis=1); i=aw[[x for x in I if x in aw]].sum(axis=1); return (l/(l+i)*100).where((l+i)>0)
df["lev_idx"]=share(["122630"],["252670","114800"]); df["lev_one"]=share(["0193T0","0193W0"],["0197X0","0193L0"])
df=df[df.index>=pd.Timestamp("2025-09-01")]
df["fK5"]=df["fK"].rolling(5).sum(); df["fF5"]=df["fF"].rolling(5).sum(); df["fF20"]=df["fF"].rolling(20).sum()
mid=df.index[len(df)//2]
out=[]
def p(s=""): out.append(s); print(s)
def tbl(title,lab,note=""):
    d=df.assign(L=lab).dropna(subset=["L","y1"])
    p(f"\n### {title}"+(f"\n{note}" if note else ""))
    p("| 구간 | n | 다음날 평균% | 상승비율 | 다음3일% | 다음날 갭% | 다음날 장중% | 전반 평균 | 후반 평균 |"); p("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for k,g in d.groupby("L"):
        a,b=g[g.index<mid]["y1"],g[g.index>=mid]["y1"]
        p(f"| {k} | {len(g)} | {g.y1.mean():+.2f} | {(g.y1>0).mean()*100:.0f}% | {g.y3.mean():+.2f} | {g.g1.mean():+.2f} | {g.i1.mean():+.2f} | {a.mean():+.2f} ({len(a)}) | {b.mean():+.2f} ({len(b)}) |")
sg=lambda s:np.where(s>0,"+","−")
p(f"# 반도체 추종 3단계 신호 검증 — {df.index[0].date()} ~ {df.index[-1].date()} ({len(df)}거래일, 전·후반 경계 {mid.date()})")
p("대상 수익률 = 삼성전자·SK하이닉스 종가 등락률 평균. 다음날 갭 = 다음날 시가/오늘 종가, 장중 = 다음날 종가/시가.")
p(f"\n- 전체 다음날 평균 {df.y1.mean():+.2f}% · 상승비율 {(df.y1>0).mean()*100:.0f}% · 표준편차 {df.y1.std():.2f}%")
p(f"- 자기상관(오늘 등락 vs 다음날): {df.big.corr(df.y1):+.3f} · 오늘 외국인 선물 vs 다음날: {df.fF.corr(df.y1):+.3f} · 오늘 외국인 현물 vs 다음날: {df.fK.corr(df.y1):+.3f} · 오늘 연기금 vs 다음날: {df.pen.corr(df.y1):+.3f}")
p(f"- 같은 날 상관: 외국인 선물 vs 당일 등락 {df.fF.corr(df.big):+.3f} · 외국인 현물 vs 당일 {df.fK.corr(df.big):+.3f} · 연기금 vs 당일 {df.pen.corr(df.big):+.3f}")
tbl("1. 오늘 등락 크기 → 다음날 (큰 상승 다음날 되밀림 패턴?)",pd.cut(df.big,[-99,-5,-3,-1,1,3,5,99],labels=["≤-5","-5~-3","-3~-1","-1~1","1~3","3~5","≥5"]).astype(str))
tbl("2. 외국인 현물·선물 부호 조합(당일)",pd.Series([f"현물{a} 선물{b}" for a,b in zip(sg(df.fK),sg(df.fF))],index=df.index).where(df.fK.notna()&df.fF.notna()))
tbl("3. 외국인 현물·선물 부호 조합(5일 합)",pd.Series([f"현물{a} 선물{b}" for a,b in zip(sg(df.fK5),sg(df.fF5))],index=df.index).where(df.fK5.notna()&df.fF5.notna()))
tbl("4. 선물 미결제약정 증감 × 선물 등락",pd.Series([f"OI{a} 가격{b}" for a,b in zip(sg(df.doi),sg(df.k_ret))],index=df.index).where(df.doi.notna()&df.k_ret.notna()),"OI+가격− = 신규 숏 쌓임, OI−가격+ = 숏커버, OI+가격+ = 신규 롱, OI−가격− = 롱 청산")
tbl("5. VKOSPI 수준",pd.cut(df.vk,[0,25,35,45,60,200],labels=["<25","25~35","35~45","45~60","≥60"]).astype(str).where(df.vk.notna()))
tbl("6. VKOSPI 5일 변화",pd.cut(df.dvk5,[-99,-5,-1,1,5,99],labels=["≤-5","-5~-1","-1~1","1~5","≥5"]).astype(str).where(df.dvk5.notna()))
tbl("7. 방패: 외국인 현물 순매도일의 연기금",pd.Series(np.where(df.fK<0,np.where(df.pen>0,"외국인− 연기금+","외국인− 연기금−"),np.where(df.pen>0,"외국인+ 연기금+","외국인+ 연기금−")),index=df.index).where(df.pen.notna()&df.fK.notna()))
tbl("8. 사이드카(확정·추정 합침)",df.sc)
tbl("9. 공매도 비중 z(삼성·하이닉스 평균, 40일 기준)",pd.cut(df.sh_z,[-9,-1,0,1,2,9],labels=["≤-1","-1~0","0~1","1~2","≥2"]).astype(str).where(df.sh_z.notna()))
tbl("10. 코스피200 레버리지 거래대금 비중",pd.qcut(df.lev_idx,5,labels=["하위20%","20~40","40~60","60~80","상위20%"]).astype(str).where(df.lev_idx.notna()))
tbl("11. 단일종목(삼성·하이닉스) 레버리지 거래대금 비중",pd.qcut(df.lev_one,4,labels=["하위25%","25~50","50~75","상위25%"],duplicates="drop").astype(str).where(df.lev_one.notna()))
tbl("12. 외국인 선물 20일 합",pd.qcut(df.fF20,5,labels=["하위20%(누적 매도)","20~40","40~60","60~80","상위20%(누적 매수)"]).astype(str).where(df.fF20.notna()))
tbl("13. 개인 현물(코스피) 부호 × 오늘 등락",pd.Series([f"개인{a} 등락{b}" for a,b in zip(sg(df.prs),sg(df.big))],index=df.index).where(df.prs.notna()))
tbl("14. 요일",pd.Series(df.index.dayofweek.map({0:"월",1:"화",2:"수",3:"목",4:"금"}),index=df.index))
def exp_day(d):
    x=dt.date(d.year,d.month,1); x+=dt.timedelta(days=(3-x.weekday())%7+7); return x
lab=[]
for d in df.index:
    e=exp_day(d); dd=(d.date()-e).days
    lab.append("만기일" if dd==0 else "만기 다음 거래일" if 0<dd<=3 and d.weekday()<=1 and dd==(1 if d.weekday()==4 else 4 if d.weekday()==0 else 1) else "만기 주간(월~수)" if -3<=dd<0 else "그 외")
tbl("15. 옵션 만기(둘째 목요일, 휴장 보정 없음)",pd.Series(lab,index=df.index))
# 연속 패턴: 큰 하락(≤-3) 다음날 큰 상승(≥3), 그다음날?
d2=df.assign(prev=df.big.shift(1))
g=d2[(d2.prev<=-3)&(d2.big>=3)]
p(f"\n### 16. 급락(≤-3%) → 급반등(≥3%) 다음날: n={len(g)} · 다음날 평균 {g.y1.mean():+.2f}% · 상승비율 {(g.y1>0).mean()*100:.0f}% · 다음날 갭 {g.g1.mean():+.2f}% · 장중 {g.i1.mean():+.2f}%")
g=d2[(d2.prev>=3)&(d2.big<=-3)]
p(f"- 급등(≥3%) → 급락(≤-3%) 다음날: n={len(g)} · 다음날 평균 {g.y1.mean():+.2f}% · 상승비율 {(g.y1>0).mean()*100:.0f}%")
s=np.sign(df.big); p(f"- 부호 교대율(오늘과 다음날 방향이 반대인 비율): {(s*s.shift(-1)<0).mean()*100:.0f}% (전반 {(s*s.shift(-1)<0)[df.index<mid].mean()*100:.0f}% · 후반 {(s*s.shift(-1)<0)[df.index>=mid].mean()*100:.0f}%)")
big3=df[df.big.abs()>=3]; s3=np.sign(big3.big)*np.sign(big3.y1)
p(f"- |등락|≥3% 날 다음날 반대 방향 비율: {(s3<0).mean()*100:.0f}% (n={len(big3)})")
open("semi_regime_study.md","w",encoding="utf-8").write("\n".join(out))
