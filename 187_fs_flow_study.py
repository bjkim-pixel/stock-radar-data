# -*- coding: utf-8 -*-
"""외국인 '매도 → 공매도 확대 → 되사기(숏커버)' 가설 검증(읽기 전용). 삼성전자·SK하이닉스, 2025-09-01 이후.
가설: 외국인이 현물을 연속 순매도하며 주가를 누르고 공매도 비중이 커진 뒤, 외국인이 순매수로 돌아서며 공매도를 갚는 모습이 나온다 → 그 뒤 주가는?
 · 공매도(KIS)는 체결일 다음 영업일에 공시되므로 '당일 값'은 장 마감 직후엔 모름. 그래서 당일값 버전과 하루 늦게 아는 버전(전일값)을 함께 본다.
결과 = 조건별 표본 수 · 다음날 외국인 순매수 확률 · 다음날/3일 수익률 · 기준(전체 평균) 대비 t · 전·후반 안정성."""
import os,psycopg2,numpy as np,pandas as pd
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True,autocommit=True)
Q=lambda s:pd.read_sql(s,c)
out=[]
def p(s=""): out.append(str(s)); print(s,flush=True)
P=Q("select trade_date d,code,close,open from daily_price where code in ('005930','000660') and trade_date>='2025-08-01' order by 1"); P["d"]=pd.to_datetime(P["d"])
Fl=Q("select trade_date d,code,foreign_net f,pension_net pen from daily_flow where code in ('005930','000660') and trade_date>='2025-08-01' order by 1"); Fl["d"]=pd.to_datetime(Fl["d"])
Sh=Q("select trade_date d,code,short_amt_ratio sr,short_amt sa from kis_short_daily where code in ('005930','000660') and trade_date>='2025-08-01' order by 1"); Sh["d"]=pd.to_datetime(Sh["d"])
p("# 외국인 매도→공매도→되사기 가설 검증 — 삼성전자·SK하이닉스\n")
frames=[]
for code,nm in (("005930","삼성전자"),("000660","SK하이닉스")):
    x=P[P.code==code].set_index("d")[["close","open"]].astype(float)
    x["r"]=x["close"].pct_change()*100
    x=x.join(Fl[Fl.code==code].set_index("d")[["f","pen"]].astype(float)/1e8)
    x=x.join(Sh[Sh.code==code].set_index("d")[["sr","sa"]].astype(float))
    x["code"]=nm
    x["srz"]=(x["sr"]-x["sr"].rolling(20,min_periods=10).mean())/x["sr"].rolling(20,min_periods=10).std()
    x["sell3"]=(x["f"]<0)&(x["f"].shift(1)<0)&(x["f"].shift(2)<0)
    x["f3"]=x["f"].rolling(3).sum(); x["r3p"]=x["r"].rolling(3).sum()
    x["hi"]=x["srz"]>=1.0
    x["hi_any3"]=x["hi"].rolling(3,min_periods=1).max().astype(bool)          # 최근 3일 안에 공매도가 평소보다 컸음
    x["hi_prev"]=x["hi"].shift(1)                                               # 전일 공매도(하루 늦게 아는 값)
    x["hi_prev_any3"]=x["hi"].shift(1).rolling(3,min_periods=1).max().astype(bool)
    x["buy"]=x["f"]>0
    x["turn"]=x["buy"]&x["sell3"].shift(1)                                     # 3일 연속 순매도 뒤 순매수로 전환한 날
    x["f1"]=x["f"].shift(-1); x["buy1"]=(x["f"].shift(-1)>0).astype(float).where(x["f"].shift(-1).notna())
    x["y1"]=x["r"].shift(-1); x["y3"]=x["r"].shift(-1)+x["r"].shift(-2)+x["r"].shift(-3)
    frames.append(x.reset_index())
A=pd.concat(frames); A=A[A.d>="2025-09-01"]
p(f"기간 {A.d.min().date()} ~ {A.d.max().date()} · 종목×일 {len(A)}행 · 공매도 자료가 있는 행 {A.sr.notna().sum()}\n")
mid=A.d.sort_values().iloc[len(A)//2]
base1=A.y1.mean(); basef=A.buy1.mean()
def row(lab,m):
    g=A[m.fillna(False)&A.y1.notna()]
    if len(g)<3: p(f"| {lab} | {len(g)} | – | – | – | – | – | – |"); return
    t=(g.y1.mean()-base1)/(g.y1.std(ddof=1)/np.sqrt(len(g)))
    a,b=g[g.d<mid].y1,g[g.d>=mid].y1
    p(f"| {lab} | {len(g)} | {g.buy1.mean()*100:.0f}% | {g.f1.mean():+,.0f} | {g.y1.mean():+.2f} (t={t:+.1f}) | {(g.y1>0).mean()*100:.0f}% | {g.y3.mean():+.2f} | {a.mean():+.2f} ({len(a)}) / {b.mean():+.2f} ({len(b)}) |")
HDR="| 조건(그날 마감 시점) | n | 다음날 외국인 순매수 확률 | 다음날 외국인(억) | 다음날 수익률% | 상승비율 | 다음3일 합% | 전반 / 후반 평균 |\n|---|---:|---:|---:|---:|---:|---:|---|"
p(f"기준(조건 없음, 전체 평균): 다음날 외국인 순매수 확률 {basef*100:.0f}% · 다음날 수익률 평균 {base1:+.2f}% · 표본 {A.y1.notna().sum()}\n")
for nm,sub in (("두 종목 합산",A),("삼성전자",A[A.code=="삼성전자"]),("SK하이닉스",A[A.code=="SK하이닉스"])):
    A_=A; A=sub; mid=A.d.sort_values().iloc[len(A)//2]; base1=A.y1.mean(); basef=A.buy1.mean()
    p(f"\n## {nm}"); p(HDR)
    row("전체(기준)",A.d.notna())
    row("외국인 3일 연속 순매도",A.sell3)
    row("외국인 3일 연속 순매도 + 3일 합 주가 하락",A.sell3&(A.r3p<0))
    row("외국인 3일 연속 순매도 + 당일 공매도 비중 높음(20일 평균+1σ)",A.sell3&A.hi)
    row("외국인 3일 연속 순매도 + 최근 3일 중 공매도 높은 날 있음",A.sell3&A.hi_any3)
    row("(하루 늦게 아는 값) 3일 연속 순매도 + 전일 공매도 높음",A.sell3&A.hi_prev)
    row("공매도 비중 높음(당일)",A.hi)
    row("외국인 순매수 전환(3일 연속 순매도 뒤 순매수)",A.turn)
    row("순매수 전환 + 직전 3일 안에 공매도 높음",A.turn&A.hi_prev_any3)
    row("순매수 전환 + 직전 3일 안에 공매도 높지 않음",A.turn&~A.hi_prev_any3)
    A=A_
p("""
## 읽는 법·주의
- 표본이 2025-09 이후 약 300거래일×2종목(두 종목은 같이 움직임)이고 조건이 겹치면 n이 10 안팎까지 줄어듭니다. |t|<2 이거나 전반/후반 부호가 다르면 '우연일 수 있음'으로 봅니다.
- '다음날 외국인 순매수 확률'이 기준보다 확실히 높으면 '되사기'가 실제로 이어진다는 뜻이고, 다음날 수익률은 그 결과입니다.
- 공매도 자료는 다음 영업일 공시라, 매매 판단에 쓸 수 있는 건 '하루 늦게 아는 값' 줄입니다.""")
open("fs_flow_study.md","w",encoding="utf-8").write("\n".join(out))
