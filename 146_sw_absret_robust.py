# -*- coding: utf-8 -*-
"""절대수익 전략 2차(읽기 전용): 유력 전략의 견고성 — 조건 변형, 거래 내역, 총자금 기준 결합, 종목 편입 시점 편향 점검."""
import itertools
src = open("145_sw_absret_bt.py", encoding="utf-8").read()
exec(src.split('P("# 절대수익 전략 백테스트')[0])
P("# 절대수익 전략 2차: 견고성 점검 (읽기 전용)")
P(f"- 검증 구간 {D[D>=P1][0]:%Y-%m-%d}~{D[-1]:%Y-%m-%d} · 비용 포함 · 수급 신호는 전일까지 값")
EL = LIQ & C.notna(); SM = EL & (CAP <= 2e12); down = (KS < ma[60]).astype(float); up = 1 - down

# ── 0. 종목 편입 시점 편향 점검
P("\n## 0. 추적 종목 편입 시점")
cur = conn.cursor()
try:
    cur.execute("select to_char(first_seen,'YYYY-MM'), count(*) from stocks where is_active and security_type='STOCK' group by 1 order by 1")
    P("- stocks.first_seen 분포: " + ", ".join(f"{a} {b}" for a, b in cur.fetchall()))
except Exception as e: P(f"- first_seen 조회 실패 {str(e)[:80]}")
live = None
try:
    q = pd.read_sql("""select f.code, min(f.trade_date) filter (where f.collected_at is not null and f.collected_at::date - f.trade_date <= 5) live_from,
                              min(f.collected_at) first_col, count(*) filter (where f.collected_at is null) n_null, count(*) n
                       from daily_flow f join stocks s on s.code=f.code and s.security_type='STOCK' and s.is_active group by 1""", conn)
    q["live_from"] = pd.to_datetime(q["live_from"]); q["first_col"] = pd.to_datetime(q["first_col"]).dt.tz_localize(None)
    P(f"- 수급 수집시각(collected_at) 기록이 처음 있는 날: 최소 {q['first_col'].min()} · 수집시각이 비어 있는 행 비율 {q['n_null'].sum()/q['n'].sum()*100:.0f}%")
    P("- 종목별 '거래일 5일 이내에 수집된 첫 거래일'(=실시간 수집 시작 추정) 월 분포: " + ", ".join(f"{k} {v}" for k, v in q["live_from"].dt.strftime("%Y-%m").value_counts().sort_index().items()))
    live = q.set_index("code")["live_from"]
except Exception as e: P(f"- collected_at 점검 실패 {str(e)[:120]}")
span = px.groupby("code")["d"].agg(["min", "count"])
P("- 종목별 가격 데이터 시작월 분포: " + ", ".join(f"{k} {v}" for k, v in span["min"].dt.strftime("%Y-%m").value_counts().sort_index().items()))
late = None
if live is not None and live.notna().sum() > 50:
    base = live.min()
    late = live[(live > base + pd.Timedelta(days=20))].index
    nm = px.drop_duplicates("code").set_index("code")["name"]
    P(f"- 실시간 수집 시작이 다른 종목보다 20일 이상 늦은 종목(나중에 추가된 것으로 추정): {len(late)}개 — " + ", ".join(f"{nm.get(c, c)}({live[c]:%m-%d})" for c in list(late)[:40]))

# ── 1. 조합 F 변형
P("\n## 1. 선별 매수(조합 F) 조건 변형\n"); P(HD)
def F(chg=3, amt=5e9, smv=0.002, cap=2e12, gate="pos30", k=3, ma20=True, elig=None):
    e = EL if elig is None else elig
    m = (CHG >= chg) & (AMT >= amt) & (sm5 >= smv) & e
    if ma20: m = m & (C > MA20)
    if cap: m = m & (CAP <= cap)
    W = tranche(m, k)
    g = {"none": pd.Series(1.0, index=D), "pos30": (pos20 > 0.3).astype(float), "pos50": (pos20 > 0.5).astype(float), "ma20": (KS > ma[20]).astype(float), "ma60": (KS > ma[60]).astype(float),
         "pos30orUp": ((pos20 > 0.3) | (KS > ma[60])).astype(float)}[gate]
    return W.mul(g, axis=0)
