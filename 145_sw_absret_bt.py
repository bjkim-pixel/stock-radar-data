# -*- coding: utf-8 -*-
"""절대수익 전략 백테스트(읽기 전용). 2026-08~11(검증 구간)과 2025-09~2026-07(이전 구간)을 같은 규칙으로 모의.
- 체결: 신호일 종가. 수급 신호는 전일까지 값만 사용(당일 수급은 장 마감 후 확정이므로).
- 비용: 주식 매수·매도 각 0.125%(왕복 0.25%), ETF·지수 각 0.03%.
사용: SUPABASE_DB_URL=... python 145_sw_absret_bt.py > sw_research_report.md"""
import os, itertools
import numpy as np, pandas as pd, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.set_session(readonly=True, autocommit=True)
P = print
CS, CE = 0.00125, 0.0003
P1 = pd.Timestamp("2026-08-01"); P1b = pd.Timestamp("2026-10-01")

px = pd.read_sql("""select p.trade_date d, p.code, s.name, p.close c, p.change_pct chg, p.trade_amount amt, p.market_cap cap,
                           coalesce(f.foreign_net,0) fo, coalesce(f.inst_net,0) ins, coalesce(f.individual_net,0) ind
                    from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
                    left join daily_flow f on f.code=p.code and f.trade_date=p.trade_date where p.close>0""", conn)
for c in ["c", "chg", "amt", "cap", "fo", "ins", "ind"]: px[c] = pd.to_numeric(px[c], errors="coerce")
px["d"] = pd.to_datetime(px["d"])
ix = pd.read_sql("select trade_date d, market mk, index_close c from market_daily where index_close is not null and market in ('KOSPI','KOSDAQ') and extract(isodow from trade_date) between 1 and 5", conn)
ix["d"] = pd.to_datetime(ix["d"]); ix["c"] = pd.to_numeric(ix["c"])
KS = ix[ix["mk"] == "KOSPI"].set_index("d")["c"].sort_index()
D = KS.index[KS.index.isin(px["d"].unique())]
KS = KS.reindex(D)
piv = lambda col: px.pivot(index="d", columns="code", values=col).reindex(D)
C = piv("c").ffill(limit=3); R = C.pct_change(); R = R.where(R.abs() <= 0.305)
AMT = piv("amt"); CAP = piv("cap").ffill(limit=3); FO = piv("fo").fillna(0); INS = piv("ins").fillna(0); CHG = piv("chg")
A20 = AMT.rolling(20, min_periods=10).mean(); LIQ = A20 >= 3e9
MA20 = C.rolling(20, min_periods=15).mean()
fo20 = (FO.rolling(20, min_periods=15).sum() / CAP).shift(1)          # 전일까지
in20 = (INS.rolling(20, min_periods=15).sum() / CAP).shift(1)
sm5 = ((FO + INS).rolling(5, min_periods=4).sum() / CAP).shift(1)
sm5_same = (FO + INS).rolling(5, min_periods=4).sum() / CAP            # 당일 포함(낙관적)
r1 = R; r5 = C / C.shift(5) - 1; r20 = C / C.shift(20) - 1
et = pd.read_sql("select code, trade_date d, close c from etf_daily where code in ('114800','252670','0197X0','0193L0','251340')", conn)
et["d"] = pd.to_datetime(et["d"]); et["c"] = pd.to_numeric(et["c"])
ETF = et.pivot(index="d", columns="code", values="c").reindex(D).ffill(limit=3); ER = ETF.pct_change()
kr = KS.pct_change()
INV = ER["114800"].where(ER["114800"].notna(), -kr)                    # KODEX 인버스(없는 날은 -지수)
INV2 = ER["252670"] if "252670" in ER else -2 * kr
ma = {n: KS.rolling(n, min_periods=int(n * 0.7)).mean() for n in (10, 20, 40, 60)}
hi20 = KS.shift(1).rolling(20).max(); lo20 = KS.shift(1).rolling(20).min(); pos20 = (KS - lo20) / (hi20 - lo20)
try:
    fut = pd.read_sql("select trade_date d, foreign_net f from market_investor_daily where market='FUT'", conn); fut["d"] = pd.to_datetime(fut["d"])
    FUT = pd.to_numeric(fut.set_index("d")["f"]).reindex(D)
