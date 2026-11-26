# -*- coding: utf-8 -*-
"""미국 종목·ETF 상세 페이지 기획용 점검(읽기 전용, DB 변경 없음) — 2026-11-27
  1) global_pack(US)에 실제로 나오는 미국 ETF와 보유종목(상위 5) 목록
  2) KIS 해외주식 API 응답 확인 — 표본 종목으로 필드·건수·연속조회
     기간별시세(HHDFS76240000) · 현재가상세(HHDFS76200200) · 상품기본정보(CTPF1702R)
     · 종목/지수/환율기간별시세(FHKST03030100) · 기간별권리조회(CTRGT011R)
  3) 목록 전체를 KIS 거래소(NAS/NYS/AMS)로 찾을 수 있는지 — 현재가(HHDFS00000300)로 1건씩
  4) DB 용량
결과: us_probe_report.md"""
import os, sys, time, json, datetime, importlib, requests, psycopg2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
KIS_KEY = os.environ.get("KIS_APP_KEY", ""); KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
BASE = "https://openapi.koreainvestment.com:9443"
L = []
def log(m=""):
    print(m, flush=True); L.append(str(m))

def token():
    t = os.environ.get("KIS_ACCESS_TOKEN", "").strip()
    return t or importlib.import_module("72_kis_token").get_token_cached()

TOK = None
def kget(path, tr, params, cont=""):
    time.sleep(0.12)
    h = {"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {TOK}",
         "appkey": KIS_KEY, "appsecret": KIS_SECRET, "tr_id": tr, "custtype": "P"}
    if cont: h["tr_cont"] = cont
    r = requests.get(BASE + path, params=params, headers=h, timeout=20)
    try: d = r.json()
    except Exception: d = {"raw": r.text[:200]}
    return r.status_code, d, r.headers.get("tr_cont", "")

def brief(d):
    return f"rt_cd={d.get('rt_cd')} msg={str(d.get('msg1', ''))[:70]}"

# ── 1) 목록 ───────────────────────────────────────────────
log(f"# 미국 종목·ETF 상세 기획 점검 ({datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC)\n")
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
cur.execute("select as_of, payload from global_pack where tab='US'")
as_of, P = cur.fetchone()
if isinstance(P, str): P = json.loads(P)
etfs, hold = {}, {}
for g in P.get("groups", []):
    for k in g["keys"]:
        it = P["items"].get(k) or {}
        t = k.split(":", 1)[1]
        if t.startswith("^") or t.startswith("RATIO"): continue
        etfs.setdefault(t, {"name": it.get("n") or it.get("name") or "", "groups": []})["groups"].append(g["id"])
        for x in it.get("h") or []:
            hold.setdefault(x["c"], {"ko": x.get("k"), "en": x.get("f"), "x": x.get("x"), "in": []})["in"].append(t)
log(f"## 1) 글로벌 시황(미국) 목록 — 기준일 {as_of}")
log(f"- ETF {len(etfs)}개 · 보유종목(상위 5) 고유 {len(hold)}개")
log("\n### ETF")
for t, v in etfs.items(): log(f"- {t} · {v['name']} · {','.join(dict.fromkeys(v['groups']))}")
log("\n### 보유종목 (거래소 표기 · 편입 ETF)")
for c, v in sorted(hold.items(), key=lambda kv: -len(kv[1]['in'])):
    log(f"- {c} · {v['ko']} · {v['x']} · {','.join(v['in'])}")

# ── 2) KIS 표본 ───────────────────────────────────────────
log("\n## 2) KIS 해외주식 API 표본")
try:
    TOK = token(); log("- 토큰: OK")
except Exception as e:
    log(f"- 토큰 실패: {str(e)[:150]}")
