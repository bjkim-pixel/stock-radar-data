# -*- coding: utf-8 -*-
"""확정 실적 수집 점검(읽기 전용): 3종목의 KIS 손익계산서·재무비율 응답/소요시간과 DB의 2026Q3 행 상태."""
import os, time, json, importlib, requests, psycopg2
KEY, SEC = os.environ["KIS_APP_KEY"], os.environ["KIS_APP_SECRET"]
t0 = time.time(); tok = importlib.import_module("72_kis_token").get_token_cached(); L = []
def log(m=""): print(m, flush=True); L.append(str(m))
log(f"토큰 확보 {time.time()-t0:.1f}s")
B = "https://openapi.koreainvestment.com:9443"
def kis(path, tr, code, div):
    t = time.time()
    try:
        r = requests.get(B + path, params={"fid_cond_mrkt_div_code": "J", "fid_input_iscd": code, "FID_DIV_CLS_CODE": div}, timeout=20,
            headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": "P"})
        txt = r.text; j = r.json()
        return j, f"HTTP {r.status_code} {time.time()-t:.1f}s rt_cd={j.get('rt_cd')} msg={j.get('msg1')}"
    except Exception as e:
        return {}, f"예외 {type(e).__name__} {time.time()-t:.1f}s 본문앞={txt[:80] if 'txt' in dir() else ''}"
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor()
for code, nm in [("005930", "삼성전자"), ("000660", "SK하이닉스"), ("009150", "삼성전기")]:
    log(f"\n## {nm} {code}")
    for lab, path, tr, div in [("손익계산서 연", "/uapi/domestic-stock/v1/finance/income-statement", "FHKST66430200", "0"),
                               ("재무비율 연", "/uapi/domestic-stock/v1/finance/financial-ratio", "FHKST66430300", "0"),
                               ("손익계산서 분기", "/uapi/domestic-stock/v1/finance/income-statement", "FHKST66430200", "1"),
                               ("재무비율 분기", "/uapi/domestic-stock/v1/finance/financial-ratio", "FHKST66430300", "1")]:
        j, info = kis(path, tr, code, div); o = j.get("output") or []
        log(f"- {lab}: {info} · {len(o)}행")
        for r in o[:4]:
            keep = {k: r[k] for k in ("stac_yymm", "sale_account", "bsop_prti", "thtr_ntin", "eps", "bps", "roe_val") if k in r}
            log("    " + json.dumps(keep, ensure_ascii=False))
        time.sleep(0.5)
    cur.execute("select freq,period,is_est,src,sales,op_profit,net_income,eps,bps,updated_at from stock_earnings where code=%s and period>='202506' order by freq,period", (code,))
    log("DB 행(2025.6 이후):")
    for r in cur.fetchall(): log("    " + str(r))
log(f"\n총 {time.time()-t0:.0f}s")
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L))