except Exception: FUT = pd.Series(np.nan, index=D)

# ── 모의 틀: W(종목 비중), wi(지수 매수 비중), wv(인버스 1배 비중), wv2(인버스 2배 비중) — t 종가에 정하고 t→t+1 수익을 받음
def run(W=None, wi=None, wv=None, wv2=None):
    z = pd.Series(0.0, index=D)
    wi = z if wi is None else wi.reindex(D).fillna(0); wv = z if wv is None else wv.reindex(D).fillna(0); wv2 = z if wv2 is None else wv2.reindex(D).fillna(0)
    pr = wi.shift(1) * kr + wv.shift(1) * INV + wv2.shift(1) * INV2
    cost = (wi.diff().abs().fillna(wi.abs()) + wv.diff().abs().fillna(wv.abs()) + wv2.diff().abs().fillna(wv2.abs())) * CE
    gross = wi.abs() + wv.abs() + wv2.abs()
    if W is not None:
        W = W.reindex(D).fillna(0)
        pr = pr.add((W.shift(1) * R).sum(axis=1), fill_value=0)
        cost = cost + (W.diff().abs().sum(axis=1).fillna(W.abs().sum(axis=1))) * CS
        gross = gross + W.abs().sum(axis=1)
    return (pr.fillna(0) - cost.shift(1).fillna(0)), gross
def st(r):
    r = r.dropna()
    if not len(r): return (np.nan,) * 4
    eq = (1 + r).cumprod(); mdd = (eq / eq.cummax() - 1).min()
    sh = r.mean() / r.std() * np.sqrt(252) if r.std() > 0 else np.nan
    return (eq.iloc[-1] - 1) * 100, mdd * 100, sh, (r > 0).sum() / max(1, (r != 0).sum()) * 100
ROWS = []
def rep(name, r, gross, note=""):
    a = st(r[r.index >= P1]); a1 = st(r[(r.index >= P1) & (r.index < P1b)]); a2 = st(r[r.index >= P1b]); b = st(r[r.index < P1])
    ex = (gross[gross.index >= P1] > 0).mean() * 100
    mth = " / ".join(f"{((1 + r[(r.index >= m) & (r.index < m + pd.offsets.MonthBegin(1))]).prod() - 1) * 100:+.1f}" for m in pd.to_datetime(["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"]))
    ROWS.append((name, a, a1, a2, b, ex, mth, note))
    P(f"| {name} | {a[0]:+.1f}% | {a[1]:.1f}% | {a[2]:+.2f} | {ex:.0f}% | {mth} | {b[0]:+.1f}% | {b[1]:.1f}% | {note} |")
HD = "| 전략 | 8~11월 수익 | 최대 낙폭 | 샤프 | 투자 일수 | 8/9/10/11월 | 이전 구간 수익 | 이전 최대 낙폭 | 비고 |\n|---|---|---|---|---|---|---|---|---|"
def hold(sig, k):   # 신호 발생 후 k일 보유(겹치면 연장)
    return (sig.astype(float).rolling(k, min_periods=1).max()).fillna(0)
def topn(score, n, elig, every=5, asc=False):
    W = pd.DataFrame(0.0, index=D, columns=C.columns); last = None
    for i, d in enumerate(D):
        if i % every == 0:
            s = score.loc[d].where(elig.loc[d]).dropna()
            if len(s) >= n:
                pick = (s.nsmallest(n) if asc else s.nlargest(n)).index; last = pd.Series(1.0 / n, index=pick)
        if last is not None: W.loc[d, last.index] = last.values
    return W
