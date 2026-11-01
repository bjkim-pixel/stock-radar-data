# -*- coding: utf-8 -*-
"""ETF 101종목(etf_list.json) 마스터 + 일봉 수집 → etf_master / etf_daily.
  python 107_etf_collect.py            # 증분(없는 종목은 2025-09-01부터 백필, 있는 종목은 최근 15일만)
  python 107_etf_collect.py --full     # 전 종목 2025-09-01부터 다시 채움
읽기: KIS 일봉(FHKST03010100)·현재가(FHKST01010100). 쓰기: etf_master/etf_daily 만."""
import os, sys, json, time, datetime, requests, importlib, psycopg2
from psycopg2.extras import execute_values
HERE = os.path.dirname(os.path.abspath(__file__))
KST = datetime.timezone(datetime.timedelta(hours=9))
KIS_KEY = os.environ.get("KIS_APP_KEY", ""); KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE = "https://openapi.koreainvestment.com:9443"
BACKFILL_FROM = datetime.date(2025, 9, 1)
FULL = "--full" in sys.argv
tok = os.environ.get("KIS_ACCESS_TOKEN", "").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path, tr, params):
    time.sleep(0.1)
    for _ in range(3):
        try:
            r = requests.get(KIS_BASE + path, params=params, timeout=20, headers={"Content-Type": "application/json; charset=utf-8",
                "authorization": f"Bearer {tok}", "appkey": KIS_KEY, "appsecret": KIS_SECRET, "tr_id": tr, "custtype": "P"})
            return r.json()
        except Exception:
            time.sleep(1.5)
    return {}
def fnum(x):
    try: return float(x)
    except Exception: return None
def fetch_daily(code, d1, d2):
    out, end = {}, d2
    while end >= d1:
        start = max(d1, end - datetime.timedelta(days=130))
        d = kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
            "FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code, "FID_INPUT_DATE_1": start.strftime("%Y%m%d"),
            "FID_INPUT_DATE_2": end.strftime("%Y%m%d"), "FID_PERIOD_DIV_CODE": "D", "FID_ORG_ADJ_PRC": "0"})
        rows = [x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date")]
        for x in rows:
            c = fnum(x.get("stck_clpr"))
            if c:
                dt = datetime.datetime.strptime(x["stck_bsop_date"], "%Y%m%d").date()
                out[dt] = (fnum(x.get("stck_oprc")), fnum(x.get("stck_hgpr")), fnum(x.get("stck_lwpr")), c,
                           int(fnum(x.get("acml_vol")) or 0), int(fnum(x.get("acml_tr_pbmn")) or 0))
        if not rows: break
        oldest = min(datetime.datetime.strptime(x["stck_bsop_date"], "%Y%m%d").date() for x in rows)
        end = min(start, oldest) - datetime.timedelta(days=1)
    return out
ETFS = json.load(open(os.path.join(HERE, "etf_list.json"), encoding="utf-8"))
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = False
cur = conn.cursor()
cur.execute(open(os.path.join(HERE, "107_etf.sql"), encoding="utf-8").read()); conn.commit()
cur.execute("select code, count(*), max(trade_date) from etf_daily group by code")
have = {c: (n, m) for c, n, m in cur.fetchall()}
today = datetime.datetime.now(KST).date()
print(f"ETF {len(ETFS)}종목 · 기존 일봉 보유 {len(have)}종목 · 모드 {'전체' if FULL else '증분'}", flush=True)
ok = fail = newrows = 0
for i, e in enumerate(ETFS):
    code = e["code"]
    n, mx = have.get(code, (0, None))
    d1 = BACKFILL_FROM if (FULL or n < 100) else (mx - datetime.timedelta(days=15))
    data = fetch_daily(code, d1, today)
    if data:
        execute_values(cur, "insert into etf_daily (code,trade_date,open,high,low,close,volume,amount) values %s "
                       "on conflict (code,trade_date) do update set open=excluded.open, high=excluded.high, low=excluded.low, "
                       "close=excluded.close, volume=excluded.volume, amount=excluded.amount",
                       [(code, d, *v) for d, v in data.items()])
        newrows += len(data); ok += 1
    else:
        fail += 1; print(f"  ⚠ 일봉 없음: {code} {e['name']}", flush=True)
    p = kget("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code}).get("output") or {}
    mcap = fnum(p.get("hts_avls"))
    cur.execute("insert into etf_master (code,name,field,subfield,tags,country,mgmt,flags,mcap_eok,as_of,updated_at) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) "
                "on conflict (code) do update set name=excluded.name, field=excluded.field, subfield=excluded.subfield, tags=excluded.tags, "
                "country=excluded.country, mgmt=excluded.mgmt, flags=excluded.flags, mcap_eok=coalesce(excluded.mcap_eok, etf_master.mcap_eok), "
                "as_of=excluded.as_of, updated_at=now()",
                (code, e["name"], e["field"], e["subfield"], e["tags"], e["country"], e["mgmt"], e["flags"], mcap, today))
    conn.commit()
    if i % 25 == 0: print(f"  ({i}/{len(ETFS)})", flush=True)
cur.execute("select count(*), count(distinct code), min(trade_date), max(trade_date) from etf_daily"); print("etf_daily 현황(행/종목/시작/끝):", cur.fetchone())
cur.execute("select count(*) from etf_master"); print("etf_master:", cur.fetchone()[0])
cur.execute("select pg_size_pretty(pg_total_relation_size('etf_daily')), pg_size_pretty(pg_database_size(current_database()))"); print("etf_daily 크기 / DB 전체:", cur.fetchone())
print(f"완료: 성공 {ok} · 실패 {fail} · 업서트 {newrows}행")
sys.exit(1 if fail > len(ETFS) // 4 else 0)
