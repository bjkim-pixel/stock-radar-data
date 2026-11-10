# -*- coding: utf-8 -*-
"""① 선별 매수에 손절·익절을 붙였을 때(읽기 전용). 거래 단위: 신호일 종가 매수 → 3거래일 뒤 종가 청산, 그 전에 손절가에 닿으면 손절가(갭 하락이면 시가)에 청산."""
src = open("145_sw_absret_bt.py", encoding="utf-8").read()
exec(src.split('P("# 절대수익 전략 백테스트')[0])
ohl = pd.read_sql("select p.trade_date d, p.code, p.open o, p.high h, p.low l from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'", conn)
ohl["d"] = pd.to_datetime(ohl["d"])
pv = lambda c: pd.to_numeric(ohl[c], errors="coerce").where(lambda x: x > 0).groupby([ohl["d"], ohl["code"]]).first().unstack().reindex(D).reindex(columns=C.columns)
O, Hh, Ll = pv("o"), pv("h"), pv("l")
EL = LIQ & C.notna(); gate = (pos20 > 0.3)
mask = (CHG >= 3) & (AMT >= 5e9) & (sm5 >= 0.002) & EL & (C > MA20) & (CAP <= 2e12)
vol = (R.abs().rolling(20, min_periods=10).mean())
tr = pd.concat([(Hh - Ll), (Hh - C.shift(1)).abs(), (Ll - C.shift(1)).abs()]).groupby(level=0).max().reindex(D)
atr = (tr.rolling(14, min_periods=7).mean() / C)
trades = [(i, c) for i, d in enumerate(D) if gate[d] for c in mask.columns[mask.loc[d].values] if i + 3 < len(D)]
P("# ① 선별 매수: 손절·익절 규칙 비교 (거래 단위, 비용 0.25% 차감)")
P(f"- 거래 {len(trades)}건 (검증 구간 {sum(1 for i,_ in trades if D[i]>=P1)}건) · 3거래일 보유 기준")
def sim(stop=None, take=None, K=3):
    out = []
    for i, c in trades:
        e = C.iat[i, C.columns.get_loc(c)]; j = C.columns.get_loc(c)
        s = stop(i, j, e) if stop else None; t = take(i, j, e) if take else None; x = None; why = "만기"
        for k in range(1, K + 1):
            o, h, l = O.iat[i + k, j], Hh.iat[i + k, j], Ll.iat[i + k, j]
            if s is not None and not np.isnan(l):
                if not np.isnan(o) and o <= s: x = o; why = "손절"; break
                if l <= s: x = s; why = "손절"; break
            if t is not None and not np.isnan(h) and h >= t: x = max(t, o) if not np.isnan(o) else t; why = "익절"; break
        if x is None: x = C.iat[i + K, j]
        if np.isnan(x) or abs(x / e - 1) > 0.6: continue
        out.append((D[i], (x / e - 1) * 100 - 0.25, why))
    return pd.DataFrame(out, columns=["d", "r", "why"])
P("\n| 규칙 | 검증 구간 평균 | 승률 | 손절 비율 | 최악 | 하위 5% | 이전 구간 평균 | 이전 승률 | 이전 최악 |\n|---|---|---|---|---|---|---|---|---|")
def row(nm, df):
    a = df[df["d"] >= P1]; b = df[df["d"] < P1]
    P(f"| {nm} | {a['r'].mean():+.2f}% | {(a['r']>0).mean()*100:.0f}% | {(a['why']=='손절').mean()*100:.0f}% | {a['r'].min():+.1f}% | {a['r'].quantile(0.05):+.1f}% | {b['r'].mean():+.2f}% | {(b['r']>0).mean()*100:.0f}% | {b['r'].min():+.1f}% |")
row("손절 없음(3일 뒤 청산)", sim())
for p_ in (3, 5, 7, 10): row(f"고정 -{p_}% 손절", sim(stop=lambda i, j, e, p_=p_: e * (1 - p_ / 100)))
for k in (1, 1.5, 2, 3): row(f"하루 변동폭(20일 평균)의 {k}배 손절", sim(stop=lambda i, j, e, k=k: e * (1 - k * vol.iat[i, j]) if not np.isnan(vol.iat[i, j]) else None))
for k in (1, 1.5, 2): row(f"ATR(14)의 {k}배 손절", sim(stop=lambda i, j, e, k=k: e * (1 - k * atr.iat[i, j]) if not np.isnan(atr.iat[i, j]) else None))
row("신호일 저가 이탈 손절", sim(stop=lambda i, j, e: Ll.iat[i, j] if not np.isnan(Ll.iat[i, j]) else None))
for t_ in (5, 10, 15): row(f"손절 없음 + {t_}% 익절", sim(take=lambda i, j, e, t_=t_: e * (1 + t_ / 100)))
row("변동폭 2배 손절 + 10% 익절", sim(stop=lambda i, j, e: e * (1 - 2 * vol.iat[i, j]) if not np.isnan(vol.iat[i, j]) else None, take=lambda i, j, e: e * 1.10))
for K in (2, 5, 10): row(f"손절 없음 · {K}일 보유", sim(K=K)); 
for K in (5, 10): row(f"변동폭 2배 손절 · {K}일 보유", sim(stop=lambda i, j, e: e * (1 - 2 * vol.iat[i, j]) if not np.isnan(vol.iat[i, j]) else None, K=K))
v = vol.stack().dropna(); P(f"\n- 하루 변동폭(20일 평균) 중앙값 {v.median()*100:.1f}% · 선별 종목의 중앙값 {np.nanmedian([vol.iat[i, C.columns.get_loc(c)] for i, c in trades])*100:.1f}%")
