# -*- coding: utf-8 -*-
"""글로벌 시황(미국 탭)·국내 ETF 보유종목 중 해외 종목이 우리 DB(us_master)에 저장돼 있는지 점검(읽기 전용)."""
import os, re, json, psycopg2, importlib.util
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
spec = importlib.util.spec_from_file_location("uc", "176_us_collect.py"); 
src = open("176_us_collect.py", encoding="utf-8").read()
ns = {"re": re}; exec(src[src.index("def candidates(code):"):src.index("def detail(ex, sym):")], ns); candidates = ns["candidates"]
cur.execute("select code,kis_excd,is_etf,name_ko from us_master"); M = {r[0]: r[1:] for r in cur.fetchall()}
log(f"# 해외 종목 저장 현황 — us_master {len(M)}개")
cur.execute("select payload from global_pack where tab='US'"); P = cur.fetchone()[0]
if isinstance(P, str): P = json.loads(P)
etf, hold = [], {}
for g in P.get("groups", []):
    for k in g["keys"]:
        t = k.split(":", 1)[1]
        if t.startswith("^") or t.startswith("RATIO"): continue
        if t not in etf: etf.append(t)
        for x in (P["items"].get(k) or {}).get("h") or []:
            hold.setdefault(x["c"], x.get("n") or x.get("name") or "")
allc = etf + [c for c in hold if c not in etf]
log(f"\n## A. 글로벌 시황 미국 탭: ETF {len(etf)}개 + 보유종목 {len([c for c in hold if c not in etf])}개")
miss = [c for c in allc if c not in M]
log(f"- 저장됨 {len(allc)-len(miss)} / 미저장 {len(miss)}")
by = {}
for c in miss:
    why = "한국 종목(기존 한국 상세)" if re.fullmatch(r"\d{6}|.+\.(KS|KQ)", c) else ("KIS 미지원 거래소" if not candidates(c) else "KIS 조회 실패(심볼 불일치 등)")
    by.setdefault(why, []).append(c + (f"({hold[c]})" if hold.get(c) else ""))
for k, v in by.items(): log(f"- **{k}** {len(v)}개: " + ", ".join(v))
ex = {}
for c in allc:
    if c in M: ex[M[c][0]] = ex.get(M[c][0], 0) + 1
log("- 저장된 종목 거래소별: " + ", ".join(f"{k} {v}" for k, v in sorted(ex.items())))
log("\n## B. 국내 ETF 보유종목(etf_holdings_now)")
cur.execute("select count(*), count(distinct etf_code), count(distinct stock_code) from etf_holdings_now"); log(f"- 전체 행/ETF/종목코드: {cur.fetchone()}")
cur.execute("select stock_code, max(stock_name), count(*), sum(weight) from etf_holdings_now where stock_code !~ '^[0-9A-Z]{6}$' or stock_code ~ '[^0-9A-Za-z]' group by 1 order by 3 desc limit 40")
rows = cur.fetchall(); log(f"- 6자리 국내 코드가 아닌 항목 상위 {len(rows)}개:")
for r in rows: log(f"  - {r[0]} | {r[1]} | {r[2]}개 ETF | 비중합 {r[3]}")
cur.execute("select count(distinct stock_code) from etf_holdings_now where stock_code !~ '^[0-9A-Z]{6}$'"); log(f"- 비국내 형식 코드 개수: {cur.fetchone()[0]}")
cur.execute("select stock_code, stock_name from etf_holdings_now where etf_code in ('241180','283580','371160','371460','414780','101280','099140') order by etf_code, rank limit 60")
log("- 일본·중국 ETF 보유종목 샘플(코드 | 이름):")
for r in cur.fetchall(): log(f"  - {r[0]} | {r[1]}")
open("foreign_cover.md", "w", encoding="utf-8").write("\n".join(L))
