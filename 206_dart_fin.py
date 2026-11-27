# -*- coding: utf-8 -*-
"""DART 전체 재무제표(fnlttSinglAcntAll)로 분기·연간 실적을 확정 값으로 교체 (src='dart').
사용법: python 206_dart_fin.py check [종목코드,쉼표]   → DB 변경 없이 DART 계산값과 현재 DB 값을 나란히 출력
        python 206_dart_fin.py apply [종목코드,쉼표]   → 백업 테이블 생성 후 DB 교체(코드 없으면 전체)
대상: 12월 결산 종목, 분기 2024Q4~2026Q3(분기 = 분기·반기·3분기 보고서의 '당기 3개월', 4분기 = 사업보고서 − 3분기 누적), 연간 2024·2025.
값(단위): 매출액·영업이익·순이익(당기순이익) 억원 · EPS 원 = 기본주당이익 · BPS 원 = 지배주주지분 ÷ 추정 주식수(지배순이익÷EPS) · ROE % = 지배순이익 ÷ 지배주주지분(분기는 ×4 연환산, 연간은 평균자본).
기준 = 종목별로 연결(CFS)이 전 보고서에 있으면 연결, 아니면 별도(OFS) — 한 종목 안에서 기준을 섞지 않음."""
import os, io, sys, time, zipfile, requests, psycopg2, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from psycopg2.extras import execute_values
MODE = sys.argv[1] if len(sys.argv) > 1 else "check"; ONLY = [c for c in (sys.argv[2] if len(sys.argv) > 2 else "").replace(" ", "").split(",") if c]
KEY = os.environ["DART_API_KEY"].strip(); B = "https://opendart.fss.or.kr/api/"; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
def api(ep, **p):
    for k in range(4):
        time.sleep(0.12)
        try: return requests.get(B + ep, params={"crtfc_key": KEY, **p}, timeout=60).json()
        except Exception: time.sleep(1.5 * (k + 1))
    return {}
z = zipfile.ZipFile(io.BytesIO(requests.get(B + "corpCode.xml", params={"crtfc_key": KEY}, timeout=90).content)); x = ET.fromstring(z.read(z.namelist()[0]))
CC = {i.findtext("stock_code").strip(): i.findtext("corp_code") for i in x.iter("list") if (i.findtext("stock_code") or "").strip()}
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("select code,name from stocks where is_active and security_type='STOCK' order by code"); ST = cur.fetchall()
if ONLY: ST = [s for s in ST if s[0] in ONLY]
REP = [(2024, "11014"), (2024, "11011"), (2025, "11013"), (2025, "11012"), (2025, "11014"), (2025, "11011"), (2026, "11013"), (2026, "11012"), (2026, "11014")]
def num(v):
    try: return float(str(v).replace(",", "").strip())
    except Exception: return None
IDS = {"sales": (["ifrs-full_Revenue", "ifrs_Revenue"], ["매출액", "수익(매출액)", "영업수익", "매출"]),
       "op": (["dart_OperatingIncomeLoss"], ["영업이익", "영업이익(손실)"]),
       "ni": (["ifrs-full_ProfitLoss"], ["당기순이익", "분기순이익", "반기순이익", "당기순이익(손실)", "분기순이익(손실)", "반기순이익(손실)"]),
       "nip": (["ifrs-full_ProfitLossAttributableToOwnersOfParent"], []),
       "eps": (["ifrs-full_BasicEarningsLossPerShare"], ["기본주당이익", "기본주당순이익", "기본주당이익(손실)", "기본주당순이익(손실)", "보통주 기본주당이익", "보통주기본주당이익"]),
       "eqp": (["ifrs-full_EquityAttributableToOwnersOfParent"], []), "eq": (["ifrs-full_Equity"], ["자본총계"])}
def pick(rows, key, sj):
    ids, names = IDS[key]
    for r in rows:
        if r.get("sj_div") in sj and (r.get("account_id") in ids or (r.get("account_nm") or "").strip() in names): return r
    return None
def fetch(corp, year, rc, fs):
    j = api("fnlttSinglAcntAll.json", corp_code=corp, bsns_year=str(year), reprt_code=rc, fs_div=fs)
    if j.get("status") == "020": raise SystemExit("DART 호출 한도 초과(020)")
    return j.get("list") if j.get("status") == "000" else None
def extract(rows):
    """한 보고서에서 3개월(amt)·누적(cum) 손익 값과 기말 자본"""
    d = {}
    for k in ("sales", "op", "ni", "nip", "eps"):
        r = pick(rows, k, ("IS", "CIS"))
        d[k] = (num(r.get("thstrm_amount")), num(r.get("thstrm_add_amount"))) if r else (None, None)
        d[k + "_pv"] = (num(r.get("frmtrm_amount")), num(r.get("frmtrm_add_amount"))) if r else (None, None)   # 전기 같은 기간(3개월, 누적)
    for k in ("eqp", "eq"):
        r = pick(rows, k, ("BS",)); d[k] = (num(r.get("thstrm_amount")), num(r.get("frmtrm_amount"))) if r else (None, None)
    return d
