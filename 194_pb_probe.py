# -*- coding: utf-8 -*-
"""눌림목 관찰 목록 점검(읽기 전용, 2026-11-26): 종목 하나(PROBE_NAME, 기본 에스엠)가 왜 관찰 목록에 없는지 — 최근 일봉의 무게·막대 판정·평균가 재터치 이력."""
import os, numpy as np, pandas as pd, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
Q = lambda s: pd.read_sql(s, c)
NAME = os.environ.get("PROBE_NAME") or "에스엠"
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)
S = Q(f"select code,name,security_type from stocks where name like '%{NAME}%' order by 1")
p(f"# 눌림목 점검: {NAME}\n"); p(S.to_string(index=False))
code = S[S.security_type == "STOCK"].code.iloc[0] if (S.security_type == "STOCK").any() else S.code.iloc[0]
D = Q(f"select trade_date d,open,high,low,close,volume,trade_amount amt,weight_per_share w,change_pct chg,market_cap mc from daily_price where code='{code}' and trade_date>='2025-09-01' order by 1")
D["d"] = pd.to_datetime(D["d"])
for k in ["open","high","low","close","volume","amt","w","chg","mc"]: D[k] = D[k].astype(float)
p(f"\n- 코드 {code} · 일봉 {len(D)}일 · 마지막 {D.d.max().date()} · 최대 무게 {D.w.max():.3f}(주식수 대비) · 시총 {D.mc.iloc[-1]/1e8:,.0f}억")
H = D[D.w >= 0.3].copy(); run = -1; bars = []
for _, r in H.iterrows():
    if r.w > run and r.chg > 0 and r.mc >= 1000e8: bars.append(r)
    if r.w > run: run = r.w
p(f"\n## 무게 ≥ 0.3 인 날 {len(H)}일 → 신고 막대 {len(bars)}개")
for r in bars: p(f"- 막대 {r.d.date()} 무게 {r.w:.2f} 등락 {r.chg:+.1f}% 시총 {r.mc/1e8:,.0f}억")
p("\n## 최근 25일 무게(상위)\n| 날짜 | 종가 | 등락 | 무게 | 거래량 |\n|---|---:|---:|---:|---:|")
for _, r in D.tail(25).iterrows(): p(f"| {r.d.date()} | {r.close:,.0f} | {r.chg:+.1f}% | {r.w:.3f} | {r.volume:,.0f} |")
p("\n## 막대별 상태(규칙: 막대 +2거래일~30거래일, 처음 재터치 전)")
for b in bars:
    h = D[D.d >= b.d].reset_index(drop=True)
    vw = b.amt / b.volume; hi, lo, stop = vw*1.03, vw*0.97, vw*0.95; touched = None; broken = None
    for j in range(2, len(h)):
        x = h.iloc[j]
        if touched is None and x.low <= hi and x.close >= lo: touched = x.d.date()
    for j in range(1, len(h)):
        if h.iloc[j].close < stop: broken = h.iloc[j].d.date(); break
    age = len(h)
    why = "관찰 대상" if (age >= 2 and age <= 30 and not touched) else ("재터치 이미 함 " + str(touched) if touched else "막대 후 30거래일 초과" if age > 30 else "막대 직후")
    p(f"- 막대 {b.d.date()} 평균가 {vw:,.0f}원(재터치 구간 {lo:,.0f}~{hi:,.0f}) · 경과 {age}거래일 · 현재가 {h.close.iloc[-1]:,.0f} · 재터치 {touched} · 손절선 아래 마감 {broken} → **{why}**")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
