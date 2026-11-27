# -*- coding: utf-8 -*-
"""해외 주식(ETF 제외)의 한글 회사 소개·업종·주주 구성을 네이버 증권(api.stock.naver.com/stock/{코드}/overview)에서 받아 us_master.profile 에 저장.
사용법: python 209_ovs_profile.py [종목코드,쉼표]   (비우면 전체)"""
import os, sys, re, time, json, requests, psycopg2
H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True; cur = c.cursor()
cur.execute("alter table us_master add column if not exists profile jsonb")
ONLY = [x for x in (sys.argv[1] if len(sys.argv) > 1 else "").replace(" ", "").split(",") if x]
cur.execute("select code,kis_excd from us_master where not is_etf order by code")
ST = [r for r in cur.fetchall() if not ONLY or r[0] in ONLY]
SUF = {"NAS": [".O", ".N", ".A"], "NYS": [".N", ".A", ".O"], "AMS": [".A", ".N", ".O"]}
def cands(code, ex):
    if ex in SUF:
        b = [code] + ([code.replace(".", "-"), code.replace(".", "").replace("B", "b")] if "." in code else [])
        return [x + s for x in dict.fromkeys(b) for s in SUF[ex]]
    return [code]
def get(path):
    for k in range(3):
        time.sleep(0.25)
        try:
            r = requests.get(f"https://api.stock.naver.com/stock/{path}/overview", headers=H, timeout=20)
            if r.status_code == 200: return r.json()
            if r.status_code in (400, 404, 409): return None
        except Exception: time.sleep(1.5)
    return None
ok = 0; fail = []; nos = 0
for code, ex in ST:
    j = None
    for nc in cands(code, ex):
        j = get(nc)
        if j and (j.get("summary") or j.get("ownerInfoList")): break
    if not j: fail.append(code); continue
    summ = re.sub(r"<br\s*/?>", "\n", (j.get("summary") or "")).strip(); summ = re.sub(r"\n{3,}", "\n\n", summ)
    owners = [{"n": o.get("investorName"), "sh": o.get("position"), "p": o.get("outstanding")} for o in (j.get("ownerInfoList") or []) if o.get("investorName")]
    li = j.get("stockItemListedInfo") or {}
    prof = {"summary": summ, "industry": (j.get("industry") or {}).get("industryGroupKor"), "name_ko": j.get("companyName"), "owners": owners,
            "listed_at": (li.get("listedAt") or "")[:10], "acct_date": li.get("accountDate"), "src": "naver", "fetched": time.strftime("%Y-%m-%d")}
    cur.execute("update us_master set profile=%s where code=%s", (json.dumps(prof, ensure_ascii=False), code)); ok += 1
    if not summ: nos += 1
log(f"# 해외 주식 소개·주주 수집 · 대상 {len(ST)} · 저장 {ok} (소개문 없음 {nos}) · 실패 {len(fail)}")
log("실패: " + str(fail))
open("ovs_profile.md", "w", encoding="utf-8").write("\n".join(L))
