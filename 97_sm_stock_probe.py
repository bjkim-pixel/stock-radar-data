# -*- coding: utf-8 -*-
"""한 종목의 스마트머니 국면 판정 근거(조건별 충족 여부)를 월·주 단위로 리포트(읽기 전용). 사용: python 97_sm_stock_probe.py 006400"""
import os, sys, importlib
import psycopg2
sm = importlib.import_module("91_smart_money"); smc = sm.smc
code = sys.argv[1] if len(sys.argv) > 1 else "006400"
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
by = sm.load(cur); rows = sm.with_sm(by[code], ("foreign", "inv_trust", "pe", "pension"))
cur.execute("select name from stocks where code=%s", (code,)); name = cur.fetchone()[0]
out = [f"# {name}({code}) 스마트머니 판정 근거\n"]
for W in (120,):
    s = smc.sm_series(rows, W)
    dth, rth = smc.thresholds(W)
    out.append(f"W={W} 기준: 매집 = dW≥{dth} AND 120일 수익률<{rth*100:.0f}% AND 개인(W)<0\n")
    out.append("| 날짜 | 종가 | 국면 | dW | 수익률W | 개인W | 매집조건 | 보유% | 최대% | 괴리 |\n|---|---|---|---|---|---|---|---|---|---|")
    for r in s[::5]:
        acc = r["dW"] >= dth and r["retW"] < rth and r["indW"] < 0
        g = "" if r["gap"] is None else f"{r['gap']*100:+.1f}%"
        why = "O" if acc else "X(" + ",".join(n for n, ok in (("지분", r["dW"] >= dth), ("수익률", r["retW"] < rth), ("개인", r["indW"] < 0)) if not ok) + ")"
        out.append(f"| {r['date']} | {r['close']:.0f} | {r['phase']} | {r['dW']:+.2f} | {r['retW']*100:+.0f}% | {r['indW']:+.2f} | {why} | {r['hold_pct']:.2f} | {r['peak_pct']:.2f} | {g} |")
open("sm_stock_report.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
print("done")
