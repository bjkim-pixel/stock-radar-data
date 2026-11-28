# -*- coding: utf-8 -*-
"""13F CUSIP → 미국 티커 매핑(OpenFIGI 무료 API) → f13_cusip 캐시 → f13_holding.ticker 채우기.
대상: 집중·중간형 펀드의 전 종목 + 분산·퀀트형은 비중 0.05% 이상. OPENFIGI_KEY 가 있으면 더 빠르게 호출."""
import os, re, sys, time, json, requests, psycopg2
from psycopg2.extras import execute_values
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
KEY = os.environ.get("OPENFIGI_KEY") or ""
HDR = {"Content-Type": "application/json"}
if KEY: HDR["X-OPENFIGI-APIKEY"] = KEY
BATCH = 100 if KEY else 10; PAUSE = 0.7 if KEY else 2.6
def figi(cs):
    for i in range(4):
        try:
            r = requests.post("https://api.openfigi.com/v3/mapping", headers=HDR, timeout=40,
                              data=json.dumps([{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in cs]))
        except Exception as e:
            time.sleep(5); continue
        if r.status_code == 429: time.sleep(30 + i * 15); continue
        if r.status_code >= 500: time.sleep(15 + i * 15); continue
        if r.status_code != 200: log(f"  OpenFIGI HTTP {r.status_code} {r.text[:80]}"); return None
        return r.json()
    return None
def main():
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
    cur.execute("""select h.cusip, max(h.name), max(h.pct) from f13_holding h join f13_fund f on f.cik=h.cik
      where h.put_call='' and not exists (select 1 from f13_cusip c where c.cusip=h.cusip)
        and (f.style<>'분산·퀀트' or h.pct>=0.05) group by h.cusip order by max(h.pct) desc nulls last""")
    todo = cur.fetchall(); log(f"# CUSIP 매핑 대상 {len(todo)}개")
    ok = miss = 0; t0 = time.time()
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]; res = figi([c for c, _, _ in chunk])
        if res is None:
            fails = globals().get("_fails", 0) + 1; globals()["_fails"] = fails
            if fails >= 5: log("- OpenFIGI 응답 없음 5회 연속 — 중단(다음 실행에서 이어서)"); break
            continue
        globals()["_fails"] = 0
        rows = []
        for (c, nm, _), r in zip(chunk, res):
            d = (r.get("data") or [None])[0] if isinstance(r, dict) else None
            if d and d.get("ticker"):
                rows.append((c, d["ticker"].replace("/", "."), d.get("name") or nm, d.get("securityType2") or d.get("securityType"), "openfigi")); ok += 1
            else:
                rows.append((c, None, nm, None, "openfigi")); miss += 1
        execute_values(cur, """insert into f13_cusip(cusip,ticker,name,sec_type,src) values %s
          on conflict(cusip) do update set ticker=excluded.ticker,name=excluded.name,sec_type=excluded.sec_type,src=excluded.src,tried_at=now()""", rows)
        time.sleep(PAUSE)
        if time.time() - t0 > 80 * 60: log("- 시간 제한 — 중단(다음 실행에서 이어서)"); break
    cur.execute("update f13_holding h set ticker=c.ticker from f13_cusip c where h.cusip=c.cusip and h.ticker is distinct from c.ticker")
    log(f"- 매핑 성공 {ok} · 실패 {miss} · 소요 {time.time()-t0:.0f}초")
    cur.execute("select count(*) from f13_cusip where ticker is not null"); log(f"- f13_cusip 매핑됨 {cur.fetchone()[0]}개")
    cur.execute("select count(*) filter (where ticker is not null), count(*) from f13_holding h join f13_fund f on f.cik=h.cik and f.last_period=h.period where put_call=''"); a = cur.fetchone()
    log(f"- 최신 분기 보유행 중 티커 연결 {a[0]}/{a[1]}")
    open("f13_cusip_report.md", "w", encoding="utf-8").write("\n".join(L))
if __name__ == "__main__": main()
