# -*- coding: utf-8 -*-
"""해외(미국·홍콩·일본·중국) 종목·ETF 일봉·기본정보·배당 수집 (KIS 해외 API) — 2026-11-27
대상: 글로벌 시황 미국 탭(global_pack US)의 ETF + 보유종목. 한국 종목·KIS 미지원 거래소(대만·런던 등)는 제외.
모드: 기본(매일) = 일봉 최근 100건 갱신 + 기본정보 + 배당 / --backfill = 2026-01-01까지 연속 조회
결과: us_collect_report.md"""
import os, sys, re, time, json, datetime, importlib, requests, psycopg2
from psycopg2.extras import execute_values
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
KEY, SECRET = os.environ.get("KIS_APP_KEY", ""), os.environ.get("KIS_APP_SECRET", "")
BASE = "https://openapi.koreainvestment.com:9443"
START = "20260101"
BACKFILL = "--backfill" in sys.argv
ASIA_ONLY = "--asia-only" in sys.argv   # 시총 상위(us_top_asia) 종목만 처리
PRDT = {"NAS": "512", "NYS": "513", "AMS": "529", "HKS": "501", "TSE": "515", "SHS": "551", "SZS": "552"}
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
TOK = None
def kget(path, tr, params, cont=""):
    time.sleep(0.12)
    h = {"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {TOK}",
         "appkey": KEY, "appsecret": SECRET, "tr_id": tr, "custtype": "P"}
    if cont: h["tr_cont"] = cont
    for a in range(3):
        try:
            r = requests.get(BASE + path, params=params, headers=h, timeout=20)
            d = r.json()
            if d.get("rt_cd") == "1" and "초과" in str(d.get("msg1", "")):   # 호출 한도
                time.sleep(1.5); continue
            return d, r.headers.get("tr_cont", "")
        except Exception as e:
            time.sleep(1)
    return {}, ""
def num(x):
    try:
        v = float(str(x).replace(",", "").replace("+", ""))
        return v
    except Exception: return None
def dt(s):
    s = str(s or "")
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if re.fullmatch(r"\d{8}", s) and s != "00000000" else None

def candidates(code):
    """표시 티커 → KIS (거래소, 심볼) 후보. 한국·미지원 거래소는 빈 목록."""
    c = code.strip()
    m = re.fullmatch(r"(.+)\.(KS|KQ)", c)
    if m or re.fullmatch(r"\d{6}", c): return []                      # 한국 종목 → 기존 한국 상세
    m = re.fullmatch(r"(\d+)\.HK", c)
    if m: return [("HKS", m.group(1).zfill(5)), ("HKS", m.group(1))]
    m = re.fullmatch(r"(\w+)\.(T|JP)", c)
    if m: return [("TSE", m.group(1))]
    m = re.fullmatch(r"(\d+)\.SZ", c)
    if m: return [("SZS", m.group(1))]
    m = re.fullmatch(r"(\d+)\.(C1|SS|SH)", c)
    if m: return [("SHS", m.group(1))]
    if "." in c and not re.fullmatch(r"[A-Z]+\.[AB]", c): return []   # TT, L, TO, HE, DE 등
    s = c.replace(".", "/")
    return [("NAS", s), ("NYS", s), ("AMS", s)]

def detail(ex, sym):
    d, _ = kget("/uapi/overseas-price/v1/quotations/price-detail", "HHDFS76200200", {"AUTH": "", "EXCD": ex, "SYMB": sym})
    o = d.get("output") or {}
    return o if d.get("rt_cd") == "0" and num(o.get("last")) else None

def daily(ex, sym, full):
    rows, bymd, cont, calls = {}, datetime.date.today().strftime("%Y%m%d"), "", 0
    while calls < 8:
        d, nxt = kget("/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000",
                      {"AUTH": "", "EXCD": ex, "SYMB": sym, "GUBN": "0", "BYMD": bymd, "MODP": "1", "KEYB": ""}, cont)
        calls += 1
        o2 = [r for r in (d.get("output2") or []) if r.get("xymd")]
        if not o2: break
        for r in o2:
            if r["xymd"] >= START and num(r.get("clos")): rows[r["xymd"]] = r
        last = o2[-1]["xymd"]
        if not full or last <= START or nxt not in ("M", "F"): break
        bymd, cont = last, "N"
    return rows

