# -*- coding: utf-8 -*-
"""시가총액 순위(네이버 시가총액순 목록, 코스피+코스닥 보통주) → 상위 500위 경계와 현재 운영 종목(daily_price 최신일) 커버리지. 읽기 전용."""
import os, re, requests, psycopg2
H = {"User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Accept": "application/json"}
num = lambda v: float(str(v).replace(",", ""))
rows = []; sample = None
for mk in ("KOSPI", "KOSDAQ"):
    for pg in range(1, 40):
        j = requests.get(f"https://m.stock.naver.com/api/stocks/marketValue/{mk}?page={pg}&pageSize=100", headers=H, timeout=20).json()
        st = j.get("stocks") or []
        if not st: break
        for x in st:
            if sample is None: sample = {k: x.get(k) for k in list(x)[:14]}
            try: mv = num(x.get("marketValue"))
            except Exception: continue
            rows.append({"code": x.get("itemCode"), "name": x.get("stockName"), "mk": mk, "mv": mv, "type": x.get("stockEndType")})
print("# 시가총액 순위\n- 샘플 필드:", sample)
PREF = re.compile(r"(우[A-C]?|우\(전환\)|[0-9]우[A-C]?)$")
def is_pref(r): return bool(PREF.search(r["name"] or "")) or bool(re.match(r"^\d{5}[5-9]$", r["code"] or "")) or bool(re.match(r"^\d{4}[0-9A-Z][KLM]$", r["code"] or ""))
stk = [r for r in rows if r["type"] == "stock"]
com = sorted([r for r in stk if not is_pref(r)], key=lambda r: -r["mv"])
allr = sorted(stk, key=lambda r: -r["mv"])
print(f"- 목록 {len(rows)}건 · 보통주(stockEndType=stock) {len(stk)} · 우선주 제외 {len(com)}")
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.set_session(readonly=True, autocommit=True); cur = conn.cursor()
cur.execute("select p.code, p.market_cap from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' where p.trade_date=(select max(trade_date) from daily_price) and p.close>0")
have = {c: float(m) / 1e8 for c, m in cur.fetchall() if m}
print(f"- 현재 운영 종목 {len(have)}개 · 최소 시총 {min(have.values()):,.0f}억 · 최대 {max(have.values()):,.0f}억")
def table(lst, label, lo, hi):
    print(f"\n## {label} {lo}~{hi}위\n| 순위 | 종목 | 시장 | 시총(억) | 현재 운영 |\n|---|---|---|---|---|")
    for i in range(lo - 1, min(hi, len(lst))): r = lst[i]; print(f"| {i+1} | {r['name']} | {r['mk']} | {r['mv']:,.0f} | {'O' if r['code'] in have else ''} |")
for lst, label in ((com, "우선주 제외"), (allr, "우선주 포함")):
    t = lst[:500]; c500 = t[499]
    inn = sum(1 for r in t if r["code"] in have); kp = sum(1 for r in t if r["mk"] == "KOSPI")
    print(f"\n## {label}: 500위 = {c500['name']} ({c500['code']}, {c500['mk']}) 시총 {c500['mv']:,.0f}억\n- 상위 500 중 코스피 {kp} · 코스닥 {500-kp}\n- 현재 운영 종목이 상위 500에 포함된 수 {inn} → 새로 추가해야 할 종목 {500-inn}개\n- 운영 종목 중 500위 밖 {sum(1 for c in have if c not in {r['code'] for r in t})}개")
    for n in (300, 400, 500, 600, 700): print(f"  · {n}위 {lst[n-1]['name']} {lst[n-1]['mv']:,.0f}억")
table(com, "우선주 제외", 490, 510)
