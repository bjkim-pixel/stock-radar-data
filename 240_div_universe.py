# -*- coding: utf-8 -*-
"""고배당 후보 발굴: 네이버 시총 목록(코스피·코스닥 전체, 우선주 포함)에서 우리 DB에 없는 종목의 최근 12개월 배당(KIS 예탁원)을 종목별로 조회해
배당수익률(최근 12개월 주당배당 ÷ 네이버 현재가)을 계산. 기본은 보고만(dry), --apply 면 DIV_MIN(기본 3)% 이상을 stocks 에 등록(STOCK)하고 new_codes.txt 기록.
제외: ETF·ETN(네이버 구분), 스팩, 리츠·인프라펀드, 6자리 숫자가 아닌 코드."""
import os, re, sys, time, datetime as dt, importlib, requests, psycopg2
import kis_flow_common as kis
APPLY = "--apply" in sys.argv; DIV_MIN = float(os.environ.get("DIV_MIN") or 3)
H = {"User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Accept": "application/json"}
num = lambda v: float(str(v).replace(",", ""))
rows = []; keys = None
for mk in ("KOSPI", "KOSDAQ"):
    for pg in range(1, 60):
        j = requests.get(f"https://m.stock.naver.com/api/stocks/marketValue/{mk}?page={pg}&pageSize=100", headers=H, timeout=20).json()
        st = j.get("stocks") or []
        if not st: break
        for x in st:
            keys = keys or list(x.keys())
            try: px = num(x.get("closePrice"))
            except Exception: px = 0
            rows.append({"code": (x.get("itemCode") or "").zfill(6), "name": x.get("stockName") or "", "mk": mk, "px": px, "type": x.get("stockEndType")})
BAD = re.compile(r"스팩|기업인수목적|리츠|REIT|인프라투융자|맥쿼리인프라|ETN|ETF")
uni = [r for r in rows if r["type"] == "stock" and re.fullmatch(r"\d{6}", r["code"]) and not BAD.search(r["name"]) and r["px"] > 0]
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
cur.execute("select code,security_type from stocks"); have = dict(cur.fetchall())
cand = [r for r in uni if have.get(r["code"]) != "STOCK"]
O = ["# 고배당 후보 발굴 (우리 DB에 없는 종목)\n", f"- 네이버 목록 {len(rows)}개(응답 키: {keys}) → 보통·우선주 대상 {len(uni)}개 · 우리 운영 종목 제외 후 조회 대상 {len(cand)}개"]
tok = importlib.import_module("72_kis_token").get_token_cached()
B = "https://openapi.koreainvestment.com:9443"; today = dt.date.today()
def d8(s):
    s = (s or "").replace("/", "").replace("-", "").strip()
    return dt.datetime.strptime(s, "%Y%m%d").date() if len(s) == 8 and s.isdigit() else None
def fetch(code):
    time.sleep(0.12)
    for _ in range(3):
        try:
            r = requests.get(B + "/uapi/domestic-stock/v1/ksdinfo/dividend", params={"CTS": "", "GB1": "0", "F_DT": f"{today.year-3}0101", "T_DT": f"{today.year+1}1231", "SHT_CD": code, "HIGH_GB": ""}, timeout=20,
                headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": os.environ["KIS_APP_KEY"], "appsecret": os.environ["KIS_APP_SECRET"], "tr_id": "HHKDB669102C0", "custtype": "P"})
            j = r.json()
            if j.get("rt_cd") == "0": return j.get("output1") or []
            if "초당" in str(j.get("msg1", "")): time.sleep(1); continue
            return []
        except Exception: time.sleep(1)
    return []
res = []; since = today - dt.timedelta(365)
for i, r in enumerate(cand, 1):
    ttm = 0; yrs = set(); n = 0
    for x in fetch(r["code"]):
        rd = d8(x.get("record_date")); dps = num(x.get("per_sto_divi_amt") or 0)
        if not rd or dps <= 0 or x.get("sht_cd") != r["code"]: continue
        yrs.add(rd.year)
        if since < rd <= today: ttm += dps; n += 1
    if ttm > 0: res.append({**r, "ttm": ttm, "n": n, "yrs": len(yrs), "y": ttm / r["px"] * 100})
    if i % 300 == 0: print(f"{i}/{len(cand)}", flush=True)
res.sort(key=lambda r: -r["y"])
O.append(f"- 최근 12개월 배당이 있는 종목 {len(res)}개")
O.append("\n| 배당수익률 | 종목 수(우선주 포함) | 그중 우선주 |\n|---|---|---|")
for t in (3, 4, 5, 6, 7, 8, 10, 15):
    s = [r for r in res if r["y"] >= t]; O.append(f"| {t}% 이상 | {len(s)} | {sum(1 for r in s if re.search(r'우[A-C]?$|우\\(전환\\)', r['name']))} |")
O.append(f"\n## 배당수익률 상위 (DIV_MIN {DIV_MIN}% 이상 {sum(1 for r in res if r['y']>=DIV_MIN)}개)\n\n| 종목 | 코드 | 시장 | 현재가 | 12개월 배당 | 횟수 | 수익률 | DB 분류 |\n|---|---|---|---|---|---|---|---|")
for r in res:
    if r["y"] >= DIV_MIN: O.append(f"| {r['name']} | {r['code']} | {r['mk']} | {r['px']:,.0f} | {r['ttm']:,.0f} | {r['n']} | {r['y']:.1f}% | {have.get(r['code'],'없음')} |")
names = ("삼성전자우", "고려신용정보", "이크레더블", "코리안리", "한국쉘석유", "현대엘리베이터")
O.append("\n## 요청하신 종목 확인")
for nm in names:
    hit = [r for r in res if r["name"] == nm]; hv = [r for r in uni if r["name"] == nm]
    O.append(f"- {nm}: " + (f"후보 {hit[0]['code']} 수익률 {hit[0]['y']:.1f}%" if hit else (f"이미 운영 중이거나 배당 없음({hv[0]['code']}, DB분류 {have.get(hv[0]['code'],'없음')})" if hv else "네이버 목록에 없음")))
if APPLY:
    tok2 = kis.get_token(warn=print); rate = kis.RateLimiter(15); done = []
    for r in res:
        if r["y"] < DIV_MIN: continue
        sh = kis.fetch_listed_shares(tok2, r["code"], rate) or 0
        cur.execute("""insert into stocks (code,name,market,security_type,is_active,first_seen,last_seen,listed_shares) values (%s,%s,%s,'STOCK',true,current_date,current_date,%s)
          on conflict (code) do update set name=excluded.name,market=excluded.market,security_type='STOCK',is_active=true,last_seen=current_date,listed_shares=coalesce(nullif(excluded.listed_shares,0),stocks.listed_shares),updated_at=now()""", (r["code"], r["name"], r["mk"], sh))
        done.append(r["code"])
    conn.commit(); open("new_codes.txt", "w").write("\n".join(done)); O.append(f"\n- 등록 {len(done)}종목")
open("div_universe.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O[:30]))
