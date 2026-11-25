# -*- coding: utf-8 -*-
"""인버스 ETF 숏 전략 0단계 검증(읽기 전용, 2026-11-26): 기간 FROM~TO(기본 2026-08-01~2026-11-25, 하락장 구간).
 · 상품: etf_master 에서 이름에 '인버스' 가 들어간 ETF 중 기간 거래대금 상위 + 코스피200 1X(114800)·2X(252670)
 · 신호(오늘 종가 기준 → 다음 거래일 실행)
   S1  코스피200(069500 대리) < 60일선 & 3일 수익률 ≥ +4%  → 다음날 시가 매수 5거래일 보유
   S2a 외국인 코스피 현물− & 선물− → 다음날 시가 매수 · 종가 청산(장중)
   S2b 외국인 현물+ & 선물− & 다음날 삼성·하이닉스 시가 갭 ≥ +1% → 다음날 시가 매수 · 종가 청산
   기타 비교: 매일 장중(기준선), 반도체 +3% 이상 다음날, 반도체 −2% 이하 다음날(추세 지속), VKOSPI 5일 +5 이상
 · 장중 모의 두 가지: 종가 청산 / 손절 −1.5%·익절 +1.5%(50%)·+2.5%(50%) (같은 날 손절·익절 둘 다 닿으면 손절 먼저 — 보수적)
 · 비용 0.1%(ETF는 거래세 없음: 수수료+슬리피지 가정)."""
import os, sys, numpy as np, pandas as pd, psycopg2
FROM = os.environ.get("FROM_D", "2026-08-01"); TO = os.environ.get("TO_D", "2026-11-25"); COST = 0.10
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)

# ── 상품
M = Q("select code,name,flags,field from etf_master where name like '%인버스%'")
A = Q(f"select code,sum(amount)/count(*) amt,count(*) n from etf_daily where trade_date between '{FROM}' and '{TO}' and code in ({','.join(repr(x) for x in M.code)}) group by code")
M = M.merge(A, on="code").sort_values("amt", ascending=False)
p(f"# 인버스 ETF 숏 전략 0단계 검증 — {FROM} ~ {TO}")
p(f"\n## 인버스 ETF 거래대금 상위(기간 일평균)\n| 코드 | 이름 | 일평균 거래대금(억) | 거래일 |\n|---|---|---:|---:|")
for _, r in M.head(15).iterrows(): p(f"| {r.code} | {r['name']} | {r.amt/1e8:,.0f} | {r.n} |")
semi_inv = M[M.name.str.contains("삼성전자|SK하이닉스|하이닉스|반도체")].head(4)
INS = {"114800": "코스피200 인버스 1X", "252670": "코스피200 선물인버스 2X"}
for _, r in semi_inv.iterrows(): INS[r.code] = r["name"]
codes = list(INS) + ["069500"]
E = Q(f"select code,trade_date d,open,high,low,close from etf_daily where code in ({','.join(repr(x) for x in codes)}) and trade_date>='2026-03-01' order by 2")
E["d"] = pd.to_datetime(E["d"]); E[["open", "high", "low", "close"]] = E[["open", "high", "low", "close"]].astype(float)
px = {k: g.set_index("d")[["open", "high", "low", "close"]] for k, g in E.groupby("code")}

# ── 시장·신호
P = Q("select trade_date d,code,open,close,change_pct from daily_price where code in ('005930','000660') and trade_date>='2026-03-01' order by 1")
P["d"] = pd.to_datetime(P["d"]); w = P.pivot(index="d", columns="code")
df = pd.DataFrame(index=w.index)
cl, op = w["close"].astype(float), w["open"].astype(float)
df["semi"] = w["change_pct"].astype(float).mean(axis=1)
df["semi_gap_next"] = ((op / cl.shift(1) - 1) * 100).mean(axis=1).shift(-1)
k = px["069500"]["close"]; df["k"] = k; df["ma60"] = k.rolling(60).mean(); df["r3"] = (k / k.shift(3) - 1) * 100; df["kret"] = k.pct_change() * 100
X = Q("select trade_date d,foreign_net from market_investor_detail where market='KOSPI' order by 1"); X["d"] = pd.to_datetime(X["d"]); df["fK"] = X.set_index("d")["foreign_net"].astype(float)
F = Q("select trade_date d,foreign_net from market_investor_daily where market='FUT' order by 1"); F["d"] = pd.to_datetime(F["d"]); df["fF"] = F.set_index("d")["foreign_net"].astype(float)
V = Q("select trade_date d,close from vkospi_daily order by 1"); V["d"] = pd.to_datetime(V["d"]); df["vk"] = V.set_index("d")["close"].astype(float); df["dvk5"] = df["vk"] - df["vk"].shift(5)
D = df[(df.index >= FROM) & (df.index <= TO)].copy()
days = list(df.index)
k0, k1 = D.k.dropna().iloc[0], D.k.dropna().iloc[-1]
s_cum = (1 + D.semi / 100).prod() - 1
p(f"\n## 기간 시장\n- 코스피200(KODEX 200) {k0:,.0f} → {k1:,.0f} ({(k1/k0-1)*100:+.1f}%) · 삼성·하이닉스 평균 누적 {s_cum*100:+.1f}% · 거래일 {len(D)}")
p(f"- 반도체 일평균 {D.semi.mean():+.2f}% · 하락일 비율 {(D.semi<0).mean()*100:.0f}% · 코스피200 60일선 아래 날 {(D.k<D.ma60).mean()*100:.0f}%")
for code, nm in INS.items():
    if code in px:
        x = px[code]; x = x[(x.index >= FROM) & (x.index <= TO)]
        if len(x): p(f"- {nm}({code}) 그냥 보유: {(x.close.iloc[-1]/x.open.iloc[0]-1)*100:+.1f}%")