def tranche(mask, k):   # 매일 신호 종목을 1/k 비중으로 사서 k일 보유(동일가중)
    m = mask.astype(float); m = m.div(m.sum(axis=1).replace(0, np.nan), axis=0).fillna(0)
    return m.rolling(k, min_periods=1).sum() / k

P("# 절대수익 전략 백테스트 (읽기 전용)")
P(f"- 검증 구간 {D[D>=P1][0]:%Y-%m-%d}~{D[-1]:%Y-%m-%d} ({(D>=P1).sum()}거래일) · 이전 구간 {D[0]:%Y-%m-%d}~2026-07 ({(D<P1).sum()}거래일) · 종목 {C.shape[1]}개")
P(f"- KOSPI: 검증 구간 {(KS[D>=P1].iloc[-1]/KS[D<P1].iloc[-1]-1)*100:+.1f}% · 이전 구간 {(KS[D<P1].iloc[-1]/KS.iloc[0]-1)*100:+.1f}%")
P("- 비용 포함(주식 왕복 0.25%, ETF 왕복 0.06%). 수급 신호는 전일까지 값. 체결은 신호일 종가.")
P("\n## 1. 기준선\n"); P(HD)
rep("KOSPI 보유", *run(wi=pd.Series(1.0, index=D)))
ew = LIQ.astype(float).div(LIQ.sum(axis=1), axis=0); rep("추적 종목 동일가중 보유", *run(W=ew))
rep("KODEX 인버스 보유", *run(wv=pd.Series(1.0, index=D)))

P("\n## 2. 지수 방향 전략(인버스·지수 매수)\n"); P(HD)
for n in (10, 20, 40, 60):
    rep(f"추세 인버스: 지수<{n}일선이면 인버스, 아니면 현금", *run(wv=(KS < ma[n]).astype(float)))
rep("추세 양방향: 지수<20일선 인버스 / >20일선 지수 매수", *run(wv=(KS < ma[20]).astype(float), wi=(KS >= ma[20]).astype(float)))
rep("추세 양방향: 60일선 기준", *run(wv=(KS < ma[60]).astype(float), wi=(KS >= ma[60]).astype(float)))
def boxshort(top=0.8, exit_=0.4, stop=0.03, maxd=10, trend=True, lev=1):
    w = pd.Series(0.0, index=D); i = 0; n = len(D); k = KS.values; p = pos20.values; h = hi20.values; l = lo20.values; m60 = ma[60].values; nt = 0
    while i < n - 1:
        if not np.isnan(p[i]) and top <= p[i] <= 1.0 + 1e-9 and (not trend or k[i] < m60[i]):
            H0, L0 = h[i], l[i]; j = i; nt += 1
            for j in range(i, min(n - 1, i + maxd)):
                w.iloc[j] = 1.0
                pj = (k[j + 1] - L0) / (H0 - L0)
                if k[j + 1] > H0 * (1 + stop) or pj <= exit_: break
            i = j + 1
        else: i += 1
    return w, nt
for trend in (True, False):
    w, nt = boxshort(trend=trend); r, g = run(wv=w); rep(f"박스 상단 인버스(위치 80%↑ 진입, 40%↓ 청산, 상단+3% 손절){' + 60일선 아래' if trend else ''}", r, g, f"전체 {nt}회")
w, nt = boxshort(trend=True); r, g = run(wv2=w); rep("박스 상단 인버스 2배(60일선 아래)", r, g, f"전체 {nt}회")
for top, ex in ((0.7, 0.4), (0.9, 0.4), (0.8, 0.5), (0.8, 0.2)):
    w, nt = boxshort(top=top, exit_=ex); r, g = run(wv=w); rep(f"  · 변형: 진입 {int(top*100)}%↑ / 청산 {int(ex*100)}%↓ (60일선 아래)", r, g, f"전체 {nt}회")
for x, k in ((0.04, 5), (0.03, 5), (0.05, 5), (0.04, 3), (0.04, 10)):
    sig = (KS / KS.shift(3) - 1 >= x) & (KS < ma[60]); rep(f"반등 매도: 60일선 아래에서 3일간 +{int(x*100)}% 이상 오르면 인버스 {k}일", *run(wv=hold(sig, k)), f"신호 {int((sig & ~sig.shift(1).fillna(False)).sum())}회")
