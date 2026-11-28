# -*- coding: utf-8 -*-
"""우리 DB(us_master)에 없는 13F 보유종목을 해외종목으로 등록(us_top_asia 에 추가). 기본은 미리보기, --apply 면 등록.
기준(최신 분기): 집중형 비중 0.5%↑ 또는 신규 편입 / 중간형 비중 1%↑ 또는 신규 편입(0.5%↑) / 분산·퀀트형 제외."""
import os, sys, re, psycopg2
APPLY = "--apply" in sys.argv; MAXN = int(os.environ.get("MAXN") or 600)
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("select code from us_master"); have = {r[0] for r in cur.fetchall()}
cur.execute("select cik,style,last_period from f13_fund"); fu = cur.fetchall()
cand = {}
for cik, style, per in fu:
    if style == "분산·퀀트": continue
    cur.execute("""select h.ticker, h.name, h.pct, coalesce(v.act,'') from f13_holding h
      left join v_f13_change v on v.cik=h.cik and v.period=h.period and v.cusip=h.cusip
      where h.cik=%s and h.period=%s and h.put_call='' and h.ticker is not null""", (cik, per))
    for t, nm, pct, act in cur.fetchall():
        pct = float(pct or 0)
        ok = (pct >= 0.5 or act == "new") if style == "집중" else (pct >= 1.0 or (act == "new" and pct >= 0.5))
        if not ok or t in have or not re.fullmatch(r"[A-Z]{1,5}(\.[AB])?", t): continue
        c = cand.setdefault(t, [nm, 0.0, 0]); c[1] = max(c[1], pct); c[2] += 1
rank = sorted(cand.items(), key=lambda x: (-x[1][2], -x[1][1]))
log(f"# 13F 보유종목 중 우리 DB에 없는 종목 {len(rank)}개 (상한 {MAXN})")
log("- 상위 30: " + ", ".join(f"{t}({v[0][:18]}, {v[2]}곳)" for t, v in rank[:30]))
if APPLY:
    cur.execute("""create table if not exists public.us_top_asia(code text primary key, excd text not null, sym text not null, rnk int,
        mkt_cap numeric, name_ko text, updated_at timestamptz not null default now())""")
    cur.execute("select coalesce(max(rnk),0) from us_top_asia"); base = cur.fetchone()[0]
    for i, (t, v) in enumerate(rank[:MAXN], 1):
        cur.execute("insert into us_top_asia(code,excd,sym,rnk,name_ko) values(%s,'NAS',%s,%s,%s) on conflict(code) do nothing", (t, t.replace(".", "/"), base + i, v[0].title()))
    log(f"- us_top_asia 에 {min(len(rank), MAXN)}개 추가(이미 있으면 건너뜀)")
open("f13_register_report.md", "w", encoding="utf-8").write("\n".join(L))
