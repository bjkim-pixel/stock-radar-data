# -*- coding: utf-8 -*-
"""영국·독일 종목 데이터 소스 점검(읽기 전용): KIS 해외 조회 가능 여부 + 네이버 월드스톡 코드·일봉."""
import os, time, json, importlib, requests
KEY, SEC = os.environ["KIS_APP_KEY"], os.environ["KIS_APP_SECRET"]; tok = importlib.import_module("72_kis_token").get_token_cached()
B = "https://openapi.koreainvestment.com:9443"; H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
def kis(path, tr, p):
    time.sleep(0.5)
    try: return requests.get(B + path, params=p, timeout=20, headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": "P"}).json()
    except Exception as e: return {"rt_cd": "x", "msg1": str(e)}
log("## KIS 해외 현재가상세 — 거래소 코드 시험")
for ex, sym in [("LSE", "AZN"), ("LON", "AZN"), ("UK", "AZN"), ("XET", "SAP"), ("GER", "SAP"), ("FRA", "SAP"), ("TSE", "7203")]:
    j = kis("/uapi/overseas-price/v1/quotations/price-detail", "HHDFS76200200", {"AUTH": "", "EXCD": ex, "SYMB": sym}); o = j.get("output") or {}
    log(f"- {ex} {sym}: rt_cd={j.get('rt_cd')} {j.get('msg1','')} last={o.get('last') if isinstance(o,dict) else ''}")
log("\n## 네이버 — 코드 후보")
def nv(path):
    try:
        r = requests.get("https://api.stock.naver.com" + path, headers=H, timeout=20); return r.status_code, r
    except Exception as e: return 0, None
for c in ["AZN.L", "AZN", "HSBA.L", "BP.L", "BP..L", "SAP.DE", "SAPG.DE", "SIE.DE", "SIEGn.DE", "ALV.DE", "ALVG.DE", "MUV2.DE", "MUVGn.DE", "RHM.DE", "RHMG.DE"]:
    st, r = nv(f"/stock/{c}/basic")
    log(f"- {c}: basic {st}" + (f" {r.json().get('stockName')} | {r.json().get('stockExchangeName')} | cur={r.json().get('closePrice')} | ex={(r.json().get('stockExchangeType') or {}).get('code')}" if st == 200 else ""))
for q in ["AZN", "SAP", "HSBA", "아스트라제네카", "지멘스"]:
    try:
        r = requests.get("https://ac.stock.naver.com/ac", params={"q": q, "target": "stock,index,marketindicator,worldstock"}, headers=H, timeout=20)
        log(f"- 자동완성 {q}: {r.status_code} {r.text[:600]}")
    except Exception as e: log(f"- 자동완성 {q}: 오류 {e}")
log("\n## 네이버 일봉 후보")
for u in ["/chart/foreign/item/AZN.L?periodType=dayCandle&range=10", "/chart/foreign/item/AAPL.O?periodType=dayCandle&range=10",
          "/chart/foreign/item/AAPL.O/day?startDateTime=20261101&endDateTime=20261127", "/chart/foreign/item/AAPL.O?periodType=dayCandle&startDateTime=20261101&endDateTime=20261127"]:
    st, r = nv(u); log(f"- {u} → {st} {(r.text[:300] if r is not None else '')}")
open("euro_probe.md", "w", encoding="utf-8").write("\n".join(L))
