# -*- coding: utf-8 -*-
"""네이버 해외 종목개요 구조 점검(읽기 전용): ownerInfoList·industry 등 원본 + DB 해외 주식 수."""
import os, requests, json, psycopg2
H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor()
cur.execute("select kis_excd,count(*),min(code),max(code) from us_master where not is_etf group by 1 order by 1"); log("해외 주식 수: " + str(cur.fetchall()))
cur.execute("select code from us_master where not is_etf and (code like '%.%' or code ~ '^[0-9]') order by random() limit 12"); log("특수 코드 샘플: " + str([r[0] for r in cur.fetchall()]))
for code in ["600036.SS", "AAPL.O", "0700.HK", "7203.T", "BRK-B.N", "BRK.B.N", "000001.SZ"]:
    r = requests.get(f"https://api.stock.naver.com/stock/{code}/overview", headers=H, timeout=20); log(f"\n## {code} {r.status_code}")
    if r.status_code != 200: continue
    j = r.json()
    for k in ("companyName", "industry", "stockItemListedInfo", "ownerInfoList"): log(f"{k}: " + json.dumps(j.get(k), ensure_ascii=False)[:900])
    log("summaries: " + json.dumps(j.get("summaries"), ensure_ascii=False)[:300]); log("summary 길이: " + str(len(j.get("summary") or "")))
open("naver_ovs_probe.md", "w", encoding="utf-8").write("\n".join(L))
