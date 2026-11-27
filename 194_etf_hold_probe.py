# -*- coding: utf-8 -*-
"""중국 ETF 2개 구성종목 수집 가능성 2차 점검(읽기 전용): TIME 페이지 구조, TIGER 대체 출처."""
import re, requests
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
def get(u):
    try: r = requests.get(u, headers=UA, timeout=25); return r.status_code, r.text
    except Exception as e: return 0, str(e)
log("# 2차 점검")
s, t = get("https://www.timeetf.co.kr/m11_view.php?idx=19")
log(f"## TIME 차이나AI테크액티브 페이지 {s} {len(t)}자")
i = t.find("EQUITY")
log("- 첫 EQUITY 주변 원문(HTML):\n```\n" + t[max(0, i-700):i+900] + "\n```")
log(f"- EQUITY 행 수: {len(re.findall('EQUITY', t))}, INDEX/FUT: {len(re.findall(r'INDEX', t))}")
log("- '더보기'/pdf 스크립트: " + " | ".join(re.findall(r"[^\n]{0,80}(?:더보기|pdfM1|ajax|\.php\?)[^\n]{0,120}", t)[:8]))
for nm, u in [("stockhub 로봇 portfolio", "https://stockhub.kr/etf/0053L0/portfolio"), ("stockhub 로봇", "https://stockhub.kr/etf/0053L0")]:
    s, t = get(u)
    log(f"\n## {nm} → {s} {len(t)}자")
    j = t.find("텐센트")
    log("- 텐센트 주변: " + re.sub(r"\s+", " ", t[max(0, j-300):j+500]) if j >= 0 else "- 텐센트 없음 / 첫 800자: " + re.sub(r"\s+", " ", t[:800]))
    log("- 링크: " + ", ".join(sorted(set(re.findall(r"""["'](/[a-z0-9/_\-]*portfolio[^"']*)""", t)))[:6]))
open("etf_hold_probe.md", "w", encoding="utf-8").write("\n".join(L))
