# -*- coding: utf-8 -*-
"""사용자가 준 목록(asia_lists/<시장>.txt)을 us_top_asia 에 등록 → 이어서 176_us_collect.py --backfill --asia-only 가 KIS에서 조회·백필.
사용: python 200_asia_register.py jp   (jp=도쿄 TSE, hk=홍콩 HKS, sh=상해 SHS, sz=심천 SZS). 기존 종목은 그대로 두고 없는 것만 추가."""
import os, sys, re, psycopg2
MK = {"jp": "TSE", "hk": "HKS", "sh": "SHS", "sz": "SZS"}
SFX = {"TSE": ".T", "HKS": ".HK", "SHS": ".SS", "SZS": ".SZ"}
mk = sys.argv[1]; ex = MK[mk]
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("""create table if not exists public.us_top_asia(code text primary key, excd text not null, sym text not null, rnk int,
    mkt_cap numeric, name_ko text, updated_at timestamptz not null default now())""")
cur.execute("select code,kis_sym from us_master where kis_excd=%s", (ex,)); have = {(s.lstrip("0") if ex == "HKS" else s): c for c, s in cur.fetchall()}
n = 0
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "asia_lists", mk + ".txt"), encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"): continue
    sym, name = line.split(None, 1)
    key = sym.lstrip("0") if ex == "HKS" else sym
    code = have.get(key) or (f"{sym.zfill(4)}{SFX[ex]}" if ex == "HKS" else f"{sym}{SFX[ex]}")
    n += 1
    cur.execute("insert into us_top_asia(code,excd,sym,rnk,name_ko) values(%s,%s,%s,%s,%s) on conflict(code) do nothing", (code, ex, sym, n, name))
cur.execute("select excd,count(*) from us_top_asia group by 1 order by 1"); print("us_top_asia:", cur.fetchall())