rep("기본: +3%·50억·5일 수급 0.2%·시총 2조 이하·20일선 위·지수 위치 30% 초과·3일 보유", *run(W=F()))
for nm, kw in [("수급 기준 0.1%", dict(smv=0.001)), ("수급 기준 0.3%", dict(smv=0.003)), ("수급 조건 없음", dict(smv=-9)),
               ("시총 1조 이하", dict(cap=1e12)), ("시총 5조 이하", dict(cap=5e12)), ("시총 제한 없음", dict(cap=None)),
               ("당일 +2% 이상", dict(chg=2)), ("당일 +5% 이상", dict(chg=5)), ("등락 조건 없음(수급·20일선·시총만)", dict(chg=-99, amt=0)),
               ("20일선 조건 없음", dict(ma20=False)), ("2일 보유", dict(k=2)), ("5일 보유", dict(k=5)), ("10일 보유", dict(k=10)),
               ("지수 조건 없음", dict(gate="none")), ("지수 위치 50% 초과", dict(gate="pos50")), ("지수 20일선 위일 때만", dict(gate="ma20")), ("지수 60일선 위일 때만", dict(gate="ma60"))]:
    rep("  · " + nm, *run(W=F(**kw)))
WF = F()
P(f"\n- 기본 조건 하루 평균 신규 종목 수: 검증 구간 {(((CHG>=3)&(AMT>=5e9)&(sm5>=0.002)&EL&(C>MA20)&(CAP<=2e12))[D>=P1].sum(axis=1)).mean():.1f}개 · 보유 종목 수 평균 {(WF[D>=P1]>0).sum(axis=1).mean():.1f}개 · 투자 비중 0인 날 {int((WF[D>=P1].sum(axis=1)==0).sum())}일")
c = (WF[WF.index >= P1].shift(1) * R.reindex(WF.index[WF.index >= P1])).sum().sort_values(); nm = px.drop_duplicates("code").set_index("code")["name"]
P("- 검증 구간 종목별 기여(%p): 상위 " + ", ".join(f"{nm.get(k, k)} {v*100:+.1f}" for k, v in c.tail(6)[::-1].items()) + " / 하위 " + ", ".join(f"{nm.get(k, k)} {v*100:+.1f}" for k, v in c.head(5).items()))
P(f"- 상위 5종목을 빼면: 검증 구간 합계 기여 {c.sum()*100:+.1f}%p → {c.iloc[:-5].sum()*100:+.1f}%p")

# ── 2. 반등 매도 인버스 거래 내역
P("\n## 2. 반등 매도 인버스 — 거래 내역(검증 구간)")
sig = (KS / KS.shift(3) - 1 >= 0.04) & (KS < ma[60]); w = hold(sig, 5)
ent = w[(w > 0) & (w.shift(1).fillna(0) == 0)].index
P(f"- 신호 발생일: 검증 구간 {int(sig[D>=P1].sum())}일(진입 {int((ent>=P1).sum())}회) · 이전 구간 {int(sig[D<P1].sum())}일(진입 {int((ent<P1).sum())}회)")
P("\n| 진입일 | 지수 | 직전 3일 | 보유 종료 | 인버스 수익 |\n|---|---|---|---|---|")
for e in ent:
    j = D.get_loc(e); k = j
    while k + 1 < len(D) and w.iloc[k + 1] > 0: k += 1
    k2 = min(k + 1, len(D) - 1); rr = (1 + INV.iloc[j + 1:k2 + 1]).prod() - 1
    P(f"| {e:%Y-%m-%d} | {KS[e]:,.0f} | {(KS[e]/KS.iloc[j-3]-1)*100:+.1f}% | {D[k2]:%m-%d} | {rr*100:+.1f}% |")
P("\n변형\n"); P(HD)
rep("기본(3일 +4%, 60일선 아래, 5일 보유)", *run(wv=w))
rep("  · 2배 인버스", *run(wv2=w))
rep("  · 20일선 아래 조건으로", *run(wv=hold((KS / KS.shift(3) - 1 >= 0.04) & (KS < ma[20]), 5)))
rep("  · 추세 조건 없이", *run(wv=hold((KS / KS.shift(3) - 1 >= 0.04), 5)))
rep("  · 5일 +6% 반등 기준", *run(wv=hold((KS / KS.shift(5) - 1 >= 0.06) & (KS < ma[60]), 5)))
rep("  · 당일 +3% 이상 급등일 기준", *run(wv=hold((kr >= 0.03) & (KS < ma[60]), 5)))

