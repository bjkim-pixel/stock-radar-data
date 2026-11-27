# -*- coding: utf-8 -*-
"""DART 단일회사 주요계정(fnlttSinglAcnt)으로 분기 실적(매출액·영업이익·순이익)을 보정.
사용법: python 206_dart_fin.py check [표본간격=6]   → DB 변경 없이 네이버 값과 비교 리포트
        python 206_dart_fin.py apply               → 누락 행·예상(E) 행을 DART 확정값으로 채움(src='dart'). 이미 확정된 행은 건드리지 않음
대상 분기: 2024Q4 ~ 2026Q3(12월 결산 종목). 분기 값 = 분기·반기·3분기 보고서의 '당기 3개월', 4분기 = 사업보고서 연간 − 3분기 누적. 단위 원 → 억원."""
import os, io, sys, time, zipfile, requests, psycopg2, xml.etree.ElementTree as ET
from psycopg2.extras import execute_values
MODE = sys.argv[1] if len(sys.argv) > 1 else "check"; STEP = int(sys.argv[2]) if len(sys.argv) > 2 else 6
KEY = os.environ["DART_API_KEY"].strip(); B = "https://opendart.fss.or.kr/api/"; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
def api(ep, **p):
    for _ in range(3):
        time.sleep(0.1)
        try: return requests.get(B + ep, params={"crtfc_key": KEY, **p}, timeout=40)
        except Exception: time.sleep(1.5)
    return None
z = zipfile.ZipFile(io.BytesIO(api("corpCode.xml").content)); x = ET.fromstring(z.read(z.namelist()[0]))
CC = {i.findtext("stock_code").strip(): i.findtext("corp_code") for i in x.iter("list") if (i.findtext("stock_code") or "").strip()}
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("select code,name from stocks where is_active and security_type='STOCK' order by code"); ST = cur.fetchall()
if MODE == "check": ST = [s for i, s in enumerate(ST) if i % STEP == 0 or s[0] in ("420770", "290550", "005930", "000660")]
cur.execute("select code,period,is_est,sales,op_profit,net_income from stock_earnings where freq='Q' and period>='202412'")
DB = {(r[0], r[1]): r[2:] for r in cur.fetchall()}
SALES = ("매출액", "수익(매출액)", "영업수익"); OP = ("영업이익", "영업이익(손실)"); NI = ("당기순이익", "분기순이익", "반기순이익")
def num(v):
    try: return float(str(v).replace(",", "").strip())
    except Exception: return None
def report(corp, year, rc):
    r = api("fnlttSinglAcnt.json", corp_code=corp, bsns_year=str(year), reprt_code=rc)
    try: j = r.json()
    except Exception: return None
    if j.get("status") != "000": return None
    out = {}
    for fs in ("CFS", "OFS"):
        rows = [x for x in j["list"] if x.get("fs_div") == fs and x.get("sj_div") in ("IS", "CIS")]
        if not rows: continue
        d = {}
        for k, names in (("sales", SALES), ("op", OP), ("ni", NI)):
            for x in rows:
                a = (x.get("account_nm") or "").strip()
                if any(a == n or a.startswith(n) for n in names):
                    d[k] = (num(x.get("thstrm_amount")), num(x.get("thstrm_add_amount"))); break
        out[fs] = d
    return out
def quarters(corp):
    """period → {sales,op,ni}(억원), 기준(fs)"""
    R = {}
    for y, rc in ((2024, "11014"), (2024, "11011"), (2025, "11013"), (2025, "11012"), (2025, "11014"), (2025, "11011"), (2026, "11013"), (2026, "11012"), (2026, "11014")):
        R[(y, rc)] = report(corp, y, rc)
    res = {}
    def q3(fsd, k, ann=None):
        return fsd[k]
    for (y, rc), per in (((2025, "11013"), "202503"), ((2025, "11012"), "202506"), ((2025, "11014"), "202509"), ((2026, "11013"), "202603"), ((2026, "11012"), "202606"), ((2026, "11014"), "202609")):
        rp = R.get((y, rc))
        if not rp: continue
        fs = "CFS" if "CFS" in rp else "OFS"; d = rp[fs]
        res[per] = ({k: (d[k][0] / 1e8 if d[k][0] is not None else None) for k in d}, fs)
    for y in (2024, 2025):
        a, q = R.get((y, "11011")), R.get((y, "11014"))
        if not a or not q: continue
        for fs in ("CFS", "OFS"):
            if fs in a and fs in q:
                d = {}
                for k in a[fs]:
                    if k in q[fs] and a[fs][k][0] is not None and q[fs][k][1] is not None: d[k] = (a[fs][k][0] - q[fs][k][1]) / 1e8
                res[f"{y}12"] = (d, fs); break
    return res
FIELD = {"sales": 0, "op": 1, "ni": 2}; stat = {k: [0, 0] for k in FIELD}; bad = []; fill = []; conv = []; skipped = []; nofy = 0
for n, (code, nm) in enumerate(ST, 1):
    corp = CC.get(code)
    if not corp: skipped.append((code, nm, "corp_code 없음")); continue
    cj = api("company.json", corp_code=corp).json()
    if (cj.get("acc_mt") or "").strip() != "12": nofy += 1; skipped.append((code, nm, f"결산월 {cj.get('acc_mt')}")); continue
    qs = quarters(corp)
    for per, (d, fs) in qs.items():
        ex = DB.get((code, per))
        if ex is None or ex[0]:      # 행 없음 또는 예상(E) → 채우기 후보
            if d: (fill if ex is None else conv).append((code, nm, per, fs, d))
            continue
        for k, idx in FIELD.items():       # 확정 행: 네이버 값과 비교
            dv, nv = d.get(k), ex[1 + idx]
            if dv is None or nv is None: continue
            stat[k][0] += 1
            if abs(dv - float(nv)) <= 1.0 or abs(dv - float(nv)) <= 0.005 * abs(float(nv)): stat[k][1] += 1
            else: bad.append((code, nm, per, k, float(nv), round(dv, 1), fs))
    if n % 25 == 0: print(n, len(ST), flush=True)
log(f"# DART 재무 점검 ({MODE}) · 대상 {len(ST)}종목 · 12월 결산 아님/코드없음 {len(skipped)}")
log("## 기존 확정 행 vs DART (허용오차 ±1억 또는 ±0.5%)")
for k, (t, m) in stat.items(): log(f"- {k}: 비교 {t}건 · 일치 {m}건 ({(m/t*100 if t else 0):.1f}%)")
log(f"## 불일치 {len(bad)}건 (앞 40)"); [log("  " + str(b)) for b in bad[:40]]
log(f"## 새로 채울 행 {len(fill)}개 · 예상(E)→확정 전환 {len(conv)}개"); [log("  " + str(f[:4]) + " " + str({k: round(v, 1) for k, v in f[4].items() if v is not None})) for f in (conv[:15] + fill[:15])]
log("## 건너뜀 샘플: " + str(skipped[:15]))
if MODE == "apply":
    rows = [(c, "Q", per, False, d.get("sales"), d.get("op"), d.get("ni"), "dart") for c, nm, per, fs, d in fill + conv]
    execute_values(cur, """insert into stock_earnings(code,freq,period,is_est,sales,op_profit,net_income,src) values %s
      on conflict(code,freq,period) do update set is_est=false,sales=excluded.sales,op_profit=excluded.op_profit,net_income=excluded.net_income,
        eps=null,bps=null,roe=null,src='dart',updated_at=now() where stock_earnings.is_est""", rows)
    log(f"저장 {len(rows)}행")
open("dart_fin.md", "w", encoding="utf-8").write("\n".join(L))
