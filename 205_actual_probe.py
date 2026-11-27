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
V = {"소문자(현재 코드)": {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": "005930", "FID_DIV_CLS_CODE": "1"},
     "대문자": {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": "005930", "FID_DIV_CLS_CODE": "1"},
     "소문자+소문자div": {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": "005930", "fid_div_cls_code": "1"}}
for nm, path, tr in [("손익계산서", "/uapi/domestic-stock/v1/finance/income-statement", "FHKST66430200"), ("재무비율", "/uapi/domestic-stock/v1/finance/financial-ratio", "FHKST66430300")]:
    for vn, p in V.items(): log(f"- {nm} / {vn}: " + call(path, tr, p))
log("- 참고(대차대조표): " + call("/uapi/domestic-stock/v1/finance/balance-sheet", "FHKST66430100", V["대문자"]))
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L))