for x, k in ((-0.08, 3), (-0.05, 3), (-0.08, 5), (-0.10, 3)):
    sig = (KS / KS.shift(5) - 1 <= x); rep(f"투매 매수: 지수 5일 {int(x*100)}% 이하면 지수 매수 {k}일", *run(wi=hold(sig, k)), f"신호 {int((sig & ~sig.shift(1).fillna(False)).sum())}회")
sig = (KS / KS.shift(5) - 1 <= -0.05) & (FUT > 0); rep("투매 매수 + 외국인 선물 순매수일: 지수 매수 3일", *run(wi=hold(sig, 3)), f"신호 {int((sig & ~sig.shift(1).fillna(False)).sum())}회")
sig = (KS >= ma[60]) & (pos20 <= 0.2); rep("상승 추세 하단 매수: 60일선 위 + 위치 20%↓, 지수 매수 5일", *run(wi=hold(sig, 5)), f"신호 {int((sig & ~sig.shift(1).fillna(False)).sum())}회")

P("\n## 3. 종목 바스켓(시장 위험 그대로)\n"); P(HD)
EL = LIQ & C.notna()
SM = EL & (CAP <= 2e12)
B = {}
B["외국인 20일 매집 상위 15"] = topn(fo20, 15, EL)
B["외국인 20일 매집 상위 15 · 시총 2조 이하"] = topn(fo20, 15, SM)
B["외국인 매집 − 기관 매집 상위 15 · 시총 2조 이하"] = topn(fo20.rank(axis=1, pct=True) - in20.rank(axis=1, pct=True), 15, SM)
B["외+기 5일 누적 상위 15 · 20일선 위 · 시총 2조 이하"] = topn(sm5, 15, SM & (C > MA20))
B["시총 2조 이하 전체 동일가중"] = SM.astype(float).div(SM.sum(axis=1), axis=0)
B["20일 수익률 상위 15(모멘텀)"] = topn(r20, 15, EL)
B["5일 낙폭 상위 15(역추세)"] = topn(r5, 15, EL, asc=True)
B["전일 낙폭 상위 10(1일 역추세, 매일 교체)"] = topn(r1, 10, EL, every=1, asc=True)
B["당일 +7% 이상·거래대금 100억 이상, 3일 보유"] = tranche((CHG >= 7) & (AMT >= 1e10) & EL, 3)
candF = (CHG >= 3) & (AMT >= 5e9) & (C > MA20) & (CAP <= 2e12)
B["조합 F(전일까지 수급): 후보 + 20일선 위 + 5일 수급 + 시총 2조 이하 + 지수 하단 아님, 3일 보유"] = tranche(candF & (sm5 >= 0.002) & EL, 3).mul((pos20 > 0.3).astype(float), axis=0)
B["조합 F(당일 수급 포함, 낙관적)"] = tranche(candF & (sm5_same >= 0.002) & EL, 3).mul((pos20 > 0.3).astype(float), axis=0)
for nm, W in B.items(): rep(nm, *run(W=W))

P("\n## 4. 롱숏 중립(바스켓 매수 + KODEX 인버스로 같은 금액 헤지)\n"); P("- 수익률은 매수 금액 기준. 실제로는 매수와 인버스에 자금이 각각 들어가므로 총자금 기준 수익은 절반.\n"); P(HD)
for nm, W in B.items():
    g = W.reindex(D).fillna(0).sum(axis=1); rep("[헤지] " + nm, *run(W=W, wv=g))
P("\n**헤지 비율·교체 주기·종목 수 변형 (외국인 20일 매집 · 시총 2조 이하)**\n"); P(HD)
for n, ev in itertools.product((10, 15, 30), (5, 10)):
    W = topn(fo20, n, SM, every=ev); rep(f"[헤지] 상위 {n} · {ev}일마다 교체", *run(W=W, wv=W.sum(axis=1)))