def nxt(d, n=1):
    i = days.index(d); return days[i + n] if i + n < len(days) else None

def intraday(code, d1, mode):
    x = px.get(code)
    if x is None or d1 not in x.index: return None
    o, h, l, c_ = x.loc[d1]
    if not (o > 0): return None
    if mode == "close": return (c_ / o - 1) * 100 - COST
    if l <= o * 0.985: return -1.5 - COST
    r = 0.0
    r += 0.5 * (1.5 if h >= o * 1.015 else (c_ / o - 1) * 100)
    r += 0.5 * (2.5 if h >= o * 1.025 else (c_ / o - 1) * 100)
    return r - COST

def swing(code, d1, hold=5, stop=3.0):
    x = px.get(code)
    if x is None or d1 not in x.index: return None
    i = x.index.get_loc(d1); o = x.open.iloc[i]
    for j in range(i, min(i + hold, len(x))):
        if x.close.iloc[j] <= o * (1 - stop / 100): return (x.close.iloc[j] / o - 1) * 100 - COST
    j = min(i + hold - 1, len(x) - 1); return (x.close.iloc[j] / o - 1) * 100 - COST

def stats(rs):
    rs = [r for r in rs if r is not None and not np.isnan(r)]
    if not rs: return "0 | – | – | – | – | –"
    a = np.array(rs); wins, loss = a[a > 0].sum(), -a[a < 0].sum()
    pf = wins / loss if loss > 0 else float("inf")
    t = a.mean() / (a.std(ddof=1) / np.sqrt(len(a))) if len(a) > 2 and a.std() > 0 else float("nan")
    return f"{len(a)} | {(a>0).mean()*100:.0f}% | {a.mean():+.2f}% | {pf:.2f} | {t:+.1f} | {a.sum():+.1f}%"

SIG = {
    "매일(기준선)": D.index,
    "S2a 외국인 현물− 선물−": D.index[(D.fK < 0) & (D.fF < 0)],
    "S2b 현물+ 선물− · 다음날 갭≥+1%": D.index[(D.fK > 0) & (D.fF < 0) & (D.semi_gap_next >= 1)],
    "반도체 +3% 이상 다음날": D.index[D.semi >= 3],
    "반도체 −2% 이하 다음날(지속)": D.index[D.semi <= -2],
    "VKOSPI 5일 +5 이상": D.index[D.dvk5 >= 5],
    "S2a + 코스피200 60일선 아래": D.index[(D.fK < 0) & (D.fF < 0) & (D.k < D.ma60)],
    "S2a + 반도체 당일 하락": D.index[(D.fK < 0) & (D.fF < 0) & (D.semi < 0)],
}
p(f"\n## 장중 숏(다음날 시가 매수 → 같은 날 청산)\n표 = 거래 | 승률 | 평균 | 손익비 | t | 합계. 비용 {COST}% 포함.")
for code, nm in INS.items():
    if code not in px: continue
    for mode, ml in (("close", "종가 청산"), ("tp", "손절 −1.5% · 익절 +1.5/+2.5")):
        p(f"\n### {nm}({code}) — {ml}\n| 신호 | 거래 | 승률 | 평균 | 손익비 | t | 합계 |\n|---|---:|---:|---:|---:|---:|---:|")
        for s, idx in SIG.items(): p(f"| {s} | {stats([intraday(code, nxt(d), mode) for d in idx if nxt(d)])} |")

