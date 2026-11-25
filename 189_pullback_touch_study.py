# -*- coding: utf-8 -*-
"""눌림목 0단계 재검증 — 진입 시점 재정의(사용자 규칙, 2026-11-25). 읽기 전용.
  ① 최초 무게 막대: [t-120, t-5] 안에서 처음 나온 큰 무게/주식수 양봉일(무게 ≥ WMIN, 직전 60일 최대 무게의 3배 이상, 등락률>0)
     → 기준 단가 = 그날 거래대금 ÷ 거래량
  ② 그 뒤 주가는 오르내리기만(박스): 최근 20일 고저폭 ≤ BOX%, 종가가 기준 단가 −5% 이상(많이 안 빠짐)
  ③ 스마트머니 누적은 증가: 앵커 다음날~t 외+기 누적 > 0, 지금 누적 ≥ 누적 고점의 80%, 10일 전보다 많음
  ④ 지지선 반복 터치: 지지선 = 직전 20일(오늘 제외) 저가 최저. 오늘 저가가 지지선 +2% 이내로 내려왔고 종가는 지지선 −2% 위.
     지난 20일 안의 앞선 터치(지지선 +2% 이내 저가, 서로 3일 이상 떨어짐) 수 ≥ TOUCH−1 → 오늘이 TOUCH번째 이상 터치
  진입 = 그날 종가(장 막판 매수), 손절 = max(진입 −5%, 지지선 −3%), 익절 +8%(50%)/+12%(50%), 1단계 뒤 손절 본전+0.35%, 10거래일 종가 청산.
  일봉 모의: 같은 날 손절·익절이 겹치면 손절 먼저. 왕복 비용 0.25%."""
import os, time, numpy as np, pandas as pd, psycopg2
T0 = time.time()
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)
FROM = os.environ.get("FROM", "2024-10-01"); COST = 0.25
SUP = os.environ.get("SUP", "pivot")   # 지지선 정의: pivot(전환점 가격대) | vp(매물대)
CAP_LO, CAP_HI, AMT20 = 3000e8, 50000e8, 30e8
S = Q("select code,name from stocks where security_type='STOCK'"); NAME = dict(zip(S.code, S.name))
P = Q(f"""select p.trade_date d,p.code,p.open o,p.high h,p.low l,p.close c,p.volume v,p.trade_amount a,p.market_cap mc,p.change_pct chg,p.weight_per_share w
          from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' where p.trade_date>='{FROM}' order by p.code,p.trade_date""")
F = Q(f"select trade_date d,code,foreign_net fn,inst_net inn from daily_flow where trade_date>='{FROM}'")
D = P.merge(F, on=["d", "code"], how="left"); D["d"] = pd.to_datetime(D["d"])
p(f"# 눌림목 0단계 재검증 — 최초 무게 막대 + 박스 + 스마트머니 증가 + 지지선 반복 터치 (지지선={'매물대' if SUP == 'vp' else '전환점 가격대'})\n")
p(f"데이터 {D.d.min().date()} ~ {D.d.max().date()} · 종목 {D.code.nunique():,} · 행 {len(D):,}\n")

