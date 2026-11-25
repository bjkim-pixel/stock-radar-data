# -*- coding: utf-8 -*-
"""눌림목(수급 앵커형) 전략 0단계 — 과거 검증(읽기 전용). 기획안: '눌림목 매매 자동매매 전략 기획안 (수급 앵커형)'.
신호일 t(장 마감 후 아는 값만 사용) 조건:
  ① 앵커: [t-60, t-5] 안에서 무게/주식수 최대일, 그날 외+기 순매수>0 · 거래대금 대비 ≥ ANCH% · 세력 평단 = 그날 거래대금/거래량
  ② 이탈 없음: 앵커일부터 t까지 외+기 누적이 양수, 누적 고점 대비 회수율 < 20%, 최근 20일 외+기 합 ≥ 0
  ③ 눌림: 종가가 평단 -3%~+25%, (앵커 후 고점 대비 -5~-15%) 또는 (5일 고저폭 ≤ 8%), 최근 3일 평균 거래량 ≤ 앵커 이후 평균의 70%,
          종가 > 20일선, 60·120일선 5일 전보다 높음, 앵커 종가 대비 +40% 이하, 최근 5일 상한가 없음
  ④ 다음 날(t+1) 전일 고가 돌파 시 매수(시가가 고가 위 0~+5%면 시가, 아니면 전일 고가+1틱 근사), 진입가 ≤ 전일 종가 +8%
매도 모의: 손절 -4% · 익절 +8%(50%) / +12%(50%) · 1단계 체결 후 손절 = 진입가 +0.35% · 평단 -3% 아래 종가 2일 → 다음날 시가 · 10거래일 종가 청산.
일봉만 쓰므로 같은 날 손절·익절이 둘 다 닿으면 손절 먼저(보수적). 진입일에도 저가가 손절가 이하면 손절로 봄. 왕복 비용 0.25%.
장중 조건(분당 거래대금 급증·프로그램·체결강도)은 일봉으로 재현할 수 없어 빠짐 → 실제 전략은 이보다 더 걸러짐."""
import os, sys, time, numpy as np, pandas as pd, psycopg2
T0 = time.time()
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)
FROM = os.environ.get("FROM", "2024-10-01")
CAP_LO, CAP_HI, AMT20 = 3000e8, 50000e8, 30e8
ANCH = float(os.environ.get("ANCH", "8"))
COST = 0.25
ED = os.environ.get("ED", "close")   # 진입 당일 손절 판정: close(종가 기준) | low(저가 기준, 가장 보수적)
EOK = 1e8

S = Q("select code,name,market from stocks where security_type='STOCK'")
P = Q(f"""select p.trade_date d,p.code,p.open o,p.high h,p.low l,p.close c,p.volume v,p.trade_amount a,p.market_cap mc,p.change_pct chg,p.weight_per_share w
          from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' where p.trade_date>='{FROM}' order by p.code,p.trade_date""")
F = Q(f"""select trade_date d,code,foreign_net fn,inst_net inn from daily_flow where trade_date>='{FROM}'""")
D = P.merge(F, on=["d", "code"], how="left")
D["d"] = pd.to_datetime(D["d"])
p(f"# 눌림목(수급 앵커형) 0단계 과거 검증\n")
p(f"데이터 {D.d.min().date()} ~ {D.d.max().date()} · 종목 {D.code.nunique():,} · 행 {len(D):,} · 수급 있는 행 {D.fn.notna().sum():,} · 로딩 {time.time()-T0:.0f}초\n")
NAME = dict(zip(S.code, S.name))

def tick(x):
    return 1 if x < 2000 else 5 if x < 5000 else 10 if x < 20000 else 50 if x < 50000 else 100 if x < 200000 else 500 if x < 500000 else 1000