S1 = D.index[(D.k < D.ma60) & (D.r3 >= 4)]
p(f"\n## S1 지수 반등 매도(코스피200 < 60일선 & 3일 +4%) → 다음날 시가 매수 5거래일 · 손절 −3%(종가)\n- 신호일: {', '.join(x.strftime('%m-%d') for x in S1) or '없음'}")
p("| 상품 | 거래 | 승률 | 평균 | 손익비 | t | 합계 |\n|---|---:|---:|---:|---:|---:|---:|")
for code, nm in INS.items():
    if code in px: p(f"| {nm} | {stats([swing(code, nxt(d)) for d in S1 if nxt(d)])} |")
S1b = D.index[(D.k < D.ma60) & (D.r3 >= 2)]
p("\n완화(3일 +2%):\n| 상품 | 거래 | 승률 | 평균 | 손익비 | t | 합계 |\n|---|---:|---:|---:|---:|---:|---:|")
for code, nm in INS.items():
    if code in px: p(f"| {nm} | {stats([swing(code, nxt(d)) for d in S1b if nxt(d)])} |")

# 월별: S2a(2X, 종가 청산)
p("\n## 월별 — S2a 외국인 현물− 선물−, 2X 종가 청산")
p("| 월 | 거래 | 승률 | 평균 | 손익비 | t | 합계 |\n|---|---:|---:|---:|---:|---:|---:|")
idx = SIG["S2a 외국인 현물− 선물−"]
for m, g in pd.Series(idx, index=idx).groupby(idx.to_period("M")): p(f"| {m} | {stats([intraday('252670', nxt(d), 'close') for d in g if nxt(d)])} |")
p(f"\n## 데이터 범위\n- 외국인 선물 {D.fF.notna().sum()}일 · 외국인 현물 {D.fK.notna().sum()}일 · VKOSPI {D.vk.notna().sum()}일")

# ── 추가: S1 겹침 제거 · 아무 날 5일 보유 기준선
def s1_nonover(code, idx):
    rs, busy = [], None
    for d in idx:
        d1 = nxt(d)
        if d1 is None or (busy is not None and d1 <= busy): continue
        rs.append(swing(code, d1)); busy = nxt(d, 5)
    return rs
p("\n## S1 겹침 제거(보유 중 신호는 건너뜀) vs 아무 날 5일 보유(기준선)")
p("| 상품 | S1 겹침 제거 | 기준선(매일 5일 보유) |\n|---|---|---|")
for code, nm in INS.items():
    if code in px: p(f"| {nm} | {stats(s1_nonover(code, S1))} | {stats([swing(code, nxt(d)) for d in D.index if nxt(d)])} |")

# ── 추가: 국면 추종 보유(조건이 켜진 날 종가에 사서, 꺼진 날 종가에 판다 — 종가→종가)
k_ = df["k"]; df["ma20"] = k_.rolling(20).mean(); df["ma5"] = k_.rolling(5).mean()
R = {
  "코스피200 < 20일선": df.k < df.ma20,
  "코스피200 < 60일선": df.k < df.ma60,
  "20일선·60일선 모두 아래": (df.k < df.ma20) & (df.k < df.ma60),
  "5일선 < 20일선": df.ma5 < df.ma20,
}
p("\n## 국면 추종 보유(종가 판정 → 그 종가에 사고/팔기, 종가→종가 수익) · 전환마다 비용 0.1%")
p("| 상품 | 조건 | 보유일 | 전환 | 누적 | 최대 낙폭 | 그냥 보유 |\n|---|---|---:|---:|---:|---:|---:|")
for code, nm in INS.items():
    if code not in px: continue
    x = px[code]["close"]; r = x.pct_change()
    bh = x[(x.index >= FROM) & (x.index <= TO)]; bhr = (bh.iloc[-1] / bh.iloc[0] - 1) * 100
    for lab, cond in R.items():
        pos = cond.reindex(x.index).fillna(False).astype(int).shift(1).fillna(0)
        rr = (pos * r).fillna(0); sw = pos.diff().abs().fillna(0)
        rr = rr - sw * COST / 100
        rr = rr[(rr.index > FROM) & (rr.index <= TO)]; pp = pos[(pos.index > FROM) & (pos.index <= TO)]
        eq = (1 + rr).cumprod(); mdd = ((eq / eq.cummax()) - 1).min() * 100
        p(f"| {nm} | {lab} | {int(pp.sum())} | {int(sw[(sw.index > FROM) & (sw.index <= TO)].sum())} | {(eq.iloc[-1]-1)*100:+.1f}% | {mdd:.1f}% | {bhr:+.1f}% |")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
