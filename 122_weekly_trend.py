#!/usr/bin/env python3
"""주봉 추세(나스닥 종합·QQQ·코스피) — 글로벌 시황 '주봉 추세' 탭용.

Yahoo 주봉(1wk, 전 기간)을 받아 EMA 20/50/100/200, RSI(14)와 RSI의 14주 이동평균을 계산하고
global_pack(tab='WK') 한 행에 최근 N주만 담아 저장합니다. 200주 EMA 수렴에 긴 이력이 필요해서 2000년부터 받습니다(range=max는 Yahoo가 월·분기봉으로 뭉개서 쓰지 않음).
사용: SUPABASE_DB_URL=... python 122_weekly_trend.py [--report weekly_report.md]
"""
import os, sys, json, time, datetime
import requests, psycopg2

# (코드, 이름, Yahoo 티커, 소수자리, 상관 계산 방식: ret=주간 수익률 / diff=주간 변화폭(금리))
SYMS = [("IXIC", "나스닥 종합", "^IXIC", 0, "ret"), ("KS11", "코스피", "^KS11", 0, "ret"),
        ("TNX", "미국 10년물 금리(%)", "^TNX", 2, "diff"), ("WTI", "WTI 원유(선물, $)", "CL=F", 1, "ret"), ("GOLD", "금(선물, $)", "GC=F", 0, "ret")]
KEEP = 1100         # 화면에 보낼 최근 주 수(약 21년 — 20년 보기 지원)
EMAS = (20, 50, 100, 200)
rep = []
def log(m=""):
    print(m); rep.append(m)

def fetch(ysym):
    err = ""
    for host in ("query1", "query2"):
        try:
            r = requests.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(ysym)}",
                             params={"interval": "1wk", "period1": int(datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc).timestamp()), "period2": int(time.time()) + 86400}, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
            if r.status_code != 200:
                err = f"HTTP {r.status_code}"; continue
            res = r.json()["chart"]["result"][0]
            off = int(res.get("meta", {}).get("gmtoffset") or 0)
            q = res["indicators"]["quote"][0]
            rows = []
            for t, o, h, l, c in zip(res["timestamp"], q["open"], q["high"], q["low"], q["close"]):
                if None in (o, h, l, c):
                    continue
                d = datetime.datetime.fromtimestamp(t + off, datetime.timezone.utc).date()
                d = d - datetime.timedelta(days=d.weekday())   # 그 주 월요일로 통일(자산 간 주 정렬·잠정봉 중복 제거)
                rows.append((d.isoformat(), float(o), float(h), float(l), float(c)))
            return rows, None
        except Exception as ex:
            err = f"예외 {str(ex)[:80]}"
    return None, err

def ema(c, n):
    k = 2.0 / (n + 1); out = []; prev = None
    for x in c:
        prev = x if prev is None else x * k + prev * (1 - k)
        out.append(prev)
    return out

def rsi_wilder(c, n=14):
    out = [None] * len(c)
    if len(c) <= n:
        return out
    g = [max(c[i] - c[i - 1], 0) for i in range(1, len(c))]
    l = [max(c[i - 1] - c[i], 0) for i in range(1, len(c))]
    ag = sum(g[:n]) / n; al = sum(l[:n]) / n
    out[n] = 100 - 100 / (1 + ag / al) if al else 100.0
    for i in range(n, len(g)):
        ag = (ag * (n - 1) + g[i]) / n; al = (al * (n - 1) + l[i]) / n
        out[i + 1] = 100 - 100 / (1 + ag / al) if al else 100.0
    return out

def sma(v, n):
    out = []
    for i in range(len(v)):
        w = [x for x in v[max(0, i - n + 1):i + 1] if x is not None]
        out.append(sum(w) / n if len(w) == n else None)
    return out

def r2(x):
    return None if x is None else round(x, 2)

def build(code, name, ysym, dec=0, kind="ret"):
    rows, err = fetch(ysym)
    if not rows:
        log(f"- {code}: 실패 ({err})"); return None
    # 같은 주가 중복으로 오면(현재 주 잠정봉) 마지막 값만
    dd = {}
    for r in rows: dd[r[0]] = r
    rows = [dd[k] for k in sorted(dd)]
    c = [r[4] for r in rows]
    E = {n: ema(c, n) for n in EMAS}
    rs = rsi_wilder(c); rm = sma(rs, 14)
    a = max(0, len(rows) - KEEP)
    sl = lambda v: [r2(x) for x in v[a:]]
    it = {"code": code, "n": name, "dec": dec, "kind": kind, "d": [r[0] for r in rows[a:]],
          "o": sl([r[1] for r in rows]), "h": sl([r[2] for r in rows]), "l": sl([r[3] for r in rows]), "c": sl(c),
          "rsi": sl(rs), "rsm": sl(rm)}
    for n in EMAS: it[f"e{n}"] = sl(E[n])
    last = len(c) - 1
    it["last"] = {"c": r2(c[last]), "dev200": r2((c[last] / E[200][last] - 1) * 100), "dev20": r2((c[last] / E[20][last] - 1) * 100),
                  "rsi": r2(rs[last]), "weeks": len(rows), "first": rows[0][0]}
    log(f"- {code}: 주봉 {len(rows)}개({rows[0][0]}~{rows[-1][0]}) · 종가 {c[last]:,.2f} · EMA200 {E[200][last]:,.2f}({it['last']['dev200']:+.1f}%) · RSI {it['last']['rsi']}")
    if len(rows) < 260:
        log(f"  ⚠ 이력이 {len(rows)}주뿐 — 200주 EMA가 덜 수렴했을 수 있음")
    return it

def main():
    rp = sys.argv[sys.argv.index("--report") + 1] if "--report" in sys.argv else None
    log(f"# 주봉 추세 수집 ({datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC)")
    items = [x for x in (build(*s) for s in SYMS) if x]
    ok = bool(items)
    if ok:
        pack = {"tab": "WK", "as_of": max(x["d"][-1] for x in items), "items": items,
                "note": "EMA 20·50·100·200(주봉) · RSI(14) + 14주 이동평균 · 데이터 Yahoo Finance(선물은 연속월물 기준)"}
        js = json.dumps(pack, ensure_ascii=False, separators=(",", ":"))
        conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
        with conn.cursor() as cur:
            cur.execute("""insert into global_pack (tab, as_of, payload, updated_at) values ('WK',%s,%s::jsonb, now())
                           on conflict (tab) do update set as_of=excluded.as_of, payload=excluded.payload, updated_at=now()""",
                        (pack["as_of"], js))
        conn.commit(); conn.close()
        log(f"- 저장 완료 · {len(js)/1024:.0f}KB")
        open("pack_WK.json", "w", encoding="utf-8").write(js)
    if rp: open(rp, "w", encoding="utf-8").write("\n".join(rep) + "\n")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
