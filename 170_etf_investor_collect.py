# -*- coding: utf-8 -*-
"""ETF 투자자별 수급(개인·외국인·기관+기관세부) 30거래일 + NAV·괴리율 이력(21일) → etf_investor_daily / etf_flow_daily(nav,dprt).
KIS: investor-trade-by-stock-daily(FHPTJ04160001, output2) · etfetn nav-comparison-daily-trend(FHPST02440200). 읽기 전용 + 위 두 테이블 쓰기."""
import os, sys, json, time, datetime, requests, importlib, psycopg2
from psycopg2.extras import execute_values
HERE = os.path.dirname(os.path.abspath(__file__))
KST = datetime.timezone(datetime.timedelta(hours=9))
KEY = os.environ.get("KIS_APP_KEY", ""); SEC = os.environ.get("KIS_APP_SECRET", "")
B = "https://openapi.koreainvestment.com:9443"
tok = os.environ.get("KIS_ACCESS_TOKEN", "").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path, tr, params):
    time.sleep(0.12)
    for _ in range(3):
        try:
            return requests.get(B + path, params=params, timeout=20, headers={"Content-Type": "application/json; charset=utf-8",
                "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": "P"}).json()
        except Exception: time.sleep(1.5)
    return {}
def iv(x, mul=1):
    try:
        if x in (None, ""): return None
        return int(round(float(x) * mul))
    except Exception: return None
def fl(x):
    try: return None if x in (None, "") else float(x)
    except Exception: return None
def dday(s): return datetime.datetime.strptime(s, "%Y%m%d").date()
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
cur.execute(open(os.path.join(HERE, "170_etf_investor.sql"), encoding="utf-8").read()); conn.commit()
cur.execute("select code, name from etf_master order by code"); ETFS = cur.fetchall()
today = datetime.datetime.now(KST).date(); ok = fail = nrows = nnav = 0
print(f"ETF {len(ETFS)}종목 수급·NAV 수집", flush=True)
for i, (code, name) in enumerate(ETFS):
    rows = []
    for anchor in (today, ):
        j = kget("/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily", "FHPTJ04160001",
                 {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code, "FID_INPUT_DATE_1": anchor.strftime("%Y%m%d"), "FID_ORG_ADJ_PRC": "0", "FID_ETC_CLS_CODE": "0"})
        for r in (j.get("output2") or []):
            if not r.get("stck_bsop_date"): continue
            M = 1_000_000   # _tr_pbmn = 백만원
            fa = iv(r.get("frgn_reg_ntby_pbmn"), M)
            if fa is None: fa = iv(r.get("frgn_ntby_tr_pbmn"), M)
            fq = iv(r.get("frgn_reg_ntby_qty"));  fq = iv(r.get("frgn_ntby_qty")) if fq is None else fq
            if r.get("prsn_ntby_qty") in (None, "") and r.get("orgn_ntby_qty") in (None, ""): continue   # 당일 미확정 행
            rows.append((dday(r["stck_bsop_date"]), code, iv(r.get("prsn_ntby_qty")), fq, iv(r.get("orgn_ntby_qty")),
                         iv(r.get("prsn_ntby_tr_pbmn"), M), fa, iv(r.get("orgn_ntby_tr_pbmn"), M),
                         iv(r.get("scrt_ntby_tr_pbmn"), M), iv(r.get("ivtr_ntby_tr_pbmn"), M), iv(r.get("pe_fund_ntby_tr_pbmn"), M),
                         iv(r.get("bank_ntby_tr_pbmn"), M), iv(r.get("insu_ntby_tr_pbmn"), M), iv(r.get("fund_ntby_tr_pbmn"), M)))
    if rows:
        execute_values(cur, "insert into etf_investor_daily (d,etf_code,prsn_qty,frgn_qty,orgn_qty,prsn_amt,frgn_amt,orgn_amt,scrt_amt,ivtr_amt,pe_amt,bank_amt,insu_amt,fund_amt) values %s "
            "on conflict (d,etf_code) do update set prsn_qty=excluded.prsn_qty,frgn_qty=excluded.frgn_qty,orgn_qty=excluded.orgn_qty,prsn_amt=excluded.prsn_amt,frgn_amt=excluded.frgn_amt,"
            "orgn_amt=excluded.orgn_amt,scrt_amt=excluded.scrt_amt,ivtr_amt=excluded.ivtr_amt,pe_amt=excluded.pe_amt,bank_amt=excluded.bank_amt,insu_amt=excluded.insu_amt,fund_amt=excluded.fund_amt", rows)
        nrows += len(rows); ok += 1
    else:
        fail += 1; print(f"  ⚠ 수급 없음: {code} {name}", flush=True)
    n = kget("/uapi/etfetn/v1/quotations/nav-comparison-daily-trend", "FHPST02440200",
             {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code, "FID_INPUT_DATE_1": (today - datetime.timedelta(days=40)).strftime("%Y%m%d"), "FID_INPUT_DATE_2": today.strftime("%Y%m%d")})
    nv = [(dday(r["stck_bsop_date"]), code, fl(r.get("nav")), fl(r.get("dprt"))) for r in (n.get("output") or []) if r.get("stck_bsop_date") and fl(r.get("nav"))]
    if nv:
        execute_values(cur, "insert into etf_flow_daily (d,etf_code,nav,dprt) values %s on conflict (d,etf_code) do update set nav=excluded.nav, dprt=excluded.dprt", nv); nnav += len(nv)
    conn.commit()
    if i % 25 == 0: print(f"  ({i}/{len(ETFS)})", flush=True)
cur.execute("select count(*),count(distinct etf_code),min(d),max(d) from etf_investor_daily"); print("etf_investor_daily:", cur.fetchone())
print(f"완료: 수급 성공 {ok} · 실패 {fail} · 수급 {nrows}행 · NAV {nnav}행")
sys.exit(1 if fail > len(ETFS) // 3 else 0)
