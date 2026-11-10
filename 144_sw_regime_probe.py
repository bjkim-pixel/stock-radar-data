# -*- coding: utf-8 -*-
"""횡보장 전략 0단계 추가 검증(읽기 전용): 지수 박스 위치별 대응(하단 바스켓 매수 / 상단 인버스)이 과거에 어땠는지.
DB는 조회만 한다. 사용: SUPABASE_DB_URL=... python 144_sw_regime_probe.py > sw_regime_report.md"""
import os, datetime as dt
import numpy as np, pandas as pd, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.set_session(readonly=True, autocommit=True)
P = print
P("# 지수 박스 위치별 대응 검증 (읽기 전용)")
ix = pd.read_sql("select trade_date d, market mk, index_close c from market_daily where index_close is not null and market in ('KOSPI','KOSDAQ') and extract(isodow from trade_date) between 1 and 5 order by 2,1", conn)
ix["d"] = pd.to_datetime(ix["d"]); ix["c"] = pd.to_numeric(ix["c"])
STATES = ["하단 이탈(<0%)", "하단권(0~20%)", "중간(20~80%)", "상단권(80~100%)", "상단 돌파(>100%)"]
def prep(s, N):
    s = s.sort_values("d").reset_index(drop=True).copy()
    s["hi"] = s["c"].shift(1).rolling(N, min_periods=N).max(); s["lo"] = s["c"].shift(1).rolling(N, min_periods=N).min()
    s["pos"] = (s["c"] - s["lo"]) / (s["hi"] - s["lo"]); s["ret"] = s["c"].pct_change() * 100
    s["width"] = (s["hi"] / s["lo"] - 1) * 100
    for k in (1, 3, 5, 10):
        s[f"f{k}"] = (s["c"].shift(-k) / s["c"] - 1) * 100
    s["st"] = pd.cut(s["pos"], [-np.inf, 0, 0.2, 0.8, 1.0, np.inf], labels=STATES, right=True)
    s.loc[s["pos"] < 0, "st"] = STATES[0]
    return s
def tab(s, title):
    P(f"\n**{title}**\n"); P("| 지수 위치(직전 박스 기준) | 일수 | 구간 수 | 1일 | 3일 | 5일 | 10일 | 5일 상승 비율 |\n|---|---|---|---|---|---|---|---|")
    for st in STATES:
        x = s[s["st"] == st].dropna(subset=["f5"])
        if not len(x): P(f"| {st} | 0 | | | | | | |"); continue
        ep = (s["st"].eq(st) & ~s["st"].shift(1).eq(st)).sum()
        P(f"| {st} | {len(x)} | {ep} | {x['f1'].mean():+.2f} | {x['f3'].mean():+.2f} | {x['f5'].mean():+.2f} | {x['f10'].mean():+.2f} | {(x['f5']>0).mean()*100:.0f}% |")
P("## 1. 지수 위치별 이후 지수 수익률(%)")
P("- 박스 = 전일까지 N거래일 종가의 최고·최저. 오늘 종가가 그 안 어디인지로 상태를 나눔. 박스 밖이면 이탈/돌파.")
K = {}
for mk in ("KOSPI", "KOSDAQ"):
    for N in (10, 20, 40):
        s = prep(ix[ix["mk"] == mk], N); K[(mk, N)] = s
        tab(s, f"{mk} · {N}일 박스 · 전체 기간({s['d'].min():%Y-%m}~)")
        if N == 20: tab(s[s["d"] >= "2026-08-01"], f"{mk} · {N}일 박스 · 2026-08 이후")
s = K[("KOSPI", 20)]
P(f"\n- KOSPI 최근 12거래일: " + " / ".join(f"{r.d:%m-%d} {r.c:,.0f} ({r.ret:+.1f}%, 위치 {r.pos*100:.0f}%)" for r in s.tail(12).itertuples() if not np.isnan(r.pos)))
P(f"- KOSPI 20일 박스 폭(고점÷저점-1) 중앙값 {s['width'].median():.1f}% · 최근 {s['width'].iloc[-1]:.1f}% · 일간 등락 절대값 평균: 전체 {s['ret'].abs().mean():.2f}% / 2026-08 이후 {s[s['d']>='2026-08-01']['ret'].abs().mean():.2f}% / 2026-10 이후 {s[s['d']>='2026-10-01']['ret'].abs().mean():.2f}%")