sig_rows, base_rows, trades = [], [], []
DIAG = {"053800": [], "192820": []}
VAR = {  # 변형: 앵커 정의 · 조건을 빼 보며 기여도 확인. am: w=무게 최대일, wb=외+기 순매수일 중 무게 최대일, sb=외+기 순매수/시총 최대일
    "A 전체(앵커=외+기 매수일 중 무게 최대, 120일)": dict(anchor=True, flow=True, am="wb"),
    "A2 전체(앵커=외+기 순매수/시총 최대, 120일)": dict(anchor=True, flow=True, am="sb"),
    "A0 전체(앵커=무게 최대일, 60일 — 1차안)": dict(anchor=True, flow=True, am="w"),
    "B A에서 수급 이탈 조건 제외": dict(anchor=True, flow=False, am="wb"),
    "C 앵커·수급 제외(눌림+추세만)": dict(anchor=False, flow=False, am="wb"),
}
MAIN = "A 전체(앵커=외+기 매수일 중 무게 최대, 120일)"
for code, g in D.groupby("code", sort=False):
    g = g.reset_index(drop=True)
    n = len(g)
    if n < 140: continue
    o, h, l, cl, v, a = (g[k].astype(float).values for k in ("o", "h", "l", "c", "v", "a"))
    mc = g.mc.astype(float).values; chg = g.chg.astype(float).values; w = g.w.astype(float).values
    sm = (g.fn.fillna(0).astype(float) + g.inn.fillna(0).astype(float)).values
    hasf = g.fn.notna().values
    cs = pd.Series(cl)
    ma5 = cs.rolling(5).mean().values; ma10 = cs.rolling(10).mean().values; ma20 = cs.rolling(20).mean().values
    ma60 = cs.rolling(60).mean().values; ma120 = cs.rolling(120).mean().values
    a20 = pd.Series(a).rolling(20).mean().values
    up = chg >= 29.0
    dates = g.d.values
    fwd = {k: np.r_[cl[k:] / cl[:-k] - 1, [np.nan] * k] * 100 for k in (1, 3, 5, 10, 20)}
    last_exit = -1
    for t in range(125, n - 1):
        if not (CAP_LO <= mc[t] <= CAP_HI) or not (a20[t] >= AMT20): continue
        trend = cl[t] > ma20[t] and ma60[t] > ma60[t - 5] and ma120[t] > ma120[t - 5]
        base_rows.append((code, dates[t], trend, *(fwd[k][t] for k in (1, 3, 5, 10, 20))))
        if not trend: continue
        if up[t - 4:t + 1].any(): continue
        def anc(am):
            lo, hi = max(0, t - (60 if am == "w" else 120)), t - 5
            if am == "w": key = np.where(np.isnan(w[lo:hi + 1]), -np.inf, w[lo:hi + 1])
            elif am == "wb": key = np.where((sm[lo:hi + 1] > 0) & (a[lo:hi + 1] > 0) & (sm[lo:hi + 1] / np.maximum(a[lo:hi + 1], 1) * 100 >= ANCH) & ~np.isnan(w[lo:hi + 1]), w[lo:hi + 1], -np.inf)
            else: key = np.where(mc[lo:hi + 1] > 0, sm[lo:hi + 1] / np.maximum(mc[lo:hi + 1], 1), -np.inf)
            if not np.isfinite(key).any() or key.max() == -np.inf: return None
            ai = lo + int(np.argmax(key))
            ok = hasf[ai] and sm[ai] > 0 and a[ai] > 0 and sm[ai] / a[ai] * 100 >= ANCH
            vw = a[ai] / v[ai] if v[ai] > 0 else np.nan
            cum = np.cumsum(sm[ai:t + 1]); pk = cum.max()
            rec = (pk - cum[-1]) / pk if pk > 0 else 9.0
            fok = hasf[ai:t + 1].mean() > 0.9 and cum[-1] >= 0.5 * sm[ai] and rec < 0.30 and sm[t - 19:t + 1].sum() >= 0
            return ai, ok, vw, rec, fok
        AN = {m: anc(m) for m in ("w", "wb", "sb")}
        R = AN["wb"] or AN["w"]
        if R is None: continue
        ai, anchor_ok, vw, rec, flow_ok = R
        # ③ 눌림
        hh = h[ai:t + 1].max(); dd = cl[t] / hh - 1
        rng5 = (h[t - 4:t + 1].max() - l[t - 4:t + 1].min()) / cl[t]
        vpost = v[ai + 1:t + 1].mean() if t > ai else np.nan
        pull_core = (-0.15 <= dd <= -0.05) or rng5 <= 0.08
        pull_ok = pull_core and v[t - 2:t + 1].mean() <= 0.7 * vpost and cl[t] / cl[ai] - 1 <= 0.40
        near_vw = vw > 0 and 0.97 * vw <= cl[t] <= 1.25 * vw
        # 패턴 태그
        ye = cl[t - 1] > o[t - 1] and cl[t] < o[t] and v[t] < v[t - 1] and cl[t] > ma10[t]
        nz = hh >= cl[ai] * 1.10 and l[int(np.argmax(h[ai:t + 1])) + ai:t + 1].min() > cl[ai] and dd < 0
        if code in DIAG and dates[t] >= np.datetime64("2026-10-20"):
            DIAG[code].append((dates[t], anchor_ok, round(sm[ai] / a[ai] * 100, 1) if a[ai] > 0 else None, str(pd.Timestamp(dates[ai]).date()), near_vw, round(cl[t] / vw - 1, 3) if vw > 0 else None, flow_ok, round(rec, 2), pull_core, bool(v[t - 2:t + 1].mean() <= 0.7 * vpost), cl[t] / cl[ai] - 1 <= 0.40))
        for vn, cfg in VAR.items():
            Rv = AN[cfg["am"]]
            if Rv is None: continue
            ai, anchor_ok, vw, rec, flow_ok = Rv
            near_vw = vw > 0 and 0.97 * vw <= cl[t] <= 1.25 * vw
            hh = h[ai:t + 1].max(); dd = cl[t] / hh - 1
            vpost = v[ai + 1:t + 1].mean() if t > ai else np.nan
            pull_ok = ((-0.15 <= dd <= -0.05) or rng5 <= 0.08) and v[t - 2:t + 1].mean() <= 0.7 * vpost and cl[t] / cl[ai] - 1 <= 0.40
            ok = pull_ok and (not cfg["anchor"] or (anchor_ok and near_vw)) and (not cfg["flow"] or flow_ok)
            if not ok: continue
            sig_rows.append((vn, code, dates[t], ye, nz, cl[t] / vw - 1 if vw > 0 else np.nan, *(fwd[k][t] for k in (1, 3, 5, 10, 20))))
            if vn != MAIN or t <= last_exit: continue
            # ④ 다음날 진입 모의
            j = t + 1; trig = h[t] + tick(h[t])
            if h[j] < trig: continue
            ent = o[j] if o[j] >= trig and o[j] <= h[t] * 1.05 else (trig if o[j] < trig else np.nan)
            if not (ent > 0) or ent > cl[t] * 1.08: continue
            stop = ent * 0.96; tp1, tp2 = ent * 1.08, ent * 1.12
            left, pnl, k, below, why = 1.0, 0.0, j, 0, ""
            while True:
                hit = (l[k] <= stop) if k > j else ((cl[k] <= stop) if ED == "close" else (l[k] <= stop))   # 진입 당일 저가는 매수 전에 찍혔을 수 있음 → 기본은 종가로만 판단
                if hit:
                    px = min(stop, o[k]) if k > j else (cl[k] if ED == "close" else stop)
                    pnl += left * (px / ent - 1); left = 0; why = "손절" if stop < ent else "본전손절"; break
                if left == 1.0 and h[k] >= tp1:
                    pnl += 0.5 * 0.08; left = 0.5; stop = max(stop, ent * 1.0035)
                if left == 0.5 and h[k] >= tp2:
                    pnl += 0.5 * 0.12; left = 0; why = "익절2"; break
                below = below + 1 if (vw > 0 and cl[k] < vw * 0.97) else 0
                if below >= 2 and k + 1 < n:
                    pnl += left * (o[k + 1] / ent - 1); left = 0; why = "평단이탈"; k += 1; break
                if k - j >= 9 or k + 1 >= n:
                    pnl += left * (cl[k] / ent - 1); left = 0; why = "시간청산" if k - j >= 9 else "자료끝"; break
                k += 1
            last_exit = k
            trades.append((code, dates[t], dates[j], ent, pnl * 100 - COST, why, k - j + 1, ye, nz))

