# -*- coding: utf-8 -*-
"""해외주식 종목소개/기본정보 제공 여부 점검(읽기 전용): 상품기본정보(CTPF1702R)·현재가상세(HHDFS76200200) 응답 필드 전체."""
import os, time, json, importlib, requests
KEY, SEC = os.environ["KIS_APP_KEY"], os.environ["KIS_APP_SECRET"]; tok = importlib.import_module("72_kis_token").get_token_cached()
B = "https://openapi.koreainvestment.com:9443"; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
def kis(path, tr, p):
    for _ in range(3):
        time.sleep(0.6)
        try:
            r = requests.get(B + path, params=p, timeout=20, headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": "P"})
            return r.json()
        except Exception: time.sleep(2)
    return {"rt_cd": "x", "msg1": "응답 없음/JSON 아님"}
S = [("AAPL", "512", "NAS", "애플"), ("TSLA", "512", "NAS", "테슬라"), ("00700", "501", "HKS", "텐센트(홍콩)"), ("7203", "515", "TSE", "도요타(일본)"), ("600519", "551", "SHS", "마오타이(상해)")]
for pdno, ty, ex, nm in S:
    log(f"\n## {nm} {pdno}")
    j = kis("/uapi/overseas-price/v1/quotations/search-info", "CTPF1702R", {"PRDT_TYPE_CD": ty, "PDNO": pdno})
    log(f"### 상품기본정보 rt_cd={j.get('rt_cd')} {j.get('msg1','')}")
    o = j.get("output")
    if isinstance(o, dict):
        for k, v in o.items(): log(f"  {k} = {str(v)[:120]}")
    j = kis("/uapi/overseas-price/v1/quotations/price-detail", "HHDFS76200200", {"AUTH": "", "EXCD": ex, "SYMB": pdno})
    log(f"### 현재가상세 rt_cd={j.get('rt_cd')} {j.get('msg1','')}")
    o = j.get("output")
    if isinstance(o, dict):
        log("  필드: " + ", ".join(f"{k}={str(v)[:20]}" for k, v in o.items()))
open("ovs_info_probe.md", "w", encoding="utf-8").write("\n".join(L))
