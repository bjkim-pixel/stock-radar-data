# -*- coding: utf-8 -*-
"""아시아 종목 중 종목명(name_ko)이 비어 있는 것을 KIS 해외종목 마스터(한글명)로 채운다. 없으면 목록 파일명 → 영문명 순."""
import os, io, zipfile, requests, psycopg2
F = {"HKS": "hks", "TSE": "tse", "SHS": "shs", "SZS": "szs"}
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True; cur = c.cursor()
cur.execute("select code,kis_excd,kis_sym,name_en from us_master where kis_excd = any(%s) and coalesce(trim(name_ko),'')=''", (list(F),))
miss = cur.fetchall(); out = [f"이름 없는 아시아 종목: {len(miss)}개"]
cur.execute("select code,name_ko from us_top_asia"); lst = dict(cur.fetchall())
mst = {}
for e in {m[1] for m in miss}:
    r = requests.get(f"https://new.real.download.dws.co.kr/common/master/{F[e]}mst.cod.zip", timeout=60); r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    for l in z.read(z.namelist()[0]).decode("cp949", "ignore").splitlines():
        p = l.split("\t")
        if len(p) > 7 and p[3].strip(): mst[(e, p[3].strip())] = (p[5].strip(), p[6].strip())
n = {"master": 0, "list": 0, "en": 0, "none": []}
for code, e, sym, en in miss:
    k = [(e, sym), (e, sym.lstrip("0")), (e, sym.zfill(5))]
    ko = next((mst[x][0] for x in k if x in mst and mst[x][0]), None); src = "master"
    if not ko: ko, src = (lst.get(code) or "").strip() or None, "list"
    if not ko: ko, src = (en or next((mst[x][1] for x in k if x in mst and mst[x][1]), None)), "en"
    if ko:
        cur.execute("update us_master set name_ko=%s where code=%s", (ko, code)); n[src] += 1
        if sum(n[s] for s in ("master", "list", "en")) <= 8: out.append(f"- {code}: {ko} ({src})")
    else: n["none"].append(code)
out.append(f"채움: KIS마스터 {n['master']} · 목록명 {n['list']} · 영문 {n['en']} · 못채움 {n['none']}")
print("\n".join(out)); open("asia_names.md", "w", encoding="utf-8").write("\n".join(out))