# ── 2. 하단권에서 반등과 추가 하락을 가르는 조건
P("\n## 2. 하단권·하단 이탈일에 조건별 이후 5일 지수 수익률 (KOSPI 20일 박스)")
px = pd.read_sql("""select p.trade_date d, p.code, s.name, s.market mk, vs.sector, p.open o, p.high h, p.low l, p.close c, p.change_pct chg, p.trade_amount amt, p.market_cap cap,
                           coalesce(f.foreign_net,0) fo, coalesce(f.inst_net,0) ins, coalesce(f.individual_net,0) ind
                    from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' left join v_stock_sector vs on vs.code=p.code
                    left join daily_flow f on f.code=p.code and f.trade_date=p.trade_date where p.close>0 order by p.code, p.trade_date""", conn)
for c in ["o", "h", "l", "c", "chg", "amt", "cap", "fo", "ins", "ind"]: px[c] = pd.to_numeric(px[c], errors="coerce")
px["d"] = pd.to_datetime(px["d"]); px["sm"] = px["fo"] + px["ins"]
mkt = px.groupby("d").agg(sm=("sm", "sum"), fo=("fo", "sum"), ins=("ins", "sum"), ind=("ind", "sum"), adv=("chg", lambda x: (x > 0).mean() * 100)).reset_index()
s = s.merge(mkt, on="d", how="left")
try:
    fut = pd.read_sql("select trade_date d, foreign_net fut_f from market_investor_daily where market='FUT'", conn); fut["d"] = pd.to_datetime(fut["d"]); fut["fut_f"] = pd.to_numeric(fut["fut_f"])
    s = s.merge(fut, on="d", how="left")
except Exception: s["fut_f"] = np.nan
s["ma60"] = s["c"].rolling(60, min_periods=40).mean(); s["ret5p"] = (s["c"] / s["c"].shift(5) - 1) * 100
low = s[s["pos"] <= 0.2].dropna(subset=["f5"])
P("| 조건(그날) | 일수 | 3일 | 5일 | 10일 | 5일 상승 비율 |\n|---|---|---|---|---|---|")
def r2(nm, x):
    P(f"| {nm} | {len(x)} | " + (" | ".join(f"{x[c].mean():+.2f}" for c in ("f3", "f5", "f10")) + f" | {(x['f5']>0).mean()*100:.0f}% |" if len(x) >= 3 else "표본 부족 | | | |"))
r2("하단권·이탈 전체", low)
r2("당일 지수 상승 마감", low[low["ret"] > 0]); r2("당일 지수 하락 마감", low[low["ret"] <= 0])
r2("당일 지수 +1% 이상 반등", low[low["ret"] >= 1])
r2("박스 안(0~20%)", low[low["pos"] >= 0]); r2("박스 밖(이탈)", low[low["pos"] < 0])
r2("추적 종목 외+기 합계 순매수", low[low["sm"] > 0]); r2("추적 종목 외+기 합계 순매도", low[low["sm"] <= 0])
r2("외국인 선물 순매수(133일치만)", low[low["fut_f"] > 0]); r2("외국인 선물 순매도", low[low["fut_f"] <= 0])
r2("지수가 60일선 위", low[low["c"] >= low["ma60"]]); r2("지수가 60일선 아래", low[low["c"] < low["ma60"]])
r2("직전 5일 -5% 이상 급락 뒤", low[low["ret5p"] <= -5]); r2("직전 5일 낙폭 -5% 미만", low[low["ret5p"] > -5])
r2("상승 종목 비율 50% 이상", low[low["adv"] >= 50]); r2("상승 종목 비율 50% 미만", low[low["adv"] < 50])
hi = s[s["pos"] >= 0.8].dropna(subset=["f5"])
P("\n상단권·돌파일(위치 80% 이상)에 조건별 이후 지수 수익률 — 인버스는 이 값의 반대 방향\n")
P("| 조건(그날) | 일수 | 3일 | 5일 | 10일 | 5일 하락 비율 |\n|---|---|---|---|---|---|")
def r3(nm, x):
    P(f"| {nm} | {len(x)} | " + (" | ".join(f"{x[c].mean():+.2f}" for c in ("f3", "f5", "f10")) + f" | {(x['f5']<0).mean()*100:.0f}% |" if len(x) >= 3 else "표본 부족 | | | |"))