if TOK:
    SAMPLE = [("NAS", "NVDA"), ("NYS", "JPM"), ("AMS", "SPY"), ("NAS", "QQQ"), ("AMS", "GLD")]
    for ex, sym in SAMPLE:
        rows, bymd, cont, calls, first = [], "20261127", "", 0, None
        while calls < 12:
            st, d, nxt = kget("/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000",
                              {"AUTH": "", "EXCD": ex, "SYMB": sym, "GUBN": "0", "BYMD": bymd, "MODP": "1", "KEYB": ""}, cont)
            calls += 1
            o2 = [r for r in (d.get("output2") or []) if r.get("xymd")]
            if calls == 1:
                log(f"\n### {ex}:{sym} 기간별시세 HTTP {st} {brief(d)} · 1회 {len(o2)}건 · tr_cont={nxt!r}")
                if d.get("output1"): log(f"  - output1: {json.dumps(d['output1'], ensure_ascii=False)[:400]}")
                if o2: log(f"  - output2 필드: {list(o2[0].keys())} · 예 {json.dumps(o2[0], ensure_ascii=False)[:300]}")
            if not o2: break
            rows += o2
            last = o2[-1]["xymd"]
            if last <= "20260101" or nxt not in ("M", "F"): break
            bymd, cont = last, "N"
        ds = sorted({r["xymd"] for r in rows})
        n26 = len([x for x in ds if x >= "20260101"])
        log(f"  - 연속조회 {calls}회 · 고유 {len(ds)}일 · 범위 {ds[0] if ds else '-'}~{ds[-1] if ds else '-'} · 2026-01-01 이후 {n26}일")
        st, d, _ = kget("/uapi/overseas-price/v1/quotations/price-detail", "HHDFS76200200", {"AUTH": "", "EXCD": ex, "SYMB": sym})
        o = d.get("output") or {}
        log(f"  - 현재가상세 HTTP {st} {brief(d)} · 필드 {len(o)}개")
        if o: log(f"    {json.dumps(o, ensure_ascii=False)[:1500]}")
        ptype = {"NAS": "512", "NYS": "513", "AMS": "529"}[ex]
        st, d, _ = kget("/uapi/overseas-price/v1/quotations/search-info", "CTPF1702R", {"PRDT_TYPE_CD": ptype, "PDNO": sym})
        o = d.get("output") or {}
        log(f"  - 상품기본정보 HTTP {st} {brief(d)} · 필드 {len(o)}개")
        if o: log(f"    {json.dumps(o, ensure_ascii=False)[:1500]}")
    st, d, _ = kget("/uapi/overseas-price/v1/quotations/inquire-daily-chartprice", "FHKST03030100",
                    {"FID_COND_MRKT_DIV_CODE": "N", "FID_INPUT_ISCD": "COMP", "FID_INPUT_DATE_1": "20260101",
                     "FID_INPUT_DATE_2": "20261127", "FID_PERIOD_DIV_CODE": "D"})
    o2 = d.get("output2") or []
    log(f"\n### 지수 기간별(FHKST03030100) 나스닥 COMP: HTTP {st} {brief(d)} · {len(o2)}건" + (f" · 필드 {list(o2[0].keys())}" if o2 else ""))
    st, d, _ = kget("/uapi/overseas-price/v1/quotations/period-rights", "CTRGT011R",
                    {"RGHT_TYPE_CD": "03", "INQR_DVSN_CD": "02", "INQR_STRT_DT": "20260101", "INQR_END_DT": "20261231",
                     "PDNO": "JPM", "PRDT_TYPE_CD": "513", "CTX_AREA_NK50": "", "CTX_AREA_FK50": ""})
    o = d.get("output") or []
    log(f"### 기간별권리조회(CTRGT011R) JPM 배당: HTTP {st} {brief(d)} · {len(o) if isinstance(o, list) else 1}건" +
        (f" · 예 {json.dumps(o[:2], ensure_ascii=False)[:600]}" if o else ""))

# ── 3) 목록 전체 KIS 조회 가능 여부 ───────────────────────
    log("\n## 3) 목록 전체 — KIS 미국 거래소에서 찾기(현재가)")
    found, miss = {}, []
    def find(sym):
        s = sym.replace(".", "/") if sym.endswith((".A", ".B")) else sym
        for ex in ("NAS", "NYS", "AMS"):
            st, d, _ = kget("/uapi/overseas-price/v1/quotations/price", "HHDFS00000300", {"AUTH": "", "EXCD": ex, "SYMB": s})
            o = d.get("output") or {}
            if d.get("rt_cd") == "0" and o.get("last") not in (None, "", "0", "0.0000"):
                return ex, o
        return None, None
    targets = list(etfs) + [c for c in hold if c not in etfs]
    for t in targets:
        if "." in t and not t.endswith((".A", ".B")):
            miss.append((t, "해외(미국 외) 표기")); continue
        ex, o = find(t)
        if ex: found[t] = (ex, o.get("last"), o.get("tamt"))
        else: miss.append((t, "미국 3개 거래소에서 못 찾음"))
    log(f"- 대상 {len(targets)}개 · 찾음 {len(found)} · 못 찾음 {len(miss)}")
    by = {}
    for t, (ex, _, _) in found.items(): by.setdefault(ex, []).append(t)
    for ex, l in by.items(): log(f"- {ex} {len(l)}개: {', '.join(l)}")
    log("- 못 찾음: " + ", ".join(f"{t}({w})" for t, w in miss))

# ── 4) DB ─────────────────────────────────────────────────
log("\n## 4) DB")
cur.execute("select pg_size_pretty(pg_database_size(current_database()))"); log(f"- DB 전체 용량: {cur.fetchone()[0]} (무료 한도 500MB)")
cur.execute("select pg_size_pretty(pg_total_relation_size('daily_price')), (select count(*) from daily_price where trade_date>='2026-01-01')")
log(f"- daily_price 용량·2026년 행수(국내 참고): {cur.fetchone()}")
open("us_probe_report.md", "w", encoding="utf-8").write("\n".join(L))
