# -*- coding: utf-8 -*-
"""눌림목 백테스트 사례 점검(읽기 전용): 안랩(053800)의 무게/주식수 큰 날과, 신호일마다 그때 알던 1·2위일(시점 일치) 및 기준가."""
import os, numpy as np, pandas as pd, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
CODE = os.environ.get("CODE", "053800")
g = pd.read_sql(f"select trade_date d,open o,high h,low l,close c,volume v,trade_amount a,change_pct chg,weight_per_share w,market_cap mc from daily_price where code='{CODE}' and close>0 order by 1", c)
g["d"] = pd.to_datetime(g["d"]).dt.date; g = g.drop_duplicates("d", keep="last").reset_index(drop=True)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)
p(f"# {CODE} 무게/주식수 점검\n")
p("## 무게 0.05 이상인 날(전체 이력)\n\n| 날짜 | 무게 | 등락% | 종가 | 평균가(거래대금÷거래량) | 거래대금(억) |\n|---|---:|---:|---:|---:|---:|")
for r in g[g.w >= 0.05].itertuples():
    p(f"| {r.d} | {r.w:.2f} | {r.chg:+.1f} | {r.c:,.0f} | {(r.a/r.v if r.v>0 else float('nan')):,.0f} | {r.a/1e8:,.0f} |")
w = g.w.fillna(0).values; n = len(g)
def levels_at(t):   # t 일 장중에 아는 자료(t−1 까지)의 1·2위일
    d1 = -1; w1 = 0.0; d2 = -1; w2 = 0.0
    for i in range(t):
        if w[i] > w1: d1, w1, d2, w2 = i, w[i], -1, 0.0
        elif d1 >= 0 and i > d1 and w[i] > w2: d2, w2 = i, w[i]
    return d1, d2
p("\n## 날짜별로 그때 알던 1·2위일(시점 일치) — 종가 기준가 대비 위치\n\n| 기준일 | 종가 | 1위일(무게) | 기준가 | 대비 | 2위일(무게) | 기준가 | 대비 |\n|---|---:|---|---:|---:|---|---:|---:|")
for ds in ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-20", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-04", "2026-11-25", "2026-11-26"]:
    t = g.index[g.d == pd.Timestamp(ds).date()]
    if not len(t): continue
    t = int(t[0]); d1, d2 = levels_at(t); cl = g.c[t]
    def f(i):
        if i < 0: return "–", "–", "–"
        vw = g.a[i] / g.v[i]; return f"{g.d[i]} ({w[i]:.2f})", f"{vw:,.0f}", f"{(cl/vw-1)*100:+.1f}%"
    a1, b1, c1 = f(d1); a2, b2, c2 = f(d2)
    p(f"| {ds} | {cl:,.0f} | {a1} | {b1} | {c1} | {a2} | {b2} | {c2} |")
p("\n## 10/01~11/05 종가·무게\n\n| 날짜 | 종가 | 등락% | 무게 |\n|---|---:|---:|---:|")
for r in g[(g.d >= pd.Timestamp('2026-10-01').date()) & (g.d <= pd.Timestamp('2026-11-05').date())].itertuples(): p(f"| {r.d} | {r.c:,.0f} | {r.chg:+.1f} | {r.w:.2f} |")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