r3("상단권·돌파 전체", hi); r3("박스 안(80~100%)", hi[hi["pos"] <= 1]); r3("박스 밖(돌파)", hi[hi["pos"] > 1])
r3("당일 지수 하락 마감", hi[hi["ret"] < 0]); r3("당일 지수 상승 마감", hi[hi["ret"] >= 0])
r3("추적 종목 외+기 합계 순매도", hi[hi["sm"] <= 0]); r3("추적 종목 외+기 합계 순매수", hi[hi["sm"] > 0])
r3("외국인 선물 순매도(133일치만)", hi[hi["fut_f"] <= 0]); r3("외국인 선물 순매수", hi[hi["fut_f"] > 0])
r3("지수가 60일선 아래", hi[hi["c"] < hi["ma60"]]); r3("지수가 60일선 위", hi[hi["c"] >= hi["ma60"]])
for lab, sub in (("2026-08 이후 상단권·돌파", hi[hi["d"] >= "2026-08-01"]), ("2026-08 이후 상단권(박스 안)", hi[(hi["d"] >= "2026-08-01") & (hi["pos"] <= 1)])): r3(lab, sub)

# ── 3. 규칙 모의: 하단 매수 / 상단 인버스
P("\n## 3. 규칙 모의(KOSPI 지수 기준, 비용 제외)")
P("- 매수: 진입 조건일 종가 매수 → 위치 60% 이상 회복 시 청산, 종가가 박스 하단보다 3% 더 내려가면 손절, 최대 10거래일")
P("- 인버스: 위치 80~100%에서 종가 진입 → 위치 40% 이하로 내려오면 청산, 종가가 박스 상단보다 3% 더 오르면 손절, 최대 10거래일. 수익 = 지수 수익률의 반대(1배)")
def sim(s, side, confirm):
    out = []; i = 0; n = len(s); c = s["c"].values; pos = s["pos"].values; lo = s["lo"].values; hi_ = s["hi"].values; ret = s["ret"].values; d = s["d"].values
    while i < n - 1:
        ok = (not np.isnan(pos[i])) and ((side == "L" and 0 <= pos[i] <= 0.2 and (not confirm or ret[i] > 0)) or (side == "S" and 0.8 <= pos[i] <= 1.0 and (not confirm or ret[i] < 0)))
        if not ok: i += 1; continue
        e = i; L0, H0 = lo[i], hi_[i]; why = "기간 만료"; j = i
        for j in range(i + 1, min(n, i + 11)):
            p = (c[j] - L0) / (H0 - L0)
            if side == "L":
                if c[j] < L0 * 0.97: why = "손절"; break
                if p >= 0.6: why = "목표"; break
            else:
                if c[j] > H0 * 1.03: why = "손절"; break
                if p <= 0.4: why = "목표"; break
        r = (c[j] / c[e] - 1) * 100 * (1 if side == "L" else -1)
        out.append((pd.Timestamp(d[e]), pd.Timestamp(d[j]), c[e], c[j], r, why, j - e)); i = j + 1
    return out
for mk in ("KOSPI", "KOSDAQ"):
    for N in (10, 20):
        ss = K[(mk, N)]
        for side, nm in (("L", "하단권 매수"), ("S", "상단권 인버스")):
            for confirm in (False, True):
                t = sim(ss, side, confirm)
                if not t: P(f"\n{mk} {N}일 박스 · {nm}{' · 확인 신호' if confirm else ''}: 거래 없음"); continue
                rr = np.array([x[4] for x in t]); t8 = [x for x in t if x[0] >= pd.Timestamp("2026-08-01")]; r8 = np.array([x[4] for x in t8])
                P(f"\n{mk} {N}일 박스 · {nm}{' · 확인 신호(매수=당일 상승 마감, 인버스=당일 하락 마감)' if confirm else ''}: 전체 {len(t)}회 · 평균 {rr.mean():+.2f}% · 합계 {rr.sum():+.1f}% · 승 {int((rr>0).sum())}/{len(t)} · 최악 {rr.min():+.1f}%"
                  + (f" ‖ 2026-08 이후 {len(t8)}회 · 평균 {r8.mean():+.2f}% · 합계 {r8.sum():+.1f}% · 승 {int((r8>0).sum())}/{len(t8)}" if len(t8) else ""))
                if mk == "KOSPI" and N == 20:
                    P("\n| 진입 | 청산 | 진입가 | 청산가 | 수익률 | 사유 | 보유일 |\n|---|---|---|---|---|---|---|")
                    for a, b, c1, c2, r, w, h in t8: P(f"| {a:%Y-%m-%d} | {b:%m-%d} | {c1:,.0f} | {c2:,.0f} | {r:+.1f}% | {w} | {h} |")