# ── 3. 총자금 기준 결합(비중 합 ≤ 100%)
P("\n## 3. 총자금 기준 결합 포트폴리오(비중 합계 100% 이내)\n"); P(HD)
Wf = topn(fo20, 15, SM); Ws = SM.astype(float).div(SM.sum(axis=1), axis=0)
rep("A. 선별 매수(F) 100%", *run(W=WF))
rep("B. 반등 매도 인버스 100%", *run(wv=w))
rep("C. 선별 매수 50% + 반등 매도 인버스 50%", *run(W=WF * 0.5, wv=w * 0.5))
rep("D. 선별 매수 70% + 반등 매도 인버스 30%", *run(W=WF * 0.7, wv=w * 0.3))
rep("E. 하락 추세: 외국인 매집 바스켓 50% + 인버스 50% / 상승 추세: 바스켓 100%", *run(W=Wf.mul(0.5 * down + up, axis=0), wv=0.5 * down))
rep("F. 하락 추세: 시총 2조 이하 전체 50% + 인버스 50% / 상승 추세: 바스켓 100%", *run(W=Ws.mul(0.5 * down + up, axis=0), wv=0.5 * down))
rep("G. 하락 추세: 선별 매수 50% + 인버스 상시 25% + 반등 매도 25% / 상승 추세: 선별 매수 100%", *run(W=WF.mul(0.5 * down + up, axis=0), wv=0.25 * down + 0.25 * w))
rep("H. 하락 추세: 바스켓 60% + 인버스 40%(베타 중립 근사) / 상승 추세: 바스켓 100%", *run(W=Wf.mul(0.6 * down + up, axis=0), wv=0.4 * down))
rep("I. 선별 매수 50% + (하락 추세일 때) 인버스 25% + 반등 매도 25%", *run(W=WF * 0.5, wv=0.25 * down + 0.25 * w))

# ── 4. 나중에 추가된 종목 제외 재검증
P("\n## 4. 나중에 추가된 것으로 추정되는 종목을 뺀 재검증\n")
if late is not None and len(late):
    keep = ~C.columns.isin(late); EL2 = EL & keep; SM2 = SM & keep
    P(f"- 제외 {len(late)}종목 · 남은 종목 {int(keep.sum())}개\n"); P(HD)
    rep("선별 매수(F) 기본", *run(W=F(elig=EL2)))
    Wf2 = topn(fo20, 15, SM2); Ws2 = SM2.astype(float).div(SM2.sum(axis=1), axis=0)
    rep("외국인 20일 매집 상위 15 · 시총 2조 이하(헤지 없음)", *run(W=Wf2))
    rep("[헤지] 외국인 20일 매집 상위 15 · 시총 2조 이하", *run(W=Wf2, wv=Wf2.sum(axis=1)))
    rep("[헤지] 시총 2조 이하 전체", *run(W=Ws2, wv=Ws2.sum(axis=1)))
    rep("E. 하락 추세: 바스켓 50% + 인버스 50% / 상승 추세: 바스켓 100%", *run(W=Wf2.mul(0.5 * down + up, axis=0), wv=0.5 * down))
    rep("C. 선별 매수 50% + 반등 매도 인버스 50%", *run(W=F(elig=EL2) * 0.5, wv=w * 0.5))
else:
    P("- 편입 시점을 구분할 수 없어 재검증하지 못함")

# ── 5. 손실 구간 점검
P("\n## 5. 최대 낙폭 구간")
for nm_, (r, g) in (("선별 매수(F)", run(W=WF)), ("C. 선별 50% + 반등 매도 50%", run(W=WF * 0.5, wv=w * 0.5)), ("E. 국면 전환(바스켓+인버스)", run(W=Wf.mul(0.5 * down + up, axis=0), wv=0.5 * down))):
    for lab, rr in (("검증 구간", r[r.index >= P1]), ("이전 구간", r[r.index < P1])):
        eq = (1 + rr).cumprod(); dd = eq / eq.cummax() - 1; t = dd.idxmin(); pk = eq[:t].idxmax()
        P(f"- {nm_} · {lab}: 최대 낙폭 {dd.min()*100:.1f}% ({pk:%Y-%m-%d} → {t:%Y-%m-%d}) · 최악의 하루 {rr.min()*100:+.1f}% ({rr.idxmin():%m-%d}) · 최악의 5일 {((1+rr).rolling(5).apply(np.prod)-1).min()*100:+.1f}%")
