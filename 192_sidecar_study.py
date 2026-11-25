# -*- coding: utf-8 -*-
"""사이드카 역방향 매매 검증(읽기 전용, 2026-11-26).
 매수 사이드카 날 → 장 마감 전(종가) 인버스 매수, 매도 사이드카 날 → 종가 레버리지(또는 1X) 매수.
 청산: 다음날 시가 / 다음날 종가 / 2일째 종가. 비용 0.1%. 사이드카 날짜 = market_events(kind='sidecar', 확정·추정)."""
import os, numpy as np, pandas as pd, psycopg2
COST = 0.10
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)

E = Q("select event_date d,title,source from market_events where kind='sidecar' order by 1")
E["d"] = pd.to_datetime(E["d"])
E["dir"] = np.where(E.title.str.contains("매수"), "buy", np.where(E.title.str.contains("매도"), "sell", "?"))
E["source"] = np.where(E.title.str.contains("추정"), "추정", "발동(확정)")
E["mkt"] = np.where(E.title.str.contains("코스닥"), "코스닥", "코스피")
p("# 사이드카 역방향 매매 검증\n")
p(f"- 사이드카 기록 {len(E)}건 · 기간 {E.d.min().date()} ~ {E.d.max().date()}")
p(f"- 출처별: {E.source.value_counts().to_dict()} · 시장별: {E.mkt.value_counts().to_dict()} · 방향별: {E.dir.value_counts().to_dict()}")
p("- 제목 예: " + " / ".join(E.title.drop_duplicates().head(6)))

M = Q("select code,name from etf_master where (name like '%인버스%' or name like '%레버리지%' or name like '%2X%') ")
A = Q("select code,sum(amount)/count(*) amt from etf_daily where trade_date>='2026-06-01' group by code")
M = M.merge(A, on="code")
pick = lambda pat, n=3: M[M.name.str.contains(pat)].sort_values("amt", ascending=False).head(n)
INV = {"114800": "KODEX 인버스(1X)", "252670": "KODEX 200선물인버스2X"}
for _, r in pick("하이닉스.*인버스|삼성전자.*인버스", 2).iterrows(): INV[r.code] = r["name"]
LEV = {"069500": "KODEX 200(1X)", "122630": "KODEX 레버리지(2X)"}
for _, r in pick("반도체.*레버리지|레버리지.*반도체", 2).iterrows(): LEV[r.code] = r["name"]
for _, r in pick("하이닉스.*레버리지|삼성전자.*레버리지|하이닉스.*2X$|삼성전자.*2X$", 2).iterrows():
    if "인버스" not in r["name"]: LEV[r.code] = r["name"]
codes = list(INV) + list(LEV)
X = Q(f"select code,trade_date d,open,close from etf_daily where code in ({','.join(repr(x) for x in codes)}) order by 2")
S = Q("select code,trade_date d,open,close from daily_price where code in ('005930','000660') order by 2")
X = pd.concat([X, S]); X["d"] = pd.to_datetime(X["d"]); X[["open", "close"]] = X[["open", "close"]].astype(float)
px = {k: g.set_index("d")[["open", "close"]] for k, g in X.groupby("code")}
INV["반도체현물"] = None; LEV["005930"] = "삼성전자 현물"; LEV["000660"] = "SK하이닉스 현물"; INV.pop("반도체현물")

def ret(code, d, how):
    x = px.get(code)
    if x is None or d not in x.index: return None
    i = x.index.get_loc(d); e = x.close.iloc[i]
    if i + 1 >= len(x): return None
    if how == "다음날 시가": v = x.open.iloc[i + 1]
    elif how == "다음날 종가": v = x.close.iloc[i + 1]
    else:
        if i + 2 >= len(x): return None
        v = x.close.iloc[i + 2]
    return (v / e - 1) * 100 - COST

def stats(rs):
    a = np.array([r for r in rs if r is not None])
    if not len(a): return "0 | – | – | – | – | –"
    w, l = a[a > 0].sum(), -a[a < 0].sum(); pf = w / l if l > 0 else float("inf")
    t = a.mean() / (a.std(ddof=1) / np.sqrt(len(a))) if len(a) > 2 and a.std() > 0 else float("nan")
    return f"{len(a)} | {(a>0).mean()*100:.0f}% | {a.mean():+.2f}% (중앙 {np.median(a):+.2f}%) | {pf:.2f} | {t:+.1f} | {a.sum():+.1f}%"

HOW = ["다음날 시가", "다음날 종가", "2일째 종가"]
def table(title, days, U):
    p(f"\n### {title} — 사이드카 날 {len(days)}일\n| 상품 | 청산 | 거래 | 승률 | 평균 | 손익비 | t | 합계 |\n|---|---|---:|---:|---:|---:|---:|---:|")
    for code, nm in U.items():
        for h in HOW: p(f"| {nm}({code}) | {h} | {stats([ret(code, d, h) for d in days])} |")

days = lambda dr, src=None, mkt=None, lo=None, hi=None: sorted(set(E[(E.dir == dr) & ((E.source == src) if src else True) & ((E.mkt == mkt) if mkt else True) & ((E.d >= lo) if lo else True) & ((E.d <= hi) if hi else True)].d))
p("\n## 1. 매수 사이드카 → 종가 인버스 매수")
table("전체", days("buy"), INV)
table("하락장 2026-08-01 이후", days("buy", lo="2026-08-01"), INV)
table("그 전", days("buy", hi="2026-07-31"), INV)
p("\n## 2. 매도 사이드카 → 종가 레버리지·1X 매수")
table("전체", days("sell"), LEV)
table("하락장 2026-08-01 이후", days("sell", lo="2026-08-01"), LEV)
table("그 전", days("sell", hi="2026-07-31"), LEV)
p("\n## 3. 발동(확정) vs 추정")
for src in E.source.dropna().unique():
    table(f"매수 · {src}", days("buy", src=src), INV)
    table(f"매도 · {src}", days("sell", src=src), LEV)
p("\n## 4. 사건별(코스피200 1X·2X, 다음날 종가 청산)")
p("| 날짜 | 방향 | 시장 | 출처 | 인버스1X | 인버스2X | KODEX200 | 레버리지2X |\n|---|---|---|---|---:|---:|---:|---:|")
f = lambda v: "–" if v is None else f"{v:+.2f}%"
for _, r in E.iterrows():
    p(f"| {r.d.date()} | {'매수' if r.dir=='buy' else '매도'} | {r.mkt} | {r.source} | {f(ret('114800', r.d, '다음날 종가'))} | {f(ret('252670', r.d, '다음날 종가'))} | {f(ret('069500', r.d, '다음날 종가'))} | {f(ret('122630', r.d, '다음날 종가'))} |")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