# ── 4. 하단권에서 무엇을 사야 했나 / 상단권에서 무엇이 빠졌나 (종목 5분위)
P("\n## 4. 종목 고르기: 그날 지표로 5등분했을 때 이후 수익률(%)")
px = px.sort_values(["code", "d"]).reset_index(drop=True); g = px.groupby("code", sort=False)
for k in (5, 10): px[f"r{k}"] = (g["c"].shift(-k) / px["c"] - 1) * 100
px["sm20"] = g["sm"].transform(lambda x: x.rolling(20, min_periods=15).sum()) / px["cap"] * 100
px["sm5"] = g["sm"].transform(lambda x: x.rolling(5, min_periods=4).sum()) / px["cap"] * 100
px["fo20"] = g["fo"].transform(lambda x: x.rolling(20, min_periods=15).sum()) / px["cap"] * 100
px["in20"] = g["ins"].transform(lambda x: x.rolling(20, min_periods=15).sum()) / px["cap"] * 100
px["ind20"] = g["ind"].transform(lambda x: x.rolling(20, min_periods=15).sum()) / px["cap"] * 100
px["ret20"] = (px["c"] / g["c"].shift(20) - 1) * 100
px["dd20"] = (px["c"] / g["c"].transform(lambda x: x.rolling(20, min_periods=15).max()) - 1) * 100
px["lcap"] = np.log(px["cap"])
px = px[px["chg"].abs() <= 30.5]
F = [("sm20", "외+기 20일 누적/시총"), ("sm5", "외+기 5일 누적/시총"), ("fo20", "외국인 20일 누적/시총"), ("in20", "기관 20일 누적/시총"), ("ind20", "개인 20일 누적/시총"),
     ("ret20", "20일 수익률(강한 순)"), ("dd20", "20일 고점 대비(덜 빠진 순)"), ("lcap", "시가총액(큰 순)")]
def quint(days, title, k):
    sub = px[px["d"].isin(days)].dropna(subset=[f"r{k}"])
    P(f"\n**{title}** — {sub['d'].nunique()}일, 이후 {k}거래일\n"); P("| 지표 | 상위 20% | 하위 20% | 차이 | 차이가 플러스인 날 비율 | t |\n|---|---|---|---|---|---|")
    if sub["d"].nunique() < 3: P("| 표본 부족 | | | | | |"); return
    for f, nm in F:
        x = sub.dropna(subset=[f]).copy(); x["q"] = x.groupby("d")[f].transform(lambda v: pd.qcut(v.rank(method="first"), 5, labels=False))
        top = x[x["q"] == 4].groupby("d")[f"r{k}"].mean(); bot = x[x["q"] == 0].groupby("d")[f"r{k}"].mean(); diff = (top - bot).dropna()
        t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) if len(diff) > 3 and diff.std(ddof=1) > 0 else np.nan
        P(f"| {nm} | {top.mean():+.2f} | {bot.mean():+.2f} | {diff.mean():+.2f} | {(diff>0).mean()*100:.0f}% | {t:+.1f} |")
