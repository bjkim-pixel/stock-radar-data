# -*- coding: utf-8 -*-
"""2차: 네이버·SOL·KODEX 구성종목 호출 경로 확인(읽기 전용)."""
import re, json, requests
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept-Language": "ko-KR,ko;q=0.9"}
def get(u, **k):
    try: return requests.get(u, headers=UA, timeout=20, **k)
    except Exception as e: return e
r = get("https://m.stock.naver.com/api/stock/0162L0/integration")
if not isinstance(r, Exception):
    j = r.json(); log("## 네이버 integration 최상위 키: " + ", ".join(j.keys()))
    s = json.dumps(j, ensure_ascii=False)
    log("- etf 관련: " + str([k for k in j.keys() if re.search("etf|pdf|hold|compos", k, re.I)]))
    log("- 앞 700자: " + s[:700])
for u in ["https://m.stock.naver.com/api/etf/0162L0/basic", "https://m.stock.naver.com/api/stock/0162L0/etfAnalysis", "https://m.stock.naver.com/api/etf/0162L0/portfolio", "https://m.stock.naver.com/api/stock/0162L0/basic"]:
    r = get(u); log(f"\n## {u} → " + (str(r) if isinstance(r, Exception) else f"{r.status_code} {len(r.content)}B {r.text[:300]}"))
r = get("https://finance.naver.com/item/main.naver?code=0162L0")
if not isinstance(r, Exception):
    t = r.text; i = t.find("holdings"); log("\n## 네이버 main holdings 주변\n" + re.sub(r"\s+", " ", t[max(0, i-300):i+500]))
for nm, u in [("SOL", "https://www.soletf.com/ko/fund/etf/210897?tabIndex=3"), ("KODEX", "https://www.samsungfund.com/etf/product/view.do?id=2ETFE9")]:
    r = get(u)
    if isinstance(r, Exception): continue
    t = r.text; log(f"\n## {nm} 스크립트 내 호출 경로")
    log(" | ".join(sorted(set(re.findall(r"""["']((?:/ko)?/[A-Za-z0-9_/\-\.]*(?:pdf|Pdf|PDF|portfolio|download|Download|list)[A-Za-z0-9_/\-\.]*)["']""", t)))[:15]))
    i = t.find("pdf-list-more") if nm == "SOL" else t.find("구성종목"); log("- 주변: " + re.sub(r"\s+", " ", t[max(0, i-300):i+700]))
open("etf_brand_probe.md", "w", encoding="utf-8").write("\n".join(L))
