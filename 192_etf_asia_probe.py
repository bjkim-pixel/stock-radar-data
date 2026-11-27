# -*- coding: utf-8 -*-
"""일본·중국·홍콩 관련 ETF 점검(읽기 전용): ① 우리 DB(etf_master)에 있는 것 ② 해외종목(us_master)에 이미 모은 일본·홍콩·중국 종목 ③ 국내 상장 ETF 중 DB에 없는 후보(시총·거래대금)."""
import os, re, io, time, zipfile, importlib, requests, psycopg2
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
PAT = r"일본|니케이|TOPIX|도쿄|JAPAN|Nikkei|중국|차이나|CHINA|CSI|항셍|HANG|홍콩|H주|HSCEI|과창판|심천|상해|STAR|MSCI China|china"
ASIA = r"일본|니케이|TOPIX|도쿄|엔화|중국|차이나|CSI|항셍|홍콩|H주|과창판|심천|상해|China|Japan|Nikkei|Hang"
cur.execute("select code,name,field,subfield,tags,country,mgmt,flags,mcap_eok from etf_master order by country nulls last, mcap_eok desc nulls last")
M = cur.fetchall()
log(f"# 일본·중국·홍콩 ETF 점검 — etf_master 전체 {len(M)}개")
cur.execute("select code,count(*),max(trade_date) from etf_daily group by code"); D = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
inDB = {}
log("\n## ① 우리 DB(etf_master)에 등록된 일본·중국·홍콩 관련 ETF")
log("| 코드 | 이름 | 분야 | 국가 | 특성 | 시총(억) | 일봉 |"); log("|---|---|---|---|---|---|---|")
n = 0
for code, name, field, sub, tags, ctry, mgmt, flags, mc in M:
    if re.search(ASIA, name or "") or (ctry or "") in ("일본", "중국", "홍콩"):
        n += 1; inDB[code] = name
        d = D.get(code)
        log(f"| {code} | {name} | {field or ''}/{sub or ''} | {ctry or ''} | {flags or ''} | {mc if mc is not None else ''} | {str(d[0])+'일 ~'+str(d[1]) if d else '없음'} |")
log(f"\n→ {n}개")
log("\n## 참고: etf_master 국가 분포")
from collections import Counter
for k, v in Counter((r[5] or '(없음)') for r in M).most_common(): log(f"- {k}: {v}")
log("\n## ② 해외종목(us_master)에 이미 모은 일본·홍콩·중국")
cur.execute("select kis_excd,is_etf,count(*) from us_master where kis_excd in ('TSE','HKS','SHS','SZS') group by 1,2 order by 1,2")
for r in cur.fetchall(): log(f"- {r[0]} {'ETF' if r[1] else '종목'} {r[2]}개")
cur.execute("select code,coalesce(name_ko,name_en),kis_excd,is_etf from us_master where kis_excd in ('TSE','HKS','SHS','SZS') order by kis_excd, is_etf, code")
rows = cur.fetchall()
log("| 거래소 | 구분 | 코드 | 이름 |"); log("|---|---|---|---|")
for c, nm, ex, e in rows: log(f"| {ex} | {'ETF' if e else '종목'} | {c} | {nm} |")
log("\n## ③ 국내 상장 ETF 중 일본·중국·홍콩 관련인데 DB에 없는 것")
try:
    z = zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", timeout=30).content))
    raw = z.read(z.namelist()[0]).decode("cp949", "ignore").splitlines()
    etfs = [(x[:9].strip(), x[21:-227].strip()) for x in raw if len(x) >= 240 and x[-227:][:2] == "EF"]
    log(f"국내 상장 ETF 전체 {len(etfs)}개 중 이름에 일본·중국·홍콩 관련어가 있는 것")
    cand = [(c, n) for c, n in etfs if re.search(ASIA, n) and c not in inDB]
    KEY = os.environ.get("KIS_APP_KEY", ""); SEC = os.environ.get("KIS_APP_SECRET", "")
    tok = os.environ.get("KIS_ACCESS_TOKEN", "").strip() or importlib.import_module("72_kis_token").get_token_cached()
    def kq(code):
        time.sleep(0.08)
        try:
            return requests.get("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price", params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code}, timeout=20,
                headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": "FHKST01010100"}).json().get("output") or {}
        except Exception: return {}
    out = []
    for c, n in cand:
        p = kq(c)
        try: mc = float(p.get("hts_avls") or 0); tv = float(p.get("acml_tr_pbmn") or 0) / 1e8
        except Exception: mc, tv = 0, 0
        out.append((mc, c, n, tv))
    out.sort(reverse=True)
    log("| 코드 | 이름 | 시총(억) | 오늘 거래대금(억) |"); log("|---|---|---|---|")
    for mc, c, n, tv in out: log(f"| {c} | {n} | {mc:,.0f} | {tv:,.1f} |")
    log(f"\n→ DB에 없는 후보 {len(out)}개")
except Exception as e:
    log(f"(국내 ETF 목록 조회 실패: {e})")
open("etf_asia.md", "w", encoding="utf-8").write("\n".join(L))
