# -*- coding: utf-8 -*-
"""사용자가 준 목록(asia_lists/<시장>.txt)을 us_top_asia 에 등록 → 이어서 176_us_collect.py --backfill --asia-only 가 KIS에서 조회·백필.
사용: python 200_asia_register.py jp   (jp=도쿄 TSE, hk=홍콩 HKS, sh=상해 SHS, sz=심천 SZS). 기존 종목은 그대로 두고 없는 것만 추가."""
import os, sys, re, psycopg2
MK = {"us": "NAS", "jp": "TSE", "hk": "HKS", "sh": "SHS", "sz": "SZS", "cn": "SHS"}   # cn = 상해+심천 한 파일(각 줄 앞에 SH/SZ)
SFX = {"TSE": ".T", "HKS": ".HK", "SHS": ".SS", "SZS": ".SZ", "NAS": "", "NYS": "", "AMS": ""}
PFX = {"SH": "SHS", "SZ": "SZS", "NAS": "NAS", "NYS": "NYS", "AMS": "AMS"}   # us = 미국 주식·ETF(줄마다 거래소 접두)
mk = sys.argv[1]; ex = MK[mk]
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("""create table if not exists public.us_top_asia(code text primary key, excd text not null, sym text not null, rnk int,
    mkt_cap numeric, name_ko text, updated_at timestamptz not null default now())""")
cur.execute("select kis_excd,code,kis_sym from us_master"); have = {}
for e, c, sy in cur.fetchall(): have[(e, sy.lstrip("0") if e == "HKS" else sy)] = c
n = 0
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "asia_lists", mk + ".txt"), encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"): continue
    parts = line.split(None, 2) if line.split(None, 1)[0] in PFX else [None] + line.split(None, 1)
    e = PFX[parts[0]] if parts[0] else ex
    sym, name = parts[1], parts[2] if len(parts) > 2 else parts[1]
    key = sym.lstrip("0") if e == "HKS" else sym.replace(".", "/")
    if mk == "us" and any((x, key) in have for x in ("NAS", "NYS", "AMS")): continue   # 이미 등록된 미국 종목은 건너뜀
    code = have.get((e, key)) or (f"{str(int(sym)).zfill(4)}{SFX[e]}" if e == "HKS" else f"{sym}{SFX[e]}")
    n += 1
    cur.execute("insert into us_top_asia(code,excd,sym,rnk,name_ko) values(%s,%s,%s,%s,%s) on conflict(code) do nothing", (code, e, sym, n, name))
cur.execute("select excd,count(*) from us_top_asia group by 1 order by 1"); print("us_top_asia:", cur.fetchall())
