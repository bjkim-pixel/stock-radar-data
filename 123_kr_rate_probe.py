#!/usr/bin/env python3
"""한국 금리 데이터 소스 점검(읽기 전용, 임시) — 일일/주간으로 20년치를 무료·무키로 받을 수 있는지."""
import requests, re, io
rep=[]
def log(m=""): print(m); rep.append(m)
H={"User-Agent":"Mozilla/5.0"}
def t(name,fn):
    try: fn()
    except Exception as e: log(f"- {name}: 예외 {str(e)[:120]}")

def fred():
    for sid in ("IRLTLT01KRM156N","IR3TIB01KRM156N","INTGSBKRM193N"):
        r=requests.get("https://fred.stlouisfed.org/graph/fredgraph.csv",params={"id":sid},headers=H,timeout=30)
        rows=r.text.strip().splitlines()
        log(f"- FRED {sid}: HTTP {r.status_code} · {len(rows)-1}행 · 처음 {rows[1] if len(rows)>1 else ''} · 끝 {rows[-1]}")
t("FRED",fred)

def naver(code):
    for p in (1,2,50,300,600,900):
        r=requests.get("https://finance.naver.com/marketindex/interestDailyQuote.naver",params={"marketindexCd":code,"page":p},headers=H,timeout=30)
        r.encoding="euc-kr"
        d=re.findall(r'class="date">\s*([\d.]+)\s*</td>\s*<td class="num">\s*([\d.]+)',r.text)
        log(f"- Naver {code} p{p}: HTTP {r.status_code} · {len(d)}행 · {d[:1]}{d[-1:]}")
        if not d: break
for c in ("IRR_GOVT03Y","IRR_GOVT10Y","IRR_CD91"):
    t("Naver "+c,lambda c=c:naver(c))

def yahoo():
    for s in ("^KR10YT","KR10YT=RR","^TNX"):
        r=requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(s)}",params={"interval":"1wk","range":"1y"},headers=H,timeout=30)
        log(f"- Yahoo {s}: HTTP {r.status_code}")
t("Yahoo",yahoo)

def stooq():
    for s in ("10kry.b","kr10y.b"):
        r=requests.get(f"https://stooq.com/q/d/l/?s={s}&i=w",headers=H,timeout=30)
        log(f"- Stooq {s}: HTTP {r.status_code} · {len(r.text.splitlines())}행 · {r.text[:80]!r}")
t("Stooq",stooq)

def inv():
    r=requests.get("https://api.investing.com/api/financialdata/historical/29234",params={"start-date":"2020-01-01","end-date":"2020-02-01","time-frame":"Weekly"},headers=H,timeout=30)
    log(f"- investing API: HTTP {r.status_code}")
t("investing",inv)
open("kr_rate_probe.md","w",encoding="utf-8").write("# 한국 금리 소스 점검\n"+"\n".join(rep)+"\n")
