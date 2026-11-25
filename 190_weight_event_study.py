# -*- coding: utf-8 -*-
"""무게/주식수 큰 막대(이벤트) 이후 경로 분석 — 읽기 전용.
 1) 최근 2주(10거래일) 안에 '역대 1·2위일'(사이트 '주식무게수 종목'과 같은 규칙: 2025-09~ 전체 이력 1위일, 2위 = 1위일 이후 최대)이 나온 종목의 현재 상태
 2) 과거 이벤트(그 시점까지의 신고 무게 = 미래 정보 없음, 무게 ≥ 0.3, 등락률>0) 이후 1~20일 경로:
    수익률·최대 상승·최대 하락, 그날 외+기 매수/매도별, 이후 '이벤트일 평균가(거래대금÷거래량)' 재터치 비율과 재터치일 매수 성과"""
import os, time, numpy as np, pandas as pd, psycopg2
T0 = time.time()
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)
S = Q("select code,name from stocks where security_type='STOCK'"); NAME = dict(zip(S.code, S.name))
P = Q("""select p.trade_date d,p.code,p.open o,p.high h,p.low l,p.close c,p.volume v,p.trade_amount a,p.market_cap mc,p.change_pct chg,p.weight_per_share w
         from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' where p.trade_date>='2025-09-01' order by p.code,p.trade_date""")
F = Q("select trade_date d,code,foreign_net fn,inst_net inn,pension_net pen,inv_trust_net it from daily_flow where trade_date>='2025-09-01'")
D = P.merge(F, on=["d", "code"], how="left"); D["d"] = pd.to_datetime(D["d"])
days = sorted(D.d.unique()); last = days[-1]; recent = set(days[-10:])
p(f"# 무게/주식수 큰 막대 이후 경로 분석\n\n데이터 {pd.Timestamp(days[0]).date()} ~ {pd.Timestamp(last).date()} · 종목 {D.code.nunique():,}\n")
R, EV, TRD = [], [], []
for code, g in D.groupby("code", sort=False):
    g = g.reset_index(drop=True); n = len(g)
    if n < 30: continue
    o, h, l, cl, v, a = (g[k].astype(float).values for k in ("o", "h", "l", "c", "v", "a"))
    w = np.nan_to_num(g.w.astype(float).values); chg = g.chg.astype(float).values; mc = g.mc.astype(float).values
    sm = (g.fn.fillna(0).astype(float) + g.inn.fillna(0).astype(float)).values; d = g.d.values
    pen = g.pen.fillna(0).astype(float).values; fn = g.fn.fillna(0).astype(float).values; it = g.it.fillna(0).astype(float).values
    # 1) 사이트 규칙(전체 이력)
    if w.max() > 0:
        r1 = int(np.argmax(w)); ranks = [(1, r1)]
        if r1 + 1 < n and w[r1 + 1:].max() > 0: ranks.append((2, r1 + 1 + int(np.argmax(w[r1 + 1:]))))
        for rk, i in ranks:
            if d[i] not in recent: continue
            vw = a[i] / v[i] if v[i] > 0 else np.nan
            cum = sm[i + 1:].sum() / 1e8 if i + 1 < n else 0.0
            R.append(dict(code=code, nm=NAME.get(code, code), rk=rk, d=pd.Timestamp(d[i]).strftime("%m/%d"), w=w[i] * 100, chg=chg[i], amt=a[i] / 1e8,
                          sm0=sm[i] / 1e8, smr=sm[i] / a[i] * 100 if a[i] else np.nan, fn0=fn[i] / 1e8, pen0=pen[i] / 1e8, it0=it[i] / 1e8,
                          vw=vw, now=cl[-1], gap=(cl[-1] / vw - 1) * 100, maxup=(h[i + 1:].max() / cl[i] - 1) * 100 if i + 1 < n else np.nan,
                          mdd=(l[i + 1:].min() / cl[i] - 1) * 100 if i + 1 < n else np.nan, cum=cum, k=n - 1 - i, mcap=mc[-1] / 1e8))
    # 2) 과거 이벤트(그 시점 신고 무게)
    run = np.maximum.accumulate(np.r_[-np.inf, w[:-1]])
    for i in range(20, n - 1):
        if not (w[i] >= 0.3 and chg[i] > 0 and w[i] > run[i]): continue
        if mc[i] < 1000e8: continue
        vw = a[i] / v[i] if v[i] > 0 else np.nan
        f = {k: (cl[i + k] / cl[i] - 1) * 100 if i + k < n else np.nan for k in (1, 3, 5, 10, 20)}
        end = min(n, i + 21)
        mu = (h[i + 1:end].max() / cl[i] - 1) * 100; md = (l[i + 1:end].min() / cl[i] - 1) * 100
        # 이벤트일 평균가 재터치(2~20일 안에 저가가 평균가 +2% 이내) → 그날 종가 매수 후 10일 성과
        rt = next((j for j in range(i + 2, end) if l[j] <= vw * 1.02), None)
        rt_ret = (cl[rt + 10] / cl[rt] - 1) * 100 if rt is not None and rt + 10 < n else np.nan
        rt_hold = None
        if rt is not None and cl[rt] >= vw * 0.97:   # 평균가 근처에서 지지(종가가 평균가 −3% 위)
            rt_hold = rt_ret
        sm5 = sm[i + 1:i + 6].sum() / 1e8 if i + 5 < n else np.nan
        # 매매 모의: 이벤트 뒤 (a) 바로 재터치 매수 (b) 확인 매수 = 이벤트 다음날~그날 외+기 누적>0 이고 경과 3일 이상일 때 평균가 +3% 이내 터치, 종가 ≥ 평균가 −3%
        for mode in ("a", "b"):
            for j in range(i + 2, min(n - 1, i + 31)):
                if not (l[j] <= vw * 1.03 and cl[j] >= vw * 0.97): continue
                if mode == "b" and not (j - i >= 3 and sm[i + 1:j + 1].sum() > 0): continue
                ent = cl[j]; stop = vw * 0.95; left, pnl, k, why = 1.0, 0.0, j + 1, ""
                while True:
                    if cl[k] < stop: pnl += left * (cl[k] / ent - 1); why = "손절"; break
                    if left == 1.0 and h[k] >= ent * 1.08: pnl += 0.04; left = 0.5; stop = max(stop, ent * 1.0035)
                    if left == 0.5 and h[k] >= ent * 1.12: pnl += 0.06; left = 0; why = "익절"; break
                    if k - j >= 10 or k + 1 >= n: pnl += left * (cl[k] / ent - 1); why = "시간"; break
                    k += 1
                TRD.append(dict(mode=mode, code=code, ev=d[i], d=d[j], buy=sm[i] > 0, smr=sm[i] / a[i] * 100 if a[i] else 0, up30=chg[i] >= 29, mc=mc[i] / 1e8,
                                ret=pnl * 100 - 0.25, why=why, hold=k - j, wait=j - i, R=(1 - stop / ent) * 100 if why != "익절" else np.nan))
                break
        EV.append(dict(code=code, d=d[i], w=w[i], chg=chg[i], buy=sm[i] > 0, smr=sm[i] / a[i] * 100 if a[i] else 0, sm5=sm5, mc=mc[i] / 1e8,
                       **{f"y{k}": f[k] for k in f}, mu=mu, md=md, rt=rt is not None, rt_ret=rt_ret, rt_hold=rt_hold, rtday=(rt - i) if rt is not None else np.nan,
                       up30=chg[i] >= 29))

