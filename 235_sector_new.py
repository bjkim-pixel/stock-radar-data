# -*- coding: utf-8 -*-
"""새로 등록한 해외 일반종목(sector_std 가 비어 있는 것)만 우리 업종 체계로 매핑. 기존 종목의 수동 결정은 건드리지 않음.
213_sector_std.py 의 매핑표(N/K/HOLD)를 그대로 쓰고, 이후 확정된 병합(건설→인프라, 암호화폐·AI인프라→IT/플랫폼)을 적용."""
import os, re, collections, psycopg2
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "213_sector_std.py"), encoding="utf-8").read()
exec(src.split("cn=psycopg2.connect")[0])          # N, HOLD, K, nz, NM, KM
cn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cn.autocommit = True; c = cn.cursor()
c.execute("select code,coalesce(name_ko,name_en),sector,profile->>'industry' from us_master where not is_etf and sector_std is null order by code")
R = c.fetchall(); L = [f"# 신규 해외종목 업종 매핑 · 대상 {len(R)}종목\n"]; hold = []; unm = []; n = collections.Counter()
FIX = {"건설": "인프라", "암호화폐·AI인프라": "IT/플랫폼"}
for code, nm, ks, ni in R:
    a = NM.get(nz(ni)); b = KM.get(nz(ks)); s = srcn = None
    if nz(ni) in HOLD: hold.append((code, nm, ni, ks, b)); continue
    if a: s, srcn = a, "naver"
    elif b: s, srcn = b, "kis"
    else: unm.append((code, nm, ni, ks)); continue
    s = FIX.get(s, s)
    c.execute("update us_master set sector_std=%s,sector_std_src=%s where code=%s", (s, srcn, code)); n[s] += 1
L.append("## 분포\n" + ", ".join(f"{k}({v})" for k, v in n.most_common()))
L.append(f"\n## 판단 보류(업종 비워둠) {len(hold)}\n" + "\n".join(f"- {a} {b} | 네이버 {c_} | KIS {d} | KIS기준 후보 {e}" for a, b, c_, d, e in hold))
L.append(f"\n## 매핑 누락 {len(unm)}\n" + "\n".join(f"- {a} {b} | 네이버 {c_} | KIS {d}" for a, b, c_, d in unm))
c.execute("select count(*) from us_master where not is_etf and sector_std is null"); L.append(f"\n남은 미분류 일반종목: {c.fetchone()[0]}")
open("sector_new.md", "w", encoding="utf-8").write("\n".join(L)); print("\n".join(L))