W = B["외국인 20일 매집 상위 15 · 시총 2조 이하"]
for hr in (0.5, 0.7, 1.3):
    rep(f"[헤지 {hr:.1f}배] 외국인 20일 매집 상위 15 · 시총 2조 이하", *run(W=W, wv=W.sum(axis=1) * hr))
W = B["시총 2조 이하 전체 동일가중"]
for hr in (0.5, 0.7, 1.3):
    rep(f"[헤지 {hr:.1f}배] 시총 2조 이하 전체", *run(W=W, wv=W.sum(axis=1) * hr))

P("\n## 5. 국면 전환형(추세에 따라 바꿈)\n"); P(HD)
down = (KS < ma[60]).astype(float); up = 1 - down
Wf = B["외국인 20일 매집 상위 15 · 시총 2조 이하"]; Ws = B["시총 2조 이하 전체 동일가중"]
rep("하락 추세: 헤지 바스켓(외국인 매집) / 상승 추세: 바스켓만", *run(W=Wf, wv=down))
rep("하락 추세: 헤지 바스켓(시총 2조 이하) / 상승 추세: 바스켓만", *run(W=Ws, wv=down))
wb, _ = boxshort(trend=True)
rep("하락 추세: 헤지 바스켓(외국인 매집) + 박스 상단 인버스 추가 50%", *run(W=Wf, wv=down + 0.5 * wb))
rep("하락 추세: 현금 + 박스 상단 인버스 / 상승 추세: 바스켓(외국인 매집)", *run(W=Wf.mul(up, axis=0), wv=wb))
rep("하락 추세: 추세 인버스(20일선) / 상승 추세: 바스켓(외국인 매집)", *run(W=Wf.mul(up, axis=0), wv=((KS < ma[20]) & (KS < ma[60])).astype(float)))
rep("20일선 기준: 아래면 헤지 바스켓 / 위면 바스켓만", *run(W=Wf, wv=(KS < ma[20]).astype(float)))

# ── 종목 쏠림 점검: 외국인 매집 바스켓의 검증 구간 기여도 상위/하위
P("\n## 6. 점검")
W = Wf[Wf.index >= P1]; contrib = (W.shift(1) * R.reindex(W.index)).sum().sort_values()
nm = px.drop_duplicates("code").set_index("code")["name"]
P("- 외국인 매집 바스켓(시총 2조 이하) 종목별 기여(검증 구간, %p): 상위 " + ", ".join(f"{nm.get(c, c)} {v*100:+.1f}" for c, v in contrib.tail(6)[::-1].items()) + " / 하위 " + ", ".join(f"{nm.get(c, c)} {v*100:+.1f}" for c, v in contrib.head(6).items()))
P(f"- 바스켓에 한 번이라도 들어간 종목 수: {int((W > 0).any().sum())} · 시총 2조 이하·유동성 통과 종목 수(최근일): {int(SM.iloc[-1].sum())}")
P(f"- 지수 60일선 아래였던 날: 검증 구간 {int(down[D>=P1].sum())}/{(D>=P1).sum()}일 · 이전 구간 {int(down[D<P1].sum())}/{(D<P1).sum()}일")
P(f"- KODEX 인버스 일별 수익률과 -KOSPI 일별 수익률의 상관: {INV.corr(-kr):.3f} · 인버스 데이터 결측일 {int(ER['114800'].isna().sum())}")
b = (Wf.shift(1) * R).sum(axis=1); bb = b[D >= P1]; kk = kr[D >= P1]
P(f"- 외국인 매집 바스켓의 지수 민감도(베타, 검증 구간): {np.cov(bb.fillna(0), kk.fillna(0))[0,1]/kk.var():.2f} · 시총 2조 이하 전체: {np.cov(((Ws.shift(1)*R).sum(axis=1))[D>=P1].fillna(0), kk.fillna(0))[0,1]/kk.var():.2f}")
