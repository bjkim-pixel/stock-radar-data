# -*- coding: utf-8 -*-
"""추정 CIK 후보를 SEC 제출 목록(data.sec.gov)으로 이름 확인(읽기 전용) + 이름 검색(조각) 재시도."""
import os, re, time, requests, urllib.parse
H = {"User-Agent": os.environ.get("SEC_UA") or "StockRadarResearch", "Accept-Encoding": "gzip, deflate"}
O = ["# 추정 CIK 확인\n"]
def sub(cik):
    r = requests.get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", headers=H, timeout=30); time.sleep(0.25)
    if r.status_code != 200: return f"{cik}: HTTP {r.status_code}"
    j = r.json(); rc = j.get("filings", {}).get("recent", {})
    fl = [(f, p) for f, p in zip(rc.get("form", []), rc.get("reportDate", [])) if f.startswith("13F-HR")][:3]
    return f"{cik}: {j.get('name')} · 13F {fl}"
for cik in (1166559, 1647251, 923093, 1082621, 1409252, 1432295, 1067983):
    try: O.append("- " + sub(cik))
    except Exception as e: O.append(f"- {cik}: 실패 {e}")
for q in ("GATES FOUNDATION", "TCI FUND", "TUDOR", "HARVARD MANAGEMENT", "TEMASEK", "SINGAPORE"):
    try:
        r = requests.get("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=" + urllib.parse.quote(q) + "&type=13F&owner=include&count=40", headers=H, timeout=30); time.sleep(0.3)
        rows = re.findall(r'CIK=(\d{10})[^"]*">\d{10}</a></td>\s*<td[^>]*>([^<]+)', r.text) or [(m, "(이름 미추출)") for m in re.findall(r"CIK=(\d{10})", r.text)[:3]]
        O.append(f"## {q}: {len(rows)}건 " + " | ".join(f"{int(c)} {n.strip()}" for c, n in rows[:8]))
    except Exception as e: O.append(f"## {q}: 실패 {e}")
open("f13_guess.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
