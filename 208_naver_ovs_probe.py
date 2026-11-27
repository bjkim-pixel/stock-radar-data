# -*- coding: utf-8 -*-
"""네이버 해외주식 종목개요(회사소개) 제공 여부 점검(읽기 전용)."""
import requests, json
H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
CODES = ["600036.SS", "AAPL.O", "0700.HK", "7203.T", "000001.SZ"]
for code in CODES:
    log(f"\n## {code}")
    for u in (f"https://m.stock.naver.com/api/stock/{code}/overview", f"https://m.stock.naver.com/api/stock/{code}/basic", f"https://m.stock.naver.com/api/stock/{code}/integration",
              f"https://api.stock.naver.com/stock/{code}/overview", f"https://api.stock.naver.com/stock/{code}/basic", f"https://api.stock.naver.com/stock/{code}/integration"):
        try:
            r = requests.get(u, headers=H, timeout=20); t = r.text
            log(f"- {u} → {r.status_code} {len(t)}자")
            if r.status_code == 200:
                try:
                    j = r.json(); log("  키: " + str(list(j.keys()) if isinstance(j, dict) else type(j)))
                    for k, v in (j.items() if isinstance(j, dict) else []):
                        if isinstance(v, str) and len(v) > 60: log(f"  {k}: {v[:300]}")
                        elif k in ("industryCodeType", "stockName", "stockNameEng", "stockEndType", "closePrice"): log(f"  {k}: {v}")
                except Exception: log("  " + t[:200])
        except Exception as e: log(f"- {u} → 오류 {e}")
open("naver_ovs_probe.md", "w", encoding="utf-8").write("\n".join(L))