p("## 1. 최근 2주(10거래일) 역대 1·2위일 종목 — 지금 상태\n")
p("평균가 = 그날 거래대금 ÷ 거래량. 이후 외+기 = 발생 다음날~오늘 외+기 순매수 합.\n")
p("| 종목 | 순위 | 발생일 | 무게% | 그날 등락 | 그날 외+기(억) · 거래대금 대비 | 주도(외/연/투, 억) | 평균가 | 현재가 | 평균가 대비 | 이후 최고 | 이후 최저 | 이후 외+기(억) | 경과일 |")
p("|---|---:|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|")
RD = pd.DataFrame(R).sort_values("w", ascending=False) if R else pd.DataFrame()
for _, r in RD.iterrows():
    p(f"| {r.nm} | {r.rk} | {r.d} | {r.w:,.1f} | {r.chg:+.1f}% | {r.sm0:+,.0f} ({r.smr:+.1f}%) | {r.fn0:+,.0f} / {r.pen0:+,.0f} / {r.it0:+,.0f} | {r.vw:,.0f} | {r.now:,.0f} | {r.gap:+.1f}% | {r.maxup:+.1f}% | {r.mdd:+.1f}% | {r.cum:+,.0f} | {r.k} |")

E = pd.DataFrame(EV)
p(f"\n## 2. 과거 이벤트(그 시점 신고 무게 ≥ 30% · 상승 · 시총 1천억 이상) 이후 경로\n\n이벤트 {len(E):,}건 · 종목 {E.code.nunique() if len(E) else 0}\n")
def blk(lab, x):
    if len(x) < 5: p(f"| {lab} | {len(x)} | | | | | | | | | | |"); return
    p(f"| {lab} | {len(x)} | {x.y1.mean():+.2f} | {x.y3.mean():+.2f} | {x.y5.mean():+.2f} | {x.y10.mean():+.2f} | {x.y20.mean():+.2f} | {(x.y10>0).mean()*100:.0f}% | {x.mu.median():+.1f} | {x.md.median():+.1f} | {x.rt.mean()*100:.0f}% | {x.rt_hold.dropna().mean():+.2f} ({x.rt_hold.notna().sum()}) |")
