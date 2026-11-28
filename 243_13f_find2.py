# -*- coding: utf-8 -*-
"""추가 후보 7곳의 13F 제출 CIK 탐색(읽기 전용): EDGAR 기업 검색 HTML 표에서 (CIK, 이름) 쌍을 정확히 추출 + 최신 13F-HR 기준일."""
import os, re, time, json, requests, urllib.parse
H = {"User-Agent": os.environ.get("SEC_UA") or "StockRadarResearch", "Accept-Encoding": "gzip, deflate"}
Q = ["Situational Awareness", "Gates Foundation Trust", "TCI Fund Management", "Tudor Investment", "Harvard Management", "Temasek Holdings", "Government of Singapore Investment"]
O = ["# 13F 후보 CIK 탐색\n"]
for q in Q:
    try:
        r = requests.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=" + urllib.parse.quote(q) + "&type=13F-HR&owner=include&count=40", headers=H, timeout=30); time.sleep(0.3)
        rows = re.findall(r'CIK=(\d{10})[^"]*">\d{10}</a></td>\s*<td[^>]*>([^<]+)', r.text)
        O.append(f"## {q} (HTTP {r.status_code}, {len(rows)}건)")
        for cik, nm in rows[:8]:
            j = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=H, timeout=30); time.sleep(0.2)
            fl = []
            if j.status_code == 200:
                rc = j.json().get("filings", {}).get("recent", {})
                fl = [(f, p) for f, p in zip(rc.get("form", []), rc.get("reportDate", [])) if f == "13F-HR"][:2]
            O.append(f"- {int(cik)} · {nm.strip()} · 최근 13F-HR {fl}")
    except Exception as e: O.append(f"- {q}: 실패 {type(e).__name__} {str(e)[:100]}")
open("f13_find2.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
