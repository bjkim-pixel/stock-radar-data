# -*- coding: utf-8 -*-
"""홍콩·도쿄·상해·심천 시가총액 상위 50 선별 (KIS 마스터 + 현재가상세 tomv). 결과는 us_top_asia 에 저장. 재실행(분기별) 시 기존 종목은 그대로 두고 새로 상위 50에 든 종목만 추가(176_us_collect.py 가 읽음).
대만은 KIS 미지원이라 제외. 실행: python 199_asia_top50.py   (30~60분, 분기마다 1회 권장)"""
import os, io, re, sys, json, time, zipfile, importlib, requests, psycopg2
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
U = importlib.import_module("176_us_collect")
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
TOPN = int(os.environ.get("TOPN", "50"))
MK = [("HKS", "hks", "홍콩"), ("TSE", "tse", "도쿄"), ("SHS", "shs", "상해"), ("SZS", "szs", "심천")]
def disp(ex, sym):
    if ex == "HKS": return f"{str(int(sym)).zfill(4)}.HK" if sym.isdigit() else None
    if ex == "TSE": return f"{sym}.T"
    if ex == "SHS": return f"{sym}.SS"
    if ex == "SZS": return f"{sym}.SZ"
def main():
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
    cur.execute("""create table if not exists public.us_top_asia(code text primary key, excd text not null, sym text not null, rnk int,
        mkt_cap numeric, name_ko text, updated_at timestamptz not null default now())""")
    cur.execute("select code,kis_excd,kis_sym from us_master"); have = {(r[1], r[2].lstrip("0") if r[1] == "HKS" else r[2]): r[0] for r in cur.fetchall()}
    U.TOK = importlib.import_module("72_kis_token").get_token_cached()
    limit = int(os.environ.get("LIMIT", "0"))
    for ex, f, nm in MK:
        t0 = time.time()
        raw = zipfile.ZipFile(io.BytesIO(requests.get(f"https://new.real.download.dws.co.kr/common/master/{f}mst.cod.zip", timeout=60).content))
        lines = raw.read(raw.namelist()[0]).decode("cp949", "ignore").splitlines()
        cols = [l.split("\t") for l in lines if l.strip()]
        stk = [(c[4].strip(), c[6].strip()) for c in cols if len(c) > 8 and c[8].strip() == "2"]
        if limit: stk = stk[:limit]
        log(f"\n## {nm}({ex}) 보통주 {len(stk)}개 시총 조회")
        res, miss = [], 0
        for i, (sym, name) in enumerate(stk):
            try:
                o = U.detail(ex, sym)
                mc = U.num(o.get("tomv")) if o else None
                if mc: res.append((mc, sym, name))
                else: miss += 1
            except Exception: miss += 1
            if (i + 1) % 500 == 0: log(f"  - {i+1}/{len(stk)} 진행 · 유효 {len(res)} · {int(time.time()-t0)}초")
        res.sort(reverse=True)
        log(f"- 유효 {len(res)} · 시총 없음 {miss} · {int(time.time()-t0)}초")
        log("| 순위 | 코드 | 이름 | 시총(현지통화) |"); log("|---|---|---|---|")
        cur.execute("select code from us_top_asia where excd=%s", (ex,)); prev = {r[0] for r in cur.fetchall()}
        added = []
        for r, (mc, sym, name) in enumerate(res[:TOPN], 1):
            code = have.get((ex, sym.lstrip("0") if ex == "HKS" else sym)) or disp(ex, sym)
            if not code: continue
            cur.execute("insert into us_top_asia(code,excd,sym,rnk,mkt_cap,name_ko) values(%s,%s,%s,%s,%s,%s) on conflict(code) do update set rnk=excluded.rnk,mkt_cap=excluded.mkt_cap,updated_at=now()", (code, ex, sym, r, mc, name))
            if code not in prev: added.append(code)
            if r <= 10 or r == TOPN: log(f"| {r} | {code} | {name} | {mc:,.0f} |")
        log(f"- 신규 추가 {len(added)}개(기존 종목은 유지·삭제 안 함): {', '.join(added)}")
    cur.execute("select excd,count(*) from us_top_asia group by 1 order by 1"); log("\n- us_top_asia: " + str(cur.fetchall()))
    open("asia_top50_report.md", "w", encoding="utf-8").write("\n".join(L))
if __name__ == "__main__": main()