p("| 구분 | 건수 | 1일 | 3일 | 5일 | 10일 | 20일 | 10일 상승비율 | 20일 내 최고(중앙) | 20일 내 최저(중앙) | 평균가 재터치 비율 | 재터치·지지일 매수 10일 |")
p("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
if len(E):
    blk("전체", E)
    blk("그날 외+기 순매수", E[E.buy]); blk("그날 외+기 순매도", E[~E.buy])
    blk("그날 외+기 ≥ 거래대금 5%", E[E.smr >= 5])
    blk("이후 5일 외+기 순매수(사후 정보)", E[E.sm5 > 0]); blk("이후 5일 외+기 순매도(사후 정보)", E[E.sm5 <= 0])
    blk("상한가 이벤트", E[E.up30]); blk("상한가 아님", E[~E.up30])
    blk("시총 1천억~5천억", E[E.mc < 5000]); blk("시총 5천억~2조", E[(E.mc >= 5000) & (E.mc < 20000)]); blk("시총 2조 이상", E[E.mc >= 20000])
    p(f"\n평균가 재터치까지 걸린 날(중앙값): {E.rtday.median():.0f}일 · 재터치한 이벤트 중 그날 종가가 평균가 −3% 위(지지) 비율: {E.rt_hold.notna().sum() / max(1, E.rt.sum()) * 100:.0f}%")
    E["m"] = pd.to_datetime(E.d).dt.to_period("M")
    p("\n| 월 | 이벤트 | 10일 평균 | 재터치·지지 매수 10일 |\n|---|---:|---:|---|")
    for m_, x in E.groupby("m"): p(f"| {m_} | {len(x)} | {x.y10.mean():+.2f} | {x.rt_hold.dropna().mean():+.2f} ({x.rt_hold.notna().sum()}) |")
T = pd.DataFrame(TRD)
p("\n## 3. 매매 모의 — 이벤트 뒤 평균가 재터치 종가 매수 · 손절 = 평균가 −5% 아래 종가 마감 · 익절 +8/+12% · 10일 · 비용 0.25%\n")
p("(a) = 처음 재터치한 날 바로 · (b) = 이벤트 3일 이상 지나고 그 사이 외+기 누적이 순매수일 때의 재터치(확인 매수)\n")
p("| 구분 | 거래 | 승률 | 평균% | 중앙값% | PF | 평균 대기일 | 평균 보유일 | 청산 |\n|---|---:|---:|---:|---:|---:|---:|---:|---|")
def tl(lab, x):
    if len(x) < 5: p(f"| {lab} | {len(x)} | | | | | | | |"); return
    wn, ls = x[x.ret > 0].ret.sum(), -x[x.ret <= 0].ret.sum()
    p(f"| {lab} | {len(x)} | {(x.ret>0).mean()*100:.0f}% | {x.ret.mean():+.2f} | {x.ret.median():+.2f} | {wn/ls if ls>0 else float('inf'):.2f} | {x.wait.mean():.1f} | {x.hold.mean():.1f} | " + " · ".join(f"{k} {v}" for k, v in x.why.value_counts().items()) + " |")
if len(T):
    for m in ("a", "b"):
        x = T[T["mode"] == m]
        tl(f"({m}) 전체", x)
        tl(f"({m}) 그날 외+기 ≥ 5% · 상한가 아님", x[(x.smr >= 5) & ~x.up30])
        tl(f"({m}) 위 + 시총 2조 미만", x[(x.smr >= 5) & ~x.up30 & (x.mc < 20000)])
        tl(f"({m}) 상한가 이벤트", x[x.up30])
    x = T[(T["mode"] == "b") & (T.smr >= 5) & ~T.up30 & (T.mc < 20000)].copy()
    if len(x):
        x["m"] = pd.to_datetime(x.d).dt.to_period("M")
        p("\n(b) 외+기 ≥5% · 상한가 아님 · 2조 미만 — 월별\n\n| 월 | 거래 | 승률 | 평균% |\n|---|---:|---:|---:|")
        for m_, y in x.groupby("m"): p(f"| {m_} | {len(y)} | {(y.ret>0).mean()*100:.0f}% | {y.ret.mean():+.2f} |")
        p("\n최근 거래(최대 15건): " + ", ".join(f"{NAME.get(r.code, r.code)} {pd.Timestamp(r.d).strftime('%m/%d')} {r.ret:+.1f}%" for _, r in x.sort_values("d").tail(15).iterrows()))
p(f"\n총 {time.time()-T0:.0f}초. '사후 정보' 행은 이벤트 다음 5일 수급을 알고 나서 나눈 것이라 실제 매매 조건으로 쓸 수 없고 참고용.")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out))
