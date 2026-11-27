# -*- coding: utf-8 -*-
"""운용사별 ETF 구성종목(PDF) 출처 샘플 점검(읽기 전용)."""
import re, requests
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept-Language": "ko-KR,ko;q=0.9"}
def get(u, **k):
    try: r = requests.get(u, headers=UA, timeout=25, **k); return r
    except Exception as e: return e
S = [
 ("RISE 중국본토대형주CSI100", "https://www.riseetf.co.kr/prod/finderDetail/4437"),
 ("RISE 중국본토대형주CSI100(영문)", "https://eng.riseetf.co.kr/prod/finderDetail/4437"),
 ("SOL 차이나육성산업액티브 tab3", "https://www.soletf.com/ko/fund/etf/210897?tabIndex=3"),
 ("SOL 차이나육성산업액티브 summary", "https://www.soletf.com/ko/fund/etf/summary/210897"),
 ("PLUS 일본반도체소부장 pdf", "https://www.plusetf.co.kr/upload/fund/PLUS_일본반도체소부장_20260831.pdf"),
 ("PLUS 상세", "https://www.plusetf.co.kr/product/detail?n=006366"),
 ("KODEX 신탁 pdf(샘플)", "https://m.samsungfund.com/sheet/20250805/2ETFE9_20250731.pdf"),
 ("KODEX 사이트", "https://www.samsungfund.com/etf/product/view.do?id=2ETFE9"),
 ("funetf 0162L0", "https://www.funetf.co.kr/product/etf/view/KR70162L0003"),
 ("etfshopping 174360", "https://etfshopping.com/etf/174360"),
 ("네이버 모바일 ETF", "https://m.stock.naver.com/api/stock/0162L0/integration"),
 ("네이버 ETF 구성", "https://finance.naver.com/item/main.naver?code=0162L0"),
]
for nm, u in S:
    r = get(u)
    if isinstance(r, Exception): log(f"\n## {nm}\n- 오류 {r}"); continue
    t = r.text if "pdf" not in r.headers.get("content-type", "") else "(pdf %d bytes)" % len(r.content)
    log(f"\n## {nm}\n- {u}\n- HTTP {r.status_code}, {len(r.content)} bytes, {r.headers.get('content-type','')}")
    hits = {k: len(re.findall(k, t)) for k in ["구성종목", "PDF", "비중", "EQUITY", "Tencent", "텐센트", "다운로드", "xlsx", "excel"]}
    log("- 키워드: " + str({k: v for k, v in hits.items() if v}))
    m = re.findall(r"""["']([^"']*(?:pdf|excel|xls|portfolio|holding|download)[^"']*)["']""", t, re.I)
    if m: log("- 후보 링크: " + " | ".join(sorted(set(m))[:8]))
    if r.status_code == 200 and "pdf" in r.headers.get("content-type", ""):
        open("/tmp/x.pdf", "wb").write(r.content)
        try:
            import subprocess; o = subprocess.run(["pdftotext", "-layout", "/tmp/x.pdf", "-"], capture_output=True, text=True).stdout
            log("- PDF 텍스트 앞부분:\n```\n" + o[:1500] + "\n```")
        except Exception as e: log(f"- pdftotext 실패 {e}")
open("etf_brand_probe.md", "w", encoding="utf-8").write("\n".join(L))