def build(code):
    corp = CC.get(code)
    if not corp: return None, "corp_code 없음"
    cj = api("company.json", corp_code=corp)
    if (cj.get("acc_mt") or "").strip() != "12": return None, f"결산월 {cj.get('acc_mt')}"
    for fs in ("CFS", "OFS"):
        R = {}
        for y, rc in REP:
            rows = fetch(corp, y, rc, fs)
            if rows is None: break
            R[(y, rc)] = extract(rows)
        if len(R) == len(REP): break
    else: return None, "재무제표 없음(연결·별도 모두 일부 보고서 누락)"
    out = {}
    def cumq(y, rc, k, cum):      # 분기 보고서의 3개월 값(없으면 누적 차이로 보정)
        a, c = R[(y, rc)][k]; return a if a is not None else None
    for y in (2025, 2026):
        q1, q2, q3 = R[(y, "11013")], R[(y, "11012")], R[(y, "11014")]
        for k in ("sales", "op", "ni", "nip", "eps"):
            v1 = q1[k][0] if q1[k][0] is not None else q1[k][1]
            v2 = q2[k][0] if q2[k][0] is not None else ((q2[k][1] - v1) if q2[k][1] is not None and v1 is not None else None)
            v3 = q3[k][0] if q3[k][0] is not None else ((q3[k][1] - q2[k][1]) if q3[k][1] is not None and q2[k][1] is not None else None)
            for per, v in ((f"{y}03", v1), (f"{y}06", v2), (f"{y}09", v3)): out.setdefault(per, {})[k] = v
        for per, rr in ((f"{y}03", q1), (f"{y}06", q2), (f"{y}09", q3)): out[per]["eqp"] = rr["eqp"][0] if rr["eqp"][0] is not None else rr["eq"][0]; out[per]["eq_prev"] = rr["eqp"][1] if rr["eqp"][1] is not None else rr["eq"][1]
        # 누적(EPS·순이익) 기반 주식수 추정
        for per, rr, kind in ((f"{y}03", q1, 1), (f"{y}06", q2, 2), (f"{y}09", q3, 2)):
            ak = "nip" if rr["nip"][0] is not None or rr["nip"][1] is not None else "ni"
            cur_c = (rr[ak][1] if rr[ak][1] is not None else rr[ak][0]) if kind == 2 else rr[ak][0]
            prv_c = (rr[ak + "_pv"][1] if rr[ak + "_pv"][1] is not None else None) if kind == 2 else rr[ak + "_pv"][0]
            pa = R[(y - 1, "11011")][("nip" if R[(y - 1, "11011")]["nip"][0] is not None else "ni")][0]
            out[per]["ttm"] = (pa - prv_c + cur_c) if (pa is not None and prv_c is not None and cur_c is not None) else None
        for per, rr in ((f"{y}03", q1), (f"{y}06", q2), (f"{y}09", q3)):
            nipc = rr["nip"][1] if rr["nip"][1] is not None else rr["nip"][0]; epsc = rr["eps"][1] if rr["eps"][1] is not None else rr["eps"][0]
            if nipc is None: nipc = rr["ni"][1] if rr["ni"][1] is not None else rr["ni"][0]
            out[per]["sh"] = (nipc / epsc) if (nipc is not None and epsc) else None
    ann = {}
    for y in (2024, 2025):
        a, q = R[(y, "11011")], R[(y, "11014")]; per = f"{y}12"; out[per] = {}; ann[per] = {}
        for k in ("sales", "op", "ni", "nip", "eps"):
            av = a[k][0]; q9 = q[k][1] if q[k][1] is not None else None
            out[per][k] = (av - q9) if (av is not None and q9 is not None) else None
            ann[per][k] = av
        out[per]["eqp"] = a["eqp"][0] if a["eqp"][0] is not None else a["eq"][0]; out[per]["eq_prev"] = a["eqp"][1] if a["eqp"][1] is not None else a["eq"][1]
        nipa = a["nip"][0] if a["nip"][0] is not None else a["ni"][0]; out[per]["sh"] = (nipa / a["eps"][0]) if (nipa is not None and a["eps"][0]) else None
        out[per]["ttm"] = nipa; ann[per]["eqp"] = out[per]["eqp"]; ann[per]["eq_prev"] = out[per]["eq_prev"]; ann[per]["sh"] = out[per]["sh"]
    def fin(d, annual):
        nip = d.get("nip") if d.get("nip") is not None else d.get("ni")
        bps = (d["eqp"] / d["sh"]) if (d.get("eqp") is not None and d.get("sh")) else None
        base = d.get("ttm") if d.get("ttm") is not None else (nip if annual else None)   # 최근 4분기(TTM) 지배순이익
        if d.get("eqp") and base is not None:
            eqa = (d["eqp"] + d["eq_prev"]) / 2 if d.get("eq_prev") else d["eqp"]; roe = base / eqa * 100   # 평균 자본(기말·전기말)
        else: roe = None
        e = lambda v: None if v is None else round(v / 1e8, 1)
        return {"sales": e(d.get("sales")), "op": e(d.get("op")), "ni": e(d.get("ni")), "eps": None if d.get("eps") is None else round(d["eps"], 0),
                "bps": None if bps is None else round(bps, 0), "roe": None if roe is None else round(roe, 2)}
    res = {("Q", per): fin(out[per], False) for per in ("202412", "202503", "202506", "202509", "202512", "202603", "202606", "202609")}
    for per in ("202412", "202512"): res[("A", per)] = fin({**ann[per], "ni": ann[per]["ni"]}, True)
    return (res, fs), None
