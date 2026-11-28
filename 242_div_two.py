# -*- coding: utf-8 -*-
import os, json, importlib, requests
tok = importlib.import_module("72_kis_token").get_token_cached(); B = "https://openapi.koreainvestment.com:9443"; O = ["# 배당 미수집 종목 점검\n"]
for code, nm in (("049720", "고려신용정보"), ("092130", "이크레더블"), ("003690", "코리안리")):
    r = requests.get(B + "/uapi/domestic-stock/v1/ksdinfo/dividend", params={"CTS": "", "GB1": "0", "F_DT": "20230101", "T_DT": "20271231", "SHT_CD": code, "HIGH_GB": ""}, timeout=20,
        headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": os.environ["KIS_APP_KEY"], "appsecret": os.environ["KIS_APP_SECRET"], "tr_id": "HHKDB669102C0", "custtype": "P"})
    j = r.json(); o = j.get("output1") or []
    O.append(f"## {nm}({code}) rt_cd={j.get('rt_cd')} msg={j.get('msg1')} 행수={len(o)}")
    for x in o[:8]: O.append("- " + json.dumps(x, ensure_ascii=False))
open("div_two.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
