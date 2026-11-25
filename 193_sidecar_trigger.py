# -*- coding: utf-8 -*-
"""사이드카 대리 신호 검증(읽기 전용, 2026-11-26): 장중에 사이드카를 못 보므로 KODEX200(069500)·코스피 지수 일 등락률이 사이드카 날을 얼마나 잡는지.
 종가 기준 등락률(15:10 시점의 근사) — 임계값별 잡은 수·헛신호 수."""
import os, numpy as np, pandas as pd, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)
E = Q("select event_date d,title from market_events where kind='sidecar' order by 1"); E["d"] = pd.to_datetime(E["d"])
E["dir"] = np.where(E.title.str.contains("매수"), "buy", "sell"); E["est"] = E.title.str.contains("추정")
K = Q("select trade_date d,close from etf_daily where code='069500' order by 1"); K["d"] = pd.to_datetime(K["d"]); K = K.set_index("d").close.astype(float)
K = (K / K.shift(1) - 1) * 100
M = Q("select trade_date d,index_close from market_daily where market='KOSPI' order by 1"); M["d"] = pd.to_datetime(M["d"]); M = M.set_index("d").index_close.astype(float)
M = (M / M.shift(1) - 1) * 100
S = set(E[E.dir == "sell"].d)
p("# 사이드카 대리 신호(종가 기준 일 등락률)\n")
p(f"- KODEX200 일봉 {K.notna().sum()}일 · 코스피 지수 {M.notna().sum()}일 · 매도 사이드카 {len(S)}건")
p("\n## 매도 사이드카 날의 등락률\n| 날짜 | 출처 | KODEX200 | 코스피 |\n|---|---|---:|---:|")
for _, r in E[E.dir == "sell"].iterrows():
    p(f"| {r.d.date()} | {'추정' if r.est else '발동'} | {K.get(r.d, float('nan')):+.2f}% | {M.get(r.d, float('nan')):+.2f}% |")
p("\n## 임계값별: 등락률 ≤ −x% 인 날 중 매도 사이드카 비율\n| 기준 | 상품 | x | 해당 날 | 그중 사이드카 | 전체 사이드카 중 잡은 수 |\n|---|---|---:|---:|---:|---:|")
for nm, s in [("KODEX200", K), ("코스피", M)]:
    for x in [2, 2.5, 3, 3.5, 4, 5, 6]:
        d = set(s[s <= -x].index); hit = len(d & S)
        p(f"| 종가 | {nm} | {x} | {len(d)} | {hit} | {hit}/{len(S)} |")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