cur.execute("select code,freq,period,is_est,sales,op_profit,net_income,eps,bps,roe,src from stock_earnings where period>='202412'")
DB = {(r[0], r[1], r[2]): r[3:] for r in cur.fetchall()}
results = {}; skipped = []; done = 0
with ThreadPoolExecutor(4) as ex:
    fut = {ex.submit(build, c): (c, n) for c, n in ST}
    for f in as_completed(fut):
        c, n = fut[f]; done += 1
        try: r, why = f.result()
        except SystemExit as e: raise
        except Exception as e: r, why = None, f"오류 {type(e).__name__} {e}"
        if r: results[c] = r
        else: skipped.append((c, n, why))
        if done % 25 == 0: print(done, len(ST), flush=True)
names = dict(ST)
log(f"# DART 재무 교체 ({MODE}) · 대상 {len(ST)}종목 · 계산 성공 {len(results)} · 제외 {len(skipped)}")
from collections import Counter
log("기준: " + str(Counter(fs for _, fs in results.values())))
log("제외 사유: " + str(Counter(w.split(' ')[0] if w.startswith('결산월') else w for _, _, w in skipped)))
chg = {k: 0 for k in ("sales", "op", "ni")}; tot = 0; ex = []
for c, (res, fs) in results.items():
    for (fq, per), v in res.items():
        o = DB.get((c, fq, per))
        if not o or o[0]: continue
        tot += 1
        for k, i in (("sales", 1), ("op", 2), ("ni", 3)):
            if v[k] is not None and o[i] is not None and abs(v[k] - float(o[i])) > max(1.0, 0.005 * abs(float(o[i]))):
                chg[k] += 1
                if len(ex) < 25: ex.append((c, names[c], fq, per, k, float(o[i]), v[k]))
log(f"기존 확정 행 {tot}개 중 DART와 다른 값(±1억·0.5% 초과): {chg}")
log("다른 값 예시: " + str(ex))
cnt_new = sum(1 for c, (res, fs) in results.items() for key in res if (c, key[0], key[1]) not in DB); log(f"새로 생기는 행 {cnt_new}개 · 예상→확정 전환 {sum(1 for c, (res, fs) in results.items() for key in res if DB.get((c, key[0], key[1])) and DB[(c, key[0], key[1])][0])}개")
if len(ST) <= 6:
    for c, (res, fs) in results.items():
        log(f"\n## {names[c]} {c} ({fs})")
        for (fq, per), v in sorted(res.items()):
            ex_ = DB.get((c, fq, per)); log(f"  {fq} {per} DART {v} | DB(E,매출,영업,순익,EPS,BPS,ROE,src)={ex_}")
if MODE == "apply":
    cur.execute("create table if not exists stock_earnings_bak_20261127 as select * from stock_earnings")
    rows = [(c, fq, per, False, v["sales"], v["op"], v["ni"], v["eps"], v["bps"], v["roe"], "dart") for c, (res, fs) in results.items() for (fq, per), v in res.items()]
    cur.execute("alter table stock_earnings add column if not exists fs_div text")
    execute_values(cur, """insert into stock_earnings(code,freq,period,is_est,sales,op_profit,net_income,eps,bps,roe,src) values %s
      on conflict(code,freq,period) do update set is_est=false,sales=excluded.sales,op_profit=excluded.op_profit,net_income=excluded.net_income,
        eps=coalesce(excluded.eps,stock_earnings.eps),bps=coalesce(excluded.bps,stock_earnings.bps),roe=coalesce(excluded.roe,stock_earnings.roe),src='dart',updated_at=now()""", rows)
    for c, (res, fs) in results.items(): cur.execute("update stock_earnings set fs_div=%s where code=%s and src='dart'", (fs, c))
    log(f"저장 {len(rows)}행 (백업 테이블 stock_earnings_bak_20261127)")
open("dart_fin.md", "w", encoding="utf-8").write("\n".join(L))