p(f"계산 {time.time()-T0:.0f}초\n")
SG = pd.DataFrame(sig_rows, columns=["var", "code", "d", "ye", "nz", "vwgap", "y1", "y3", "y5", "y10", "y20"])
B = pd.DataFrame(base_rows, columns=["code", "d", "trend", "y1", "y3", "y5", "y10", "y20"])
TR = pd.DataFrame(trades, columns=["code", "sig", "ent_d", "ent", "ret", "why", "hold", "ye", "nz"])
mid = B.d.sort_values().iloc[len(B) // 2] if len(B) else None

p("## 1. 신호일 이후 수익률(종가→종가, %)\n")
p("기준 = 같은 시총대(3천억~5조, 20일 거래대금 30억 이상)의 모든 종목·일 / 추세 기준 = 그중 종가>20일선·60·120일선 상승인 날. t = 기준(전체) 대비.\n")
p("| 구분 | 신호 수 | 종목 수 | 1일 | 3일 | 5일 | 10일 | 20일 | 10일 상승비율 | 10일 t | 10일 전반/후반 |")
p("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
def line(lab, x, ref=B):
    x = x[x.y10.notna()] if len(x) else x
    if len(x) < 5: p(f"| {lab} | {len(x)} | – | – | – | – | – | – | – | – | – |"); return
    r = ref[ref.y10.notna()]
    t = (x.y10.mean() - r.y10.mean()) / (x.y10.std(ddof=1) / np.sqrt(len(x)))
    a_, b_ = x[x.d < mid].y10, x[x.d >= mid].y10
    p(f"| {lab} | {len(x):,} | {x.code.nunique():,} | {x.y1.mean():+.2f} | {x.y3.mean():+.2f} | {x.y5.mean():+.2f} | {x.y10.mean():+.2f} | {x.y20.mean():+.2f} | {(x.y10>0).mean()*100:.0f}% | {t:+.1f} | {a_.mean():+.2f} ({len(a_)}) / {b_.mean():+.2f} ({len(b_)}) |")
line("기준(전체)", B); line("추세 기준", B[B.trend])
for vn in VAR: line(vn, SG[SG["var"] == vn])
A_ = SG[SG["var"] == MAIN]
line("A + 양음 태그", A_[A_.ye]); line("A + N자 태그", A_[A_.nz])
line("A + 평단 0~+10% 근접", A_[(A_.vwgap >= -0.03) & (A_.vwgap <= 0.10)])

p("\n## 2. 매매 모의(A 전체 조건 + 다음날 전일 고가 돌파 진입, 비용 0.25% 차감)\n")
if len(TR):
    wins = TR[TR.ret > 0].ret.sum(); loss = -TR[TR.ret <= 0].ret.sum()
    p(f"- 거래 {len(TR):,}건 · 종목 {TR.code.nunique():,} · 승률 {(TR.ret>0).mean()*100:.0f}% · 평균 {TR.ret.mean():+.2f}% · 중앙값 {TR.ret.median():+.2f}% · 손익비(PF) {wins/loss if loss>0 else float('inf'):.2f} · 평균 보유 {TR.hold.mean():.1f}일")
    p(f"- 청산 사유: " + " · ".join(f"{k} {v}" for k, v in TR.why.value_counts().items()))
    TR["half"] = np.where(pd.to_datetime(TR.sig) < mid, "전반", "후반")
    for hn, x in TR.groupby("half"): p(f"- {hn}: {len(x)}건 · 승률 {(x.ret>0).mean()*100:.0f}% · 평균 {x.ret.mean():+.2f}%")
    for tag, lab in (("ye", "양음 태그"), ("nz", "N자 태그")):
        x = TR[TR[tag]]
        if len(x): p(f"- {lab}: {len(x)}건 · 승률 {(x.ret>0).mean()*100:.0f}% · 평균 {x.ret.mean():+.2f}%")
    TR["m"] = pd.to_datetime(TR.ent_d).dt.to_period("M")
    p("\n| 월 | 거래 | 승률 | 평균% | 합계% |\n|---|---:|---:|---:|---:|")
    for m_, x in TR.groupby("m"): p(f"| {m_} | {len(x)} | {(x.ret>0).mean()*100:.0f}% | {x.ret.mean():+.2f} | {x.ret.sum():+.1f} |")
else:
    p("- 거래 없음")

p("\n## 3. 사례 확인 — 안랩(053800) · 코스맥스(192820)\n")
for cd in ("053800", "192820"):
    x = SG[SG.code == cd].sort_values("d")
    p(f"**{NAME.get(cd, cd)}** 신호일(최근 15개):")
    if not len(x): p("- 없음")
    for vn, y in x.groupby("var"):
        y = y.tail(15)
        p(f"- {vn}: " + ", ".join(f"{pd.Timestamp(d).strftime('%y/%m/%d')}" for d in y.d))
    t_ = TR[TR.code == cd]
    for _, r in t_.tail(8).iterrows():
        p(f"  - 매매 모의: 신호 {pd.Timestamp(r.sig).date()} → 진입 {pd.Timestamp(r.ent_d).date()} {r.ent:,.0f}원 · {r.why} · {r.ret:+.2f}% · {r.hold}일")

p("\n### 사례 조건 진단(10/20 이후, 추세·상한가 조건 통과한 날만)\n")
p("| 종목 | 날짜 | 앵커 통과 | 앵커일 외+기/거래대금% | 앵커일 | 평단 범위 | 평단 대비 | 이탈 없음 | 회수율 | 눌림(조정/횡보) | 거래 감소 | +40% 이내 |")
p("|---|---|---|---:|---|---|---:|---|---:|---|---|---|")
for cd, rows in DIAG.items():
    for r in rows: p(f"| {NAME.get(cd, cd)} | {pd.Timestamp(r[0]).strftime('%m/%d')} | {'O' if r[1] else 'X'} | {r[2]} | {r[3]} | {'O' if r[4] else 'X'} | {r[5]} | {'O' if r[6] else 'X'} | {r[7]} | {'O' if r[8] else 'X'} | {'O' if r[9] else 'X'} | {'O' if r[10] else 'X'} |")
p("\n## 4. 최근 신호(A, 최근 10거래일)\n")
if len(A_):
    last = sorted(A_.d.unique())[-10:]
    y = A_[A_.d.isin(last)].sort_values("d")
    for _, r in y.tail(30).iterrows():
        p(f"- {pd.Timestamp(r.d).strftime('%m/%d')} {NAME.get(r.code, r.code)}({r.code}) 평단 대비 {r.vwgap*100:+.1f}%{' · 양음' if r.ye else ''}{' · N자' if r.nz else ''}")

p(f"""
## 읽는 법·한계
- 신호일 수익률은 그날 종가 기준(진입 조건 없음), 매매 모의는 다음날 돌파 진입 + 손절·익절 규칙 적용.
- 일봉 모의라 같은 날 손절·익절이 겹치면 손절로 처리(보수적). 장중 트리거(분당 거래대금·프로그램·체결강도)는 빠져 있어 실제보다 신호가 많음.
- 스마트머니 판정은 매일 저장되는 현재 상태가 아니라 그날까지의 수급으로 다시 계산(미래 정보 없음). 상장폐지 종목은 데이터에 없을 수 있음(생존 편향).
- 진입 당일 손절 판정 {ED} · 앵커 거래대금 비중 기준 {ANCH}% · 기간 {FROM}~ · 총 {time.time()-T0:.0f}초.""")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out))