kp = K[("KOSPI", 20)]
lowd = kp[kp["pos"] <= 0.2]["d"]; hid = kp[kp["pos"] >= 0.8]["d"]; midd = kp[(kp["pos"] > 0.2) & (kp["pos"] < 0.8)]["d"]
quint(lowd, "KOSPI 하단권·이탈일(위치 20% 이하)", 5); quint(lowd, "KOSPI 하단권·이탈일(위치 20% 이하)", 10)
quint(lowd[lowd >= "2026-08-01"], "KOSPI 하단권·이탈일 · 2026-08 이후", 5)
quint(kp[(kp["pos"] <= 0.2) & (kp["ret"] > 0)]["d"], "KOSPI 하단권·이탈일 중 지수 상승 마감일", 5)
quint(hid, "KOSPI 상단권·돌파일(위치 80% 이상)", 5); quint(hid[hid >= "2026-08-01"], "KOSPI 상단권·돌파일 · 2026-08 이후", 5)
quint(midd, "KOSPI 중간(20~80%)", 5)
# 업종: 하단권일에 업종 20일 외+기 누적/시총 상위 5 vs 하위 5
sec = px.dropna(subset=["sector"]).groupby(["d", "sector"]).agg(sm=("sm", "sum"), cap=("cap", "sum"), r5=("r5", "mean"), n=("code", "count")).reset_index()
sec = sec[sec["n"] >= 5].sort_values(["sector", "d"]); sec["sm20"] = sec.groupby("sector")["sm"].transform(lambda x: x.rolling(20, min_periods=15).sum()) / sec["cap"] * 100
P("\n**업종 고르기(5종목 이상 업종)** — 업종 외+기 20일 누적/시총 상위 5개 vs 하위 5개의 이후 5일 평균 수익률\n"); P("| 구간 | 일수 | 상위 5 업종 | 하위 5 업종 | 차이 | 차이 플러스 비율 |\n|---|---|---|---|---|---|")
for nm, days in (("하단권·이탈일", lowd), ("중간", midd), ("상단권·돌파일", hid)):
    x = sec[sec["d"].isin(days)].dropna(subset=["sm20", "r5"]).copy(); x["rk"] = x.groupby("d")["sm20"].rank(ascending=False); x["rkb"] = x.groupby("d")["sm20"].rank()
    top = x[x["rk"] <= 5].groupby("d")["r5"].mean(); bot = x[x["rkb"] <= 5].groupby("d")["r5"].mean(); diff = (top - bot).dropna()
    P(f"| {nm} | {len(diff)} | {top.mean():+.2f} | {bot.mean():+.2f} | {diff.mean():+.2f} | {(diff>0).mean()*100:.0f}% |" if len(diff) else f"| {nm} | 0 | | | | |")

# ── 5. 인버스 ETF 실제 값
P("\n## 5. 인버스 ETF와 삼성전자·SK하이닉스")
try:
    et = pd.read_sql("select e.code, coalesce(s.name, m.name) nm, e.trade_date d, e.close c, e.amount amt from etf_daily e left join stocks s on s.code=e.code left join etf_master m on m.code=e.code where e.code in ('114800','252670','251340','123310','0197X0','0193L0')", conn)
    et["d"] = pd.to_datetime(et["d"]); et["c"] = pd.to_numeric(et["c"]); et["amt"] = pd.to_numeric(et["amt"])
    P("| ETF | 데이터 | 최근 20일 평균 거래대금(억) | 상단권일 진입 후 5일 | 10일 | 2026-08 이후 상단권일 5일 |\n|---|---|---|---|---|---|")
    for code, x in et.groupby("code"):
        x = x.sort_values("d").copy(); x["f5"] = (x["c"].shift(-5) / x["c"] - 1) * 100; x["f10"] = (x["c"].shift(-10) / x["c"] - 1) * 100
        h = x[x["d"].isin(hid)]; h8 = h[h["d"] >= "2026-08-01"]
        P(f"| {x['nm'].iloc[0]} ({code}) | {x['d'].min():%Y-%m-%d}~ {len(x)}일 | {x['amt'].tail(20).mean()/1e8:,.0f} | {h['f5'].mean():+.2f} ({h['f5'].notna().sum()}일) | {h['f10'].mean():+.2f} | {h8['f5'].mean():+.2f} ({h8['f5'].notna().sum()}일) |")
except Exception as e:
    P(f"- ETF 조회 실패: {str(e)[:100]}")
P("\n| 종목 | 상단권일 이후 5일 | 10일 | 2026-08 이후 상단권일 5일 | 하단권일 이후 5일 | 2026-08 이후 하단권일 5일 |\n|---|---|---|---|---|---|")
for code in ("005930", "000660"):
    x = px[px["code"] == code]; h = x[x["d"].isin(hid)]; l = x[x["d"].isin(lowd)]
    P(f"| {x['name'].iloc[0]} | {h['r5'].mean():+.2f} | {h['r10'].mean():+.2f} | {h[h['d']>='2026-08-01']['r5'].mean():+.2f} | {l['r5'].mean():+.2f} | {l[l['d']>='2026-08-01']['r5'].mean():+.2f} |")
kk = kp.set_index("d")
P(f"| KOSPI 지수 | {kk.loc[kk.index.isin(hid),'f5'].mean():+.2f} | {kk.loc[kk.index.isin(hid),'f10'].mean():+.2f} | {kk.loc[kk.index.isin(hid[hid>='2026-08-01']),'f5'].mean():+.2f} | {kk.loc[kk.index.isin(lowd),'f5'].mean():+.2f} | {kk.loc[kk.index.isin(lowd[lowd>='2026-08-01']),'f5'].mean():+.2f} |")
