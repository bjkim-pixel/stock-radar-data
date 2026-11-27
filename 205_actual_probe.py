# -*- coding: utf-8 -*-
"""확정 실적 API 파라미터 변형 점검(읽기 전용): 삼성전자 한 종목으로 대·소문자 등 조합을 시도."""
import os, time, json, importlib, requests
KEY, SEC = os.environ["KIS_APP_KEY"], os.environ["KIS_APP_SECRET"]; tok = importlib.import_module("72_kis_token").get_token_cached(); L = []
def log(m=""): print(m, flush=True); L.append(str(m))
B = "https://openapi.koreainvestment.com:9443"
def call(path, tr, p, cust="P"):
    time.sleep(0.6)
    r = requests.get(B + path, params=p, timeout=20, headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": cust})
    try: j = r.json()
    except Exception: return f"HTTP {r.status_code} 본문 JSON 아님: {r.text[:100]!r}"
    o = j.get("output"); n = len(o) if isinstance(o, list) else (1 if o else 0)
    first = json.dumps(o[0], ensure_ascii=False)[:260] if isinstance(o, list) and o else ""
    return f"HTTP {r.status_code} rt_cd={j.get('rt_cd')} {j.get('msg_cd')} {j.get('msg1')} · {n}행 {first}"
P = {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": "005930", "FID_DIV_CLS_CODE": "1"}
for nm, path, tr in [("대차대조표", "balance-sheet", "FHKST66430100"), ("손익계산서", "income-statement", "FHKST66430200"), ("재무비율", "financial-ratio", "FHKST66430300"),
                     ("수익성비율", "profit-ratio", "FHKST66430400"), ("기타주요비율", "other-major-ratios", "FHKST66430500"), ("안정성비율", "stability-ratio", "FHKST66430600"), ("성장성비율", "growth-ratio", "FHKST66430800")]:
    log(f"- {nm}: " + call("/uapi/domestic-stock/v1/finance/" + path, tr, P))
log("- (대조) 현재가: " + call("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": "005930"})[:120])
log("- (대조) 종목기본정보: " + call("/uapi/domestic-stock/v1/quotations/search-stock-info", "CTPF1002R", {"PRDT_TYPE_CD": "300", "PDNO": "005930"})[:120])
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L))
