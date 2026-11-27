# -*- coding: utf-8 -*-
"""KWEB 전체 보유종목 점검(읽기 전용): stockanalysis 전체 행 → KIS 시세 조회 가능 여부 → us_master 등록 여부."""
import os, re, html as _h, importlib, requests, psycopg2
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
U = importlib.import_module("176_us_collect")
U.TOK = importlib.import_module("72_kis_token").get_token_cached()
SA = {"TYO": ".T", "SHA": ".SS", "SHE": ".SZ", "TPE": ".TW", "HKG": ".HK", "KRX": ".KS"}
T = os.environ.get("ETF", "KWEB")
r = requests.get(f"https://stockanalysis.com/etf/{T.lower()}/holdings/", timeout=25, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept-Language": "en-US,en;q=0.9"})
h = r.content.decode("utf-8", "ignore"); rows = []
for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
    cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
    pct = next((c for c in cells if re.fullmatch(r"\d+(\.\d+)?%", c)), None)
    if len(cells) >= 4 and pct:
        n0 = re.fullmatch(r"\d+", cells[0]); sym = cells[1] if n0 else cells[0]; nm = cells[2] if n0 else cells[1]
        sym = sym.replace("$", "").strip()
        if ":" in sym:
            ex, tk = sym.split(":", 1); sym = tk + SA.get(ex.upper(), "") if ex.upper() in SA else sym
        rows.append((sym, _h.unescape(nm), float(pct[:-1])))
log(f"# {T} 보유종목 — stockanalysis HTTP {r.status_code}, 파싱 {len(rows)}행, 비중 합 {sum(x[2] for x in rows):.1f}%")
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = conn.cursor()
cur.execute("select code from us_master"); have = {x[0] for x in cur.fetchall()}
log("| # | 표기 | 이름 | 비중 | KIS 변환 | 시세 | DB 등록 |"); log("|---|---|---|---|---|---|---|")
ok = 0
for i, (s, n, p) in enumerate(rows, 1):
    cs = U.candidates(s); q = ""
    for ex, sy in cs:
        o = U.detail(ex, sy)
        if o: q = f"{ex}:{sy} {o.get('last')}"; ok += 1; break
    log(f"| {i} | {s} | {n[:28]} | {p}% | {cs[0][0]+':'+cs[0][1] if cs else '미지원'} | {q or ('실패' if cs else '-')} | {'O' if s in have else 'X'} |")
log(f"\n→ 시세 조회 성공 {ok}/{len(rows)}")
open("kweb_probe.md", "w", encoding="utf-8").write("\n".join(L))
