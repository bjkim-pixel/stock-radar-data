# -*- coding: utf-8 -*-
"""시가총액 상위 N위(우선주·리츠·스팩·ETF 등 제외) 중 stocks에 없는 종목을 등록하고 상장주식수를 채운다. 신규 코드는 new_codes.txt에 기록."""
import os, re, sys, requests, psycopg2
import kis_flow_common as kis
N = int(os.environ.get("TOP_N", "400"))
H = {"User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Accept": "application/json"}
num = lambda v: float(str(v).replace(",", ""))
rows = []
for mk in ("KOSPI", "KOSDAQ"):
    for pg in range(1, 40):
        j = requests.get(f"https://m.stock.naver.com/api/stocks/marketValue/{mk}?page={pg}&pageSize=100", headers=H, timeout=20).json()
        st = j.get("stocks") or []
        if not st: break
        for x in st:
            try: mv = num(x.get("marketValue"))
            except Exception: continue
            rows.append({"code": (x.get("itemCode") or "").zfill(6), "name": x.get("stockName") or "", "mk": mk, "mv": mv, "type": x.get("stockEndType")})
PREF = re.compile(r"(우[A-C]?|우\(전환\)|[0-9]우[A-C]?)$")
BAD = re.compile(r"리츠|스팩|기업인수목적|REIT|인프라투융자|맥쿼리인프라|ETN|ETF")
def excl(r):
    return (r["type"] != "stock" or PREF.search(r["name"]) or re.match(r"^\d{5}[5-9]$", r["code"]) or re.match(r"^\d{4}[0-9A-Z][KLM]$", r["code"]) or BAD.search(r["name"]))
com = sorted([r for r in rows if not excl(r)], key=lambda r: -r["mv"])
top = com[:N]
print(f"# 시총 상위 {N} (제외 후) · {N}위 = {top[-1]['name']} {top[-1]['mv']:,.0f}억")
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
cur.execute("select code, security_type from stocks")
have = dict(cur.fetchall())
new = [r for r in top if r["code"] not in have]
skip = [r for r in top if have.get(r["code"]) not in (None, "STOCK")]
print(f"- 이미 운영 {sum(1 for r in top if have.get(r['code'])=='STOCK')} · 신규 {len(new)} · 다른 분류로 이미 존재(건너뜀) {len(skip)}: {[r['name'] for r in skip][:10]}")
tok = kis.get_token(warn=print); rate = kis.RateLimiter(15)
done = []
for r in new:
    sh = kis.fetch_listed_shares(tok, r["code"], rate) or 0
    cur.execute("""insert into stocks (code,name,market,security_type,is_active,first_seen,last_seen,listed_shares)
                   values (%s,%s,%s,'STOCK',true,current_date,current_date,%s) on conflict (code) do nothing""", (r["code"], r["name"], r["mk"], sh))
    done.append(r["code"])
conn.commit()
open("new_codes.txt", "w").write("\n".join(done))
print(f"- 등록 {len(done)}종목")
for r in new: print(f"  · {r['name']} ({r['code']}, {r['mk']}) {r['mv']:,.0f}억")
cur.execute("select count(*) from stocks where security_type='STOCK'"); print("- 운영 종목 합계:", cur.fetchone()[0])