VAR = {  # (WMIN, BOX, TOUCH, smart 조건 사용)
    "A 기본(무게≥0.3 · 박스≤25% · 3번째 터치 · 수급 증가)": (0.3, 0.25, 3, True),
    "A' 2번째 터치부터": (0.3, 0.25, 2, True),
    "A'' 무게≥0.1(작은 막대 포함)": (0.1, 0.25, 3, True),
    "B 수급 증가 조건 제외": (0.3, 0.25, 3, False),
    "C 앵커·수급 제외(박스 지지선 3번째 터치만)": (None, 0.25, 3, False),
}
MAIN = list(VAR)[0]
EXITS = {"손절 −5%(장중)": (0.05, False), "손절 지지선−3%·종가 기준": (0.08, True), "손절 −8%(장중)": (0.08, False)}
base, sigs, trades, diag = [], [], [], []
for code, g in D.groupby("code", sort=False):
    g = g.reset_index(drop=True); n = len(g)
    if n < 140: continue
    o, h, l, cl, v, a = (g[k].astype(float).values for k in ("o", "h", "l", "c", "v", "a"))
    mc = g.mc.astype(float).values; chg = g.chg.astype(float).values; w = np.nan_to_num(g.w.astype(float).values)
    sm = (g.fn.fillna(0).astype(float) + g.inn.fillna(0).astype(float)).values
    a20 = pd.Series(a).rolling(20).mean().values; dates = g.d.values
    wmax60 = pd.Series(w).shift(1).rolling(60, min_periods=30).max().values
    fwd = {k: np.r_[cl[k:] / cl[:-k] - 1, [np.nan] * k] * 100 for k in (1, 3, 5, 10)}
    last_exit = {vn: -1 for vn in VAR}
    for t in range(125, n):
        if not (CAP_LO <= mc[t] <= CAP_HI) or not (a20[t] >= AMT20): continue
        base.append((code, dates[t], *(fwd[k][t] for k in (1, 3, 5, 10))))
        if SUP == "vp":
            # 지지선 = 매물대: 최근 60일 거래량을 그날 평균가((고+저+종)/3) 가격대 24칸에 쌓고, 거래량 상위 30% 칸 중 오늘 저가가 들어간(±1.5%) 칸
            lo_, hi_ = l[t - 60:t].min(), h[t - 60:t].max()
            if not (hi_ > lo_): continue
            edges = np.linspace(lo_, hi_, 25); tp = (h[t - 60:t] + l[t - 60:t] + cl[t - 60:t]) / 3
            vol = np.bincount(np.clip(np.searchsorted(edges, tp, side="right") - 1, 0, 23), weights=v[t - 60:t], minlength=24)
            thr = np.quantile(vol, 0.7)
            cand = [(vol[b], edges[b], edges[b + 1]) for b in range(24) if vol[b] >= thr and edges[b] * 0.985 <= l[t] <= edges[b + 1] * 1.015]
            if code == "053800" and dates[t] >= np.datetime64("2026-11-10"):
                top = sorted([(vol[b], edges[b]) for b in range(24)], reverse=True)[:3]
                diag.append((dates[t], round(l[t]), " / ".join(f"{x[1]:,.0f}~" for x in top), bool(cand)))
            if not cand: continue
            _, blo, bhi = max(cand)
            sup = blo
            if not (cl[t] >= blo * 0.98): continue
            cnt, lastk = 0, -9
            for i in range(t - 30, t):
                if l[i] <= bhi * 1.015 and h[i] >= blo and i - lastk >= 3: cnt += 1; lastk = i
                elif l[i] <= bhi * 1.015 and h[i] >= blo: lastk = i
        else:
            piv = [i for i in range(t - 30, t - 2) if (l[i] <= l[i - 2:i + 3].min()) or (h[i] >= h[i - 2:i + 3].max())]
            lv = [(l[i] if l[i] <= l[i - 2:i + 3].min() else h[i]) for i in piv]
            near = [(i, x) for i, x in zip(piv, lv) if abs(x / l[t] - 1) <= 0.025]
            if not near: continue
            sup = float(np.median([x for _, x in near]))
            if not (cl[t] >= sup * 0.98 and l[t] <= sup * 1.025): continue
            cnt, lastk = 0, -9
            for i, _ in near:
                if i - lastk >= 3: cnt += 1; lastk = i
        box = (h[t - 20:t + 1].max() - l[t - 20:t + 1].min()) / l[t - 20:t + 1].min()
        for vn, (wmin, bmax, tch, use_sm) in VAR.items():
            if box > bmax or cnt + 1 < tch: continue
            vw = np.nan; ai = None
            if wmin is not None:
                for i in range(max(60, t - 120), t - 4):
                    if w[i] >= wmin and chg[i] > 0 and w[i] >= 3 * max(wmax60[i], 1e-9): ai = i; break
                if ai is None: continue
                vw = a[ai] / v[ai] if v[ai] > 0 else np.nan
                if not (cl[t] >= vw * 0.95): continue
            if use_sm:
                cum = np.cumsum(sm[ai + 1:t + 1]); pk = cum.max()
                if not (cum[-1] > 0 and cum[-1] >= 0.8 * pk and (len(cum) <= 10 or cum[-1] > cum[-11])): continue
            sigs.append((vn, code, dates[t], cl[t] / vw - 1 if vw == vw else np.nan, cnt + 1, *(fwd[k][t] for k in (1, 3, 5, 10))))
            if t <= last_exit[vn] or t + 1 >= n: continue
            ent = cl[t]; kmax = 0
            for ex, (sp, close_stop) in EXITS.items():
                stop = max(ent * (1 - sp), sup * 0.97) if sp else 0; R = 1 - stop / ent if stop else 0
                left, pnl, k, why = 1.0, 0.0, t + 1, ""
                while True:
                    hit = (cl[k] < stop) if close_stop else (l[k] <= stop)
                    if stop and hit:
                        px = cl[k] if close_stop else min(stop, o[k]); pnl += left * (px / ent - 1); why = "손절" if stop < ent else "본전손절"; break
                    if left == 1.0 and h[k] >= ent * 1.08: pnl += 0.04; left = 0.5; stop = max(stop, ent * 1.0035)
                    if left == 0.5 and h[k] >= ent * 1.12: pnl += 0.06; left = 0; why = "익절2"; break
                    if k - t >= 10 or k + 1 >= n: pnl += left * (cl[k] / ent - 1); why = "시간청산" if k - t >= 10 else "자료끝"; break
                    k += 1
                kmax = max(kmax, k)
                trades.append((vn + " | " + ex, code, dates[t], ent, R * 100, pnl * 100 - COST, why, k - t))
            last_exit[vn] = kmax

