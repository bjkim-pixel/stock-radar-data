# -*- coding: utf-8 -*-
"""KRX 코스피200 옵션 풋/콜 비율 검증(읽기 전용, DB에 쓰지 않음): 기간 기본 2026-09-01 ~ 2026-11-24.
 · drv/opt_bydd_trd 를 하루씩 받아 정규장(야간 제외) 코스피200 옵션의 풋·콜 거래량/거래대금/미결제약정으로 비율을 만든다.
 · 그 비율이 같은 날·다음 거래일·다음 3일 삼성전자·SK하이닉스(평균) / 코스피200 선물 수익률, 외국인 선물 순매수와 어떤 관계였는지 본다.
KRX 인증키는 환경변수 KRX_API_KEY 로만 읽고 출력하지 않는다. 사용법: python 186_opt_pcr_study.py [시작YYYYMMDD] [끝YYYYMMDD]"""
import os,sys,time,datetime as dt,requests,psycopg2,numpy as np,pandas as pd,holidays
KEY=os.environ.get("KRX_API_KEY","").strip()
BASE="https://data-dbg.krx.co.kr/svc/apis/drv/opt_bydd_trd"
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
D0=dt.datetime.strptime(sys.argv[1],"%Y%m%d").date() if len(sys.argv)>1 else dt.date(2026,9,1)
D1=dt.datetime.strptime(sys.argv[2],"%Y%m%d").date() if len(sys.argv)>2 else dt.date(2026,11,24)
out=[]
def p(s=""): out.append(str(s)); print(s,flush=True)
def num(x):
    try:
        s=str(x).replace(",","").strip(); return float(s) if s not in ("","-") else 0.0
    except Exception: return 0.0
def get(bd):
    for k in range(3):
        try:
            r=requests.get(BASE,params={"basDd":bd},headers={**UA,"AUTH_KEY":KEY},timeout=60)
            if r.status_code==200: return r.json().get("OutBlock_1") or []
            if r.status_code in (401,403,404): p(f"- {bd}: HTTP {r.status_code}"); return None
        except Exception as e: p(f"- {bd}: {str(e).replace(KEY,'***')[:100]}")
        time.sleep(1.5*(k+1))
    return None
KR=holidays.country_holidays("KR",years=[D0.year,D1.year])
rows=[];prods={};d=D0;ndays=0
while d<=D1:
    if d.weekday()<5 and d not in KR:
        r=get(d.strftime("%Y%m%d")); ndays+=1
        if r:
            reg=[x for x in r if "야간" not in str(x.get("ISU_NM","")) and "야간" not in str(x.get("MKT_NM",""))]
            for x in reg:
                pn=str(x.get("PROD_NM","")).replace(" ","")
                if "코스피200" in pn and "미니" not in pn and "옵션" in pn:
                    rows.append((d,pn,str(x.get("RGHT_TP_NM","")).upper(),num(x.get("ACC_TRDVOL")),num(x.get("ACC_TRDVAL")),num(x.get("ACC_OPNINT_QTY"))))
            if d in (D0,D1) or not prods:
                for x in reg: prods[str(x.get("PROD_NM",""))]=prods.get(str(x.get("PROD_NM","")),0)+num(x.get("ACC_TRDVOL"))
        time.sleep(0.4)
    d+=dt.timedelta(days=1)
O=pd.DataFrame(rows,columns=["d","prod","cp","vol","val","oi"])
p(f"# 코스피200 옵션 풋/콜 비율 검증 — {D0} ~ {D1}\n")
p(f"- 요청 평일 {ndays}일, 옵션 행 {len(O)}건, 자료가 있는 거래일 {O['d'].nunique() if len(O) else 0}일")
p("- 첫 자료일 상품별 거래량(정규장): "+", ".join(f"{k} {v:,.0f}" for k,v in sorted(prods.items(),key=lambda z:-z[1])[:8]))
if not len(O): p("\n옵션 자료가 없어 중단"); open("opt_pcr_study.md","w",encoding="utf-8").write("\n".join(out)); sys.exit(0)
O["d"]=pd.to_datetime(O["d"]); O["cp"]=O["cp"].map(lambda s:"PUT" if "PUT" in s or "풋" in s else "CALL" if "CALL" in s or "콜" in s else "?")
p("- 상품 구분: "+", ".join(sorted(O["prod"].unique())[:10])+" / 권리구분: "+", ".join(sorted(O["cp"].unique())))
def agg(df):
    g=df.groupby(["d","cp"])[["vol","val","oi"]].sum().unstack("cp")
    r=pd.DataFrame(index=g.index)
    r["pv"]=g[("vol","PUT")]; r["cv"]=g[("vol","CALL")]
    r["pcr_v"]=g[("vol","PUT")]/g[("vol","CALL")]; r["pcr_a"]=g[("val","PUT")]/g[("val","CALL")]; r["pcr_o"]=g[("oi","PUT")]/g[("oi","CALL")]
    return r.replace([np.inf,-np.inf],np.nan)
