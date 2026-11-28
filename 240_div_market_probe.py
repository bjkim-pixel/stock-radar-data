# -*- coding: utf-8 -*-
"""KIS 예탁원 배당일정을 종목코드 없이(전체 시장) 조회할 수 있는지, 페이지 넘김 방식은 무엇인지 점검(읽기 전용)."""
import os, json, importlib, requests
tok = importlib.import_module("72_kis_token").get_token_cached()
B = "https://openapi.koreainvestment.com:9443"; O = ["# 전체 시장 배당 조회 점검\n"]
def call(params, tr="", ):
    h = {"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": os.environ["KIS_APP_KEY"], "appsecret": os.environ["KIS_APP_SECRET"], "tr_id": "HHKDB669102C0", "custtype": "P"}
    if tr: h["tr_cont"] = tr
    r = requests.get(B + "/uapi/domestic-stock/v1/ksdinfo/dividend", params=params, headers=h, timeout=30)
    return r, r.json()
P = {"CTS": "", "GB1": "0", "F_DT": "20260601", "T_DT": "20260630", "SHT_CD": "", "HIGH_GB": ""}
r, j = call(P)
O.append(f"- 응답 키: {list(j.keys())} · rt_cd={j.get('rt_cd')} msg={j.get('msg1')}")
O.append(f"- 응답 헤더 tr_cont={r.headers.get('tr_cont')!r}")
o = j.get("output1") or []
O.append(f"- output1 행수 {len(o)}; 첫 행: {json.dumps(o[0], ensure_ascii=False) if o else None}")
O.append(f"- 그 외 필드: {json.dumps({k: v for k, v in j.items() if k not in ('output1',)}, ensure_ascii=False)[:600]}")
# 페이지 넘김 시도: tr_cont=N + 같은 파라미터(+ CTS 가 응답에 있으면 사용)
tot = len(o); seen = {json.dumps(x, sort_keys=True) for x in o}; pages = 1; cts = j.get("ctx_area_nk") or j.get("cts") or ""
tr = r.headers.get("tr_cont")
while tr in ("M", "F") and pages < 40:
    P2 = dict(P); P2["CTS"] = cts
    r, j = call(P2, "N"); o = j.get("output1") or []; pages += 1
    new = [x for x in o if json.dumps(x, sort_keys=True) not in seen]
    for x in o: seen.add(json.dumps(x, sort_keys=True))
    tot += len(new); tr = r.headers.get("tr_cont"); cts = j.get("ctx_area_nk") or j.get("cts") or cts
    if not new: break
O.append(f"- 페이지 {pages}번 호출, 중복 제외 총 {len(seen)}행 (2026-06 한 달)")
codes = {json.loads(x).get("sht_cd") for x in seen}
O.append(f"- 서로 다른 종목 {len(codes)}개; 우선주 표시값 예: {sorted({json.loads(x).get('stk_kind') for x in seen})}")
open("div_market_probe.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
