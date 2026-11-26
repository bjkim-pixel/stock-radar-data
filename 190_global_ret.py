# -*- coding: utf-8 -*-
"""글로벌 상승률 뷰(v_global_ret) 적용 + 점검 리포트 — 2026-11-27. 뷰만 만들고 데이터는 바꾸지 않습니다."""
import os, time, psycopg2
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "190_global_ret.sql"), encoding="utf-8").read())
log("# 글로벌 상승률 뷰 점검\n- v_global_ret 적용 OK")
t = time.time(); cur.execute("select * from v_global_ret"); rows = cur.fetchall(); ms = (time.time() - t) * 1000
cols = [c[0] for c in cur.description]; R = [dict(zip(cols, r)) for r in rows]
log(f"- 전체 {len(R)}행 · 조회 {ms:.0f}ms")
log("\n## 시장·종류별")
cur.execute("select mkt,kind,count(*),max(last_date),min(n),sum((n<65)::int),sum((lev='L')::int),sum((lev='I')::int) from v_global_ret group by 1,2 order by 1,2")
for r in cur.fetchall(): log(f"- {r[0]} {r[1]}: {r[2]}개 · 최신 {r[3]} · 최소 일수 {r[4]} · 65일 미만 {r[5]} · 레버리지 {r[6]} · 인버스 {r[7]}")
cur.execute("select security_type,count(*) from stocks where coalesce(is_active,true) group by 1 order by 2 desc"); log("- stocks 종류: " + ", ".join(f"{a} {b}" for a, b in cur.fetchall()))
for k, nm in (("r1", "오늘"), ("r5", "1주"), ("r21", "1개월"), ("r63", "3개월")):
    T = sorted([r for r in R if r[k] is not None], key=lambda r: -float(r[k]))[:15]
    log(f"\n## 전체 TOP 15 · {nm}({k})")
    for i, r in enumerate(T, 1):
        log(f"{i}. {r['mkt']} {r['kind']}{'·'+r['lev'] if r['lev'] else ''} {r['name']}({r['code']}) {float(r[k]):+.2f}% · 거래대금 {float(r['amt'] or 0)/1e8:,.0f}억")
log("\n## 레버리지·인버스 판정 표본")
for r in [r for r in R if r["lev"]][:40]: log(f"- {r['mkt']} {r['lev']} {r['name']} ({r['code']})")
log("\n## 해외 ETF 중 이름에 2X·3X·BULL·BEAR 등이 있는데 판정 없음")
for r in R:
    if r["mkt"] != "KR" and r["kind"] == "ETF" and not r["lev"]: log(f"- {r['code']} {r['name']}")
cur.execute("select pg_size_pretty(pg_database_size(current_database()))"); log(f"\n- DB 용량 {cur.fetchone()[0]}")
open("global_ret_report.md", "w", encoding="utf-8").write("\n".join(L))
