# -*- coding: utf-8 -*-
"""글로벌 상승률 점검: 시장별 분포·TOP 점유율·미국 값 원자료 대조 — 읽기 전용."""
import os, psycopg2, statistics as st
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
cur.execute("select * from v_global_ret"); cols = [c[0] for c in cur.description]; R = [dict(zip(cols, r)) for r in cur.fetchall()]
f = lambda x: float(x)
grp = lambda r: ("KR-" if r["mkt"] == "KR" else "해외-") + ("ETF" if r["kind"] == "ETF" else "주식")
log("# 글로벌 상승률 점검\n## 시장·종류별 상승률 분포 (중앙값 / 상위10% / 최대, %) 와 TOP50 점유")
for k in ("r1", "r5", "r21", "r63"):
    V = [r for r in R if r[k] is not None]
    top = sorted(V, key=lambda r: -f(r[k]))[:50]
    log(f"\n### {k} · 대상 {len(V)}")
    for g in ("KR-주식", "KR-ETF", "해외-주식", "해외-ETF"):
        a = sorted(f(r[k]) for r in V if grp(r) == g)
        if not a: continue
        log(f"- {g}: {len(a)}개 · 중앙 {st.median(a):+.1f} · 상위10% {a[int(len(a)*0.9)]:+.1f} · 최대 {a[-1]:+.1f} · TOP50 점유 {sum(1 for r in top if grp(r)==g)}")
    log("- 해외 최상위 5: " + ", ".join(f"{r['name']}({r['code']}) {f(r[k]):+.1f}%" for r in sorted([r for r in V if r['mkt'] != 'KR'], key=lambda r: -f(r[k]))[:5]))
log("\n## 해외 종목 값 원자료 대조 (뷰 vs us_daily 직접 계산)")
for code in ("KYMR", "NVDA", "APP", "SOXX"):
    cur.execute("select trade_date, close, volume from us_daily where code=%s and volume>0 order by trade_date desc limit 65", (code,)); d = cur.fetchall()
    if len(d) < 64: log(f"- {code}: 일수 부족 {len(d)}"); continue
    c = [f(x[1]) for x in d]; calc = {k: (c[0]/c[i]-1)*100 for k, i in (("r1",1),("r5",5),("r21",21),("r63",63))}
    v = next((r for r in R if r["code"] == code), None)
    log(f"- {code}: 원자료 최신 {d[0][0]} · 직접계산 " + " ".join(f"{k}={calc[k]:+.2f}" for k in calc) + " · 뷰 " + (" ".join(f"{k}={f(v[k]):+.2f}" for k in calc) if v else "없음"))
log("\n## 해외 일봉 건강도")
cur.execute("select count(distinct code), min(trade_date), max(trade_date), count(*) from us_daily"); log(f"- us_daily 종목 {cur.fetchone()}")
cur.execute("select count(*) from us_daily where volume=0 or close<=0"); log(f"- 거래량0·종가0 행: {cur.fetchone()[0]}")
cur.execute("select trade_date, count(*) from us_daily where trade_date>=current_date-14 group by 1 order by 1"); log("- 최근 일자별 종목수: " + str(cur.fetchall()))
cur.execute("select code,name_ko,kis_excd,is_etf from us_master order by code"); M = cur.fetchall()
cur.execute("select distinct code from us_daily"); have = {x[0] for x in cur.fetchall()}
log("- us_master 있으나 일봉 없음: " + ", ".join(f"{m[0]}" for m in M if m[0] not in have))
open("global_ret_diag.md", "w", encoding="utf-8").write("\n".join(L))