def main():
    global TOK
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
    cur.execute(open(os.path.join(HERE, "176_us_stocks.sql"), encoding="utf-8").read())
    TOK = importlib.import_module("72_kis_token").get_token_cached()
    cur.execute("select payload from global_pack where tab='US'")
    P = cur.fetchone()[0]
    if isinstance(P, str): P = json.loads(P)
    etf, hold = [], []
    for g in P.get("groups", []):
        for k in g["keys"]:
            t = k.split(":", 1)[1]
            if t.startswith("^") or t.startswith("RATIO"): continue
            if t not in etf: etf.append(t)
            for x in (P["items"].get(k) or {}).get("h") or []:
                if x["c"] not in hold: hold.append(x["c"])
    targets = etf + [c for c in hold if c not in etf]
    try:   # 홍콩·도쿄·상해·심천 시총 상위 50(199_asia_top50.py 가 선별) — 매일 수집 대상에 합류
        cur.execute("select code from us_top_asia order by excd, rnk"); asia = [r[0] for r in cur.fetchall()]
    except Exception:
        asia = []
    targets = asia if ASIA_ONLY else targets + [c for c in asia if c not in targets]
    cur.execute("select code,kis_excd,kis_sym,name_ko from us_master"); known = {r[0]: r[1:] for r in cur.fetchall()}
    log(f"# 해외 종목 수집 {datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC · {'백필' if BACKFILL else '일일'} · 대상 {len(targets)}개")
    ok, skipped, failed, nrows, nrights = 0, [], [], 0, 0
    infolog = []
    for code in targets:
        try:
            cands = [(known[code][0], known[code][1])] if code in known else candidates(code)
            if not cands: skipped.append(code); continue
            ex = sym = o = None
            for e, s in cands:
                o = detail(e, s)
                if o: ex, sym = e, s; break
            if not o: failed.append(code); continue
            is_etf = (o.get("etyp_nm") or "") == "ETF" or code in etf
            name_ko = (known.get(code) or (0, 0, None))[2]; name_en = None
            d, _ = kget("/uapi/overseas-price/v1/quotations/search-info", "CTPF1702R", {"PRDT_TYPE_CD": PRDT[ex], "PDNO": sym})
            i = d.get("output") or {}
            if not name_ko:
                name_ko, name_en = i.get("prdt_name") or None, i.get("prdt_eng_name") or None
            if i.get("ovrs_stck_etf_risk_drtp_cd"): is_etf = True
            # 종목 소개용: KIS 상품기본정보(CTPF1702R) + 현재가상세 중 값이 있는 항목을 그대로 저장
            info = {"si": {k: v for k, v in i.items() if str(v).strip() not in ("", "0", "00000000")},
                    "pd": {k: v for k, v in o.items() if k in ("e_icod", "etyp_nm", "e_parp", "e_hogau", "vnit", "e_ordyn", "curr", "shar") and str(v).strip()}}
            if len(infolog) < 4 or code in ("SPY", "NVDA", "SOXX", "0700.HK"):
                log(f"[info] {code} {json.dumps(info, ensure_ascii=False)[:1800]}"); infolog.append(code)
            shares = int(num(o.get("shar")) or 0) or None
            rate = num(o.get("t_rate"))
            cur.execute("""insert into us_master(code,kis_excd,kis_sym,name_en,name_ko,is_etf,ccy,sector,listed_shares,last,base,
                h52p,h52d,l52p,l52d,per,pbr,eps,bps,mkt_cap,krw_rate,info,updated_at)
              values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
              on conflict(code) do update set kis_excd=excluded.kis_excd,kis_sym=excluded.kis_sym,
                name_en=coalesce(excluded.name_en,us_master.name_en),name_ko=coalesce(excluded.name_ko,us_master.name_ko),
                is_etf=excluded.is_etf,ccy=excluded.ccy,sector=excluded.sector,listed_shares=excluded.listed_shares,last=excluded.last,
                base=excluded.base,h52p=excluded.h52p,h52d=excluded.h52d,l52p=excluded.l52p,l52d=excluded.l52d,per=excluded.per,
                pbr=excluded.pbr,eps=excluded.eps,bps=excluded.bps,mkt_cap=excluded.mkt_cap,krw_rate=excluded.krw_rate,info=excluded.info,updated_at=now()""",
              (code, ex, sym, name_en, name_ko, is_etf, o.get("curr"), (o.get("e_icod") or None), shares, num(o.get("last")), num(o.get("base")),
               num(o.get("h52p")), dt(o.get("h52d")), num(o.get("l52p")), dt(o.get("l52d")), num(o.get("perx")), num(o.get("pbrx")),
               num(o.get("epsx")), num(o.get("bpsx")), num(o.get("tomv")), rate, json.dumps(info, ensure_ascii=False)))
            rows = daily(ex, sym, BACKFILL)
            vals = [(code, dt(x), num(r["open"]), num(r["high"]), num(r["low"]), num(r["clos"]), int(num(r.get("tvol")) or 0),
                     num(r.get("tamt")), num(r.get("rate")), shares) for x, r in rows.items()]
            if vals:
                execute_values(cur, """insert into us_daily(code,trade_date,open,high,low,close,volume,amount,change_pct,listed_shares) values %s
                  on conflict(code,trade_date) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
                  volume=excluded.volume,amount=excluded.amount,change_pct=excluded.change_pct,listed_shares=excluded.listed_shares""", vals)
                nrows += len(vals)
            d, _ = kget("/uapi/overseas-price/v1/quotations/period-rights", "CTRGT011R",
                        {"RGHT_TYPE_CD": "03", "INQR_DVSN_CD": "02", "INQR_STRT_DT": START,
                         "INQR_END_DT": datetime.date.today().strftime("%Y1231"), "PDNO": sym, "PRDT_TYPE_CD": PRDT[ex],
                         "CTX_AREA_NK50": "", "CTX_AREA_FK50": ""})
            rv = [(code, dt(r.get("bass_dt")), "03", num(r.get("alct_frcr_unpr")), r.get("crcy_cd") or o.get("curr"))
                  for r in (d.get("output") or []) if isinstance(r, dict) and dt(r.get("bass_dt")) and num(r.get("alct_frcr_unpr"))]
            if rv:
                execute_values(cur, """insert into us_rights(code,base_date,rght_type,cash_per_share,ccy) values %s
                  on conflict(code,base_date,rght_type) do update set cash_per_share=excluded.cash_per_share,ccy=excluded.ccy""", rv)
                nrights += len(rv)
            ok += 1
        except Exception as e:
            failed.append(f"{code}({str(e)[:60]})")
    log(f"- 성공 {ok} · 일봉 {nrows}행 · 배당 {nrights}건")
    log(f"- 제외(한국·KIS 미지원 거래소) {len(skipped)}: {', '.join(skipped)}")
    log(f"- 실패(KIS에서 못 찾음) {len(failed)}: {', '.join(failed)}")
    cur.execute("select count(*), min(trade_date), max(trade_date) from us_daily"); log(f"- us_daily: {cur.fetchone()}")
    cur.execute("select count(*) filter (where is_etf), count(*) filter (where not is_etf) from us_master"); log(f"- us_master ETF/일반: {cur.fetchone()}")
    cur.execute("select pg_size_pretty(pg_database_size(current_database()))"); log(f"- DB 용량: {cur.fetchone()[0]}")
    open("us_collect_report.md", "w", encoding="utf-8").write("\n".join(L))
    if ok == 0: sys.exit(1)
if __name__ == "__main__": main()
