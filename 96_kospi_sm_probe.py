# -*- coding: utf-8 -*-
"""KOSPI 지수를 한 종목으로 보고 sm_core 국면 판정을 돌려 월별 요약·조건 충족 현황을 리포트(읽기 전용)."""
import os, sys, psycopg2
from sm_core import sm_series
url = os.environ.get("SUPABASE_DB_URL", "")
if not url: sys.exit("SUPABASE_DB_URL 미설정")
conn = psycopg2.connect(url); cur = conn.cursor()
cur.execute("select trade_date,index_close from market_daily where market='KOSPI' and index_close>0 order by 1")
idx = {d: float(c) for d, c in cur.fetchall()}
cur.execute("select trade_date,foreign_net,inv_trust_net,pe_net,pension_net,individual_net,market_cap,volume from v_kospi_flow_daily order by 1")
rows = []
for d, f, it, pe, pn, ind, mc, vol in cur.fetchall():
    if d not in idx: continue
    c = idx[d]
    rows.append(dict(date=str(d), close=c, high=c, low=c, volume=float(vol or 0), trade_amount=0,
                     market_cap=float(mc or 0), sm=float((f or 0)+(it or 0)+(pe or 0)+(pn or 0)), ind=float(ind or 0)))
out = []
for W in (120, 60):
    s = sm_series(rows, W)
    out.append(f"\n## W={W} — 월말 기준\n| 월말 | 지수 | 국면 | 일수 | SM 지분변화(W) | 20일 | 개인(W) | 개인20 | 보유% | 최대% | 괴리 | W수익률 |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    last = {}
    for r in s: last[r["date"][:7]] = r
    for m, r in sorted(last.items()):
        g = "" if r["gap"] is None else f"{r['gap']*100:+.1f}%"
        out.append(f"| {r['date']} | {r['close']:.0f} | {r['phase']} | {r['phase_days']} | {r['dW']:+.3f} | {r['d20']:+.3f} | {r['indW']:+.3f} | {r['ind20']:+.3f} | {r['hold_pct']:.3f} | {r['peak_pct']:.3f} | {g} | {r['retW']*100:+.1f}% |")
    out.append("\n국면 변화: " + ", ".join(f"{s[i]['date']}→{s[i]['phase']}" for i in range(1, len(s)) if s[i]['phase'] != s[i-1]['phase']))
# 7월 이후 일별 요약(W=120)
s = sm_series(rows, 120)
out.append("\n## W=120 일별 (2026-07-01 이후, 5일 간격)\n| 날짜 | 지수 | 국면 | d20 | ind20 | 보유% | 최대% | 괴리 |\n|---|---|---|---|---|---|---|---|")
for r in [x for x in s if x['date'] >= '2026-07-01'][::5]:
    g = "" if r["gap"] is None else f"{r['gap']*100:+.1f}%"
    out.append(f"| {r['date']} | {r['close']:.0f} | {r['phase']} | {r['d20']:+.3f} | {r['ind20']:+.3f} | {r['hold_pct']:.3f} | {r['peak_pct']:.3f} | {g} |")
open("kospi_sm_report.md", "w", encoding="utf-8").write("# KOSPI SM 판정 점검\n" + "\n".join(out) + "\n")
print("done", len(rows))