B = pd.DataFrame(base, columns=["code", "d", "y1", "y3", "y5", "y10"])
SG = pd.DataFrame(sigs, columns=["var", "code", "d", "gap", "touch", "y1", "y3", "y5", "y10"])
TR = pd.DataFrame(trades, columns=["var", "code", "d", "ent", "R", "ret", "why", "hold"])
mid = B.d.sort_values().iloc[len(B) // 2]
p("## 1. 신호일(종가) 이후 수익률 %\n")
p("| 구분 | 신호 | 종목 | 1일 | 3일 | 5일 | 10일 | 10일 상승비율 | 10일 t(기준 대비) | 10일 전반/후반 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
def line(lab, x):
    x = x[x.y10.notna()]
    if len(x) < 5: p(f"| {lab} | {len(x)} | – | – | – | – | – | – | – | – |"); return
    r = B[B.y10.notna()]; t = (x.y10.mean() - r.y10.mean()) / (x.y10.std(ddof=1) / np.sqrt(len(x)))
    a_, b_ = x[x.d < mid].y10, x[x.d >= mid].y10
    p(f"| {lab} | {len(x):,} | {x.code.nunique()} | {x.y1.mean():+.2f} | {x.y3.mean():+.2f} | {x.y5.mean():+.2f} | {x.y10.mean():+.2f} | {(x.y10>0).mean()*100:.0f}% | {t:+.1f} | {a_.mean():+.2f} ({len(a_)}) / {b_.mean():+.2f} ({len(b_)}) |")
line("기준(같은 시총대 전체)", B)
for vn in VAR: line(vn, SG[SG["var"] == vn])
p("\n## 2. 매매 모의(신호일 종가 매수 · 손절 3종 비교(지지선 −3%와 고정 % 중 높은 쪽) · 익절 +8/+12% · 10일 · 비용 0.25%)\n")
p("| 구분 | 거래 | 승률 | 평균% | 중앙값% | PF | 평균 손절폭% | 평균 보유일 | 청산 사유 |\n|---|---:|---:|---:|---:|---:|---:|---:|---|")
for vn in sorted(TR["var"].unique(), key=lambda z: (list(VAR).index(z.split(" | ")[0]), z)):
    x = TR[TR["var"] == vn]
    if not len(x): p(f"| {vn} | 0 | | | | | | | |"); continue
    wn, ls = x[x.ret > 0].ret.sum(), -x[x.ret <= 0].ret.sum()
    p(f"| {vn} | {len(x)} | {(x.ret>0).mean()*100:.0f}% | {x.ret.mean():+.2f} | {x.ret.median():+.2f} | {wn/ls if ls>0 else float('inf'):.2f} | {x.R.mean():.1f} | {x.hold.mean():.1f} | " + " · ".join(f"{k} {v}" for k, v in x.why.value_counts().items()) + " |")
x = TR[TR["var"] == MAIN + " | 손절 지지선−3%·종가 기준"].copy()
if len(x):
    x["m"] = pd.to_datetime(x.d).dt.to_period("M")
    p(f"\n{MAIN} 월별\n\n| 월 | 거래 | 승률 | 평균% |\n|---|---:|---:|---:|")
    for m_, y in x.groupby("m"): p(f"| {m_} | {len(y)} | {(y.ret>0).mean()*100:.0f}% | {y.ret.mean():+.2f} |")
p("\n## 3. 사례 — 안랩(053800) · 코스맥스(192820)\n")
for cd in ("053800", "192820"):
    p(f"**{NAME.get(cd, cd)}**")
    for vn in VAR:
        y = SG[(SG.code == cd) & (SG["var"] == vn)].tail(10)
        if len(y): p(f"- {vn}: " + ", ".join(f"{pd.Timestamp(d).strftime('%y/%m/%d')}({int(tc)}회)" for d, tc in zip(y.d, y.touch)))
    for _, r in TR[(TR.code == cd) & TR["var"].str.startswith(MAIN)].tail(5).iterrows():
        p(f"  - 모의[{r['var'].split(' | ')[1]}]: {pd.Timestamp(r.d).date()} 종가 {r.ent:,.0f}원 · {r.why} · {r.ret:+.2f}% · {r.hold}일")
p("\n안랩 11/10 이후 매물대 진단(날짜 · 저가 · 거래량 상위 3칸 시작가 · 저가가 상위 매물대에 닿았나): " + ", ".join(f"{pd.Timestamp(d).strftime('%m/%d')} {lw:,} [{tp_}] {'O' if ok else 'X'}" for d, lw, tp_, ok in diag))
p("\n## 4. 최근 신호(기본, 최근 10거래일)\n")
y = SG[SG["var"] == MAIN]
if len(y):
    last = sorted(y.d.unique())[-10:]
    for _, r in y[y.d.isin(last)].sort_values("d").tail(25).iterrows():
        p(f"- {pd.Timestamp(r.d).strftime('%m/%d')} {NAME.get(r.code, r.code)}({r.code}) · {int(r.touch)}번째 터치 · 기준 단가 대비 {r.gap*100:+.1f}%")
p(f"\n총 {time.time()-T0:.0f}초 · 기간 {FROM}~ · 데이터가 14개월·수집 종목뿐이라 표본이 작음. 장중 조건 없음.")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out))
