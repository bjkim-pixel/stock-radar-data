# -*- coding: utf-8 -*-
"""종목 상세 실적·예상실적 출처 점검(읽기 전용): KIS 추정실적/재무비율/투자의견 원본 열과 네이버 컨센서스 열, DB 커버리지."""
import os, time, json, importlib, requests, psycopg2
KEY, SEC = os.environ["KIS_APP_KEY"], os.environ["KIS_APP_SECRET"]; tok = importlib.import_module("72_kis_token").get_token_cached()
B = "https://openapi.koreainvestment.com:9443"; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
def kis(path, tr, p):
    time.sleep(0.15)
    r = requests.get(B + path, params=p, timeout=20, headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": "P"})
    return r.json()
NH = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}
S = [("005930", "삼성전자"), ("000660", "SK하이닉스"), ("035420", "NAVER"), ("068270", "셀트리온"), ("192820", "코스맥스")]
for code, nm in S:
    log(f"\n## {nm} {code}")
    j = kis("/uapi/domestic-stock/v1/quotations/estimate-perform", "HHKST668300C0", {"SHT_CD": code})
    log(f"### KIS 추정실적 rt_cd={j.get('rt_cd')} {j.get('msg1','')}")
    if j.get("rt_cd") == "0":
        log("output1: " + json.dumps(j.get("output1"), ensure_ascii=False)[:300])
        log("output4(열): " + str([x.get("dt") for x in j.get("output4") or []]))
        for k in ("output2", "output3"):
            for r in j.get(k) or []: log(f"{k}: " + json.dumps(r, ensure_ascii=False)[:230])
    j = kis("/uapi/domestic-stock/v1/finance/financial-ratio", "FHKST66430300", {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": code, "FID_DIV_CLS_CODE": "1"})
    o = j.get("output") or []
    log(f"### KIS 재무비율(분기) 행 {len(o)} · 필드: {list(o[0].keys()) if o else []}")
    log("최근 3: " + str([(x.get('stac_yymm'), x.get('bps'), x.get('eps')) for x in o[:3]]))
    j = kis("/uapi/domestic-stock/v1/quotations/invest-opinion", "FHKST663300C0", {"FID_COND_MRKT_DIV_CODE": "J", "FID_COND_SCR_DIV_CODE": "16633", "FID_INPUT_ISCD": code, "FID_INPUT_DATE_1": "20260601", "FID_INPUT_DATE_2": "20261127"})
    o = j.get("output") or []
    log(f"### KIS 투자의견 rt_cd={j.get('rt_cd')} 건수 {len(o)} · 필드: {list(o[0].keys()) if o else j.get('msg1')}")
    if o: log("예: " + json.dumps(o[0], ensure_ascii=False)[:300])
    for per in ("annual", "quarter"):
        r = requests.get(f"https://m.stock.naver.com/api/stock/{code}/finance/{per}", headers=NH, timeout=20)
        fi = r.json().get("financeInfo") or {}; cols = fi.get("trTitleList") or []
        log(f"### 네이버 {per}: 열 " + ", ".join(f"{c['key']}{'(E)' if c.get('isConsensus')=='Y' else ''}" for c in cols))
        rows = {x.get("title"): x.get("columns", {}) for x in fi.get("rowList", [])}
        log("행 제목: " + ", ".join(rows))
        for t in ("BPS", "EPS", "매출액"):
            if t in rows: log(f"{t}: " + str([(c['key'], (rows[t].get(c['key']) or {}).get('value')) for c in cols if c.get('isConsensus') == 'Y']))
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor()
log("\n## DB 예상(E) 행 커버리지 (freq, period, src, 종목수, EPS, BPS 있는 수)")
cur.execute("select freq,period,src,count(*),count(eps),count(bps) from stock_earnings where is_est group by 1,2,3 order by 1,2,3")
for r in cur.fetchall(): log(str(r))
cur.execute("select count(*) from stocks where is_active and security_type='STOCK'"); log("대상 종목 수: " + str(cur.fetchone()[0]))
open("est_probe.md", "w", encoding="utf-8").write("\n".join(L))