A=agg(O[O["prod"]=="코스피200옵션"]); B=agg(O)   # A: 월물 중심 · B: 위클리 포함 전체
if A.empty: A=B
p(f"- 월물(코스피200옵션) 거래일 {len(A)}일 · 위클리 포함 {len(B)}일")
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True,autocommit=True)
Q=lambda s:pd.read_sql(s,c)
P=Q(f"select trade_date d,code,open,close from daily_price where code in ('005930','000660') and trade_date>='{D0-dt.timedelta(days=10)}' order by 1")
P["d"]=pd.to_datetime(P["d"]); w=P.pivot(index="d",columns="code")
df=pd.DataFrame(index=w.index)
for c_,k in (("005930","s"),("000660","h")): df[k]=w["close"][c_].astype(float).pct_change()*100
df["big"]=df[["s","h"]].mean(axis=1)
F=Q("select trade_date d,close,chg from krx_fut_daily where sym='K200' order by 1"); F["d"]=pd.to_datetime(F["d"]); F=F.set_index("d").astype(float)
df["k200"]=F["chg"]/(F["close"]-F["chg"])*100
M=Q("select trade_date d,foreign_net from market_investor_daily where market='FUT' order by 1"); M["d"]=pd.to_datetime(M["d"]); df["fF"]=M.set_index("d")["foreign_net"].astype(float)
df["y1"]=df["big"].shift(-1); df["y3"]=df["big"].shift(-1)+df["big"].shift(-2)+df["big"].shift(-3); df["k1"]=df["k200"].shift(-1)
def tcorr(a,b,m="pearson"):
    x=pd.concat([a,b],axis=1).dropna()
    if len(x)<8: return None
    r=x.iloc[:,0].corr(x.iloc[:,1],method=m); return r,r*np.sqrt((len(x)-2)/max(1e-9,1-r*r)),len(x)
def fm(t): return "n<8" if t is None else f"{t[0]:+.2f} (t={t[1]:+.1f}, n={t[2]})"
def study(name,R):
    p(f"\n## {name}")
    x=df.join(R,how="inner").loc[D0.strftime("%Y-%m-%d"):]
    x["z"]=(x["pcr_v"]-x["pcr_v"].rolling(20,min_periods=10).mean())/x["pcr_v"].rolling(20,min_periods=10).std()
    x["dp"]=x["pcr_v"].diff()
    p(f"거래일 {len(x)}일 · 풋/콜 거래량 비율 평균 {x.pcr_v.mean():.2f} (최소 {x.pcr_v.min():.2f} ~ 최대 {x.pcr_v.max():.2f}) · 미결제 비율 평균 {x.pcr_o.mean():.2f}\n")
    p("### 상관 (피어슨 / 스피어만, 괄호는 t값) — |t|≥2 정도가 있어야 우연이 아닐 가능성이 생김")
    p("| 지표 | 같은 날 삼성·하이닉스 | 다음날 삼성·하이닉스 | 다음3일 합 | 다음날 코스피200선물 | 같은 날 외국인 선물(억) | 다음날 외국인 선물(억) |"); p("|---|---|---|---|---|---|---|")
    for lb,col in (("풋/콜 거래량","pcr_v"),("풋/콜 거래대금","pcr_a"),("풋/콜 미결제","pcr_o"),("거래량 비율 z(20일)","z"),("거래량 비율 전일차","dp")):
        s=x[col]; fF1=x["fF"].shift(-1)
        p(f"| {lb} | {fm(tcorr(s,x['big']))} | {fm(tcorr(s,x['y1']))} | {fm(tcorr(s,x['y3']))} | {fm(tcorr(s,x['k1']))} | {fm(tcorr(s,x['fF']))} | {fm(tcorr(s,fF1))} |")
    p("\n### 거래량 비율을 3등분했을 때 다음날 삼성·하이닉스 평균 수익률(%)  — 높음=풋 우세")
    d=x.dropna(subset=["pcr_v","y1"])
    if len(d)>=15:
        d=d.assign(g=pd.qcut(d["pcr_v"].rank(method="first"),3,labels=["낮음(콜 우세)","중간","높음(풋 우세)"]))
        p("| 구간 | n | 비율 평균 | 다음날 평균% | 상승비율 | 다음3일 평균% |"); p("|---|---:|---:|---:|---:|---:|")
        for k,g in d.groupby("g",observed=True): p(f"| {k} | {len(g)} | {g.pcr_v.mean():.2f} | {g.y1.mean():+.2f} | {(g.y1>0).mean()*100:.0f}% | {g.y3.mean():+.2f} |")
        hi,lo=d[d.g=="높음(풋 우세)"]["y1"],d[d.g=="낮음(콜 우세)"]["y1"]
        se=np.sqrt(hi.var(ddof=1)/len(hi)+lo.var(ddof=1)/len(lo)); p(f"\n높음−낮음 차이 {hi.mean()-lo.mean():+.2f}%p (t={(hi.mean()-lo.mean())/se:+.1f}) · 전체 평균 {d.y1.mean():+.2f}%")
    p("\n### 일별 표 (최근 20일)"); p("| 날짜 | 풋 거래량 | 콜 거래량 | 풋/콜 거래량 | 풋/콜 대금 | 풋/콜 미결제 | 삼성·하이닉스% | 외국인 선물(억) |"); p("|---|---:|---:|---:|---:|---:|---:|---:|")
    for i,r in x.tail(20).iterrows(): p(f"| {i.date()} | {r.pv:,.0f} | {r.cv:,.0f} | {r.pcr_v:.2f} | {r.pcr_a:.2f} | {r.pcr_o:.2f} | {r.big:+.2f} | {r.fF:+,.0f} |")
study("A. 코스피200 옵션 (월물 중심, 위클리 제외)",A)
study("B. 코스피200 옵션 전체 (위클리 포함, 미니 제외)",B)
p("\n## 읽는 법·주의\n- 표본이 약 2.5개월(50여 거래일)이라 상관이 |0.3| 이하이거나 |t|<2 이면 사실상 '관계 없음'으로 봅니다.\n- 같은 날 상관은 '그날 시장 상황을 반영'한 것이고, 투자에 쓸 수 있는 건 '다음날·다음3일' 열입니다.\n- 여러 지표를 한꺼번에 보면 우연히 하나는 맞아 보일 수 있습니다. 한 지표만 유의하면 의심하세요.")
open("opt_pcr_study.md","w",encoding="utf-8").write("\n".join(out))
