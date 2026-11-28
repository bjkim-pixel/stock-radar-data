# -*- coding: utf-8 -*-
"""신규 해외종목 중 자동 매핑이 안 된 42종목을 기존 업종 체계로 수동 배정(기준: 국내 대응 종목·기존 결정과 동일 원칙)."""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); c.connection.autocommit = True
def dom(code):
    c.execute("select sector from v_stock_sector where code=%s", (code,)); r = c.fetchone(); return r[0] if r else None
air = dom("003490") or "인프라"; logi = dom("000120") or "인프라"
M = {}
for k in "APLD BMNR CIFR COIN CORZ PURR".split(): M[k] = "IT/플랫폼"                       # 암호화폐 → 기존 결정(IT/플랫폼)
for k in "BATRK FOX FOXA FWONK LLYVA LLYVK SIRI SEG TKO PPLI".split(): M[k] = "엔터·미디어"   # 방송·스포츠·콘텐츠
for k in "EXPE TRIP TCOM FUN EDU GHC SGI".split(): M[k] = "소비재"                        # 여행·레저·교육·가구
for k in "AERO DAL LUV UAL".split(): M[k] = air                                        # 항공사 = 국내 대한항공 업종
M["FDX"] = logi; M["SITE"] = "인프라"                                                   # 물류 = 국내 대한통운 업종
for k in "CHYM CRCL HOOD KSPI NATL RWAY BWIN RYAN".split(): M[k] = "금융"               # 핀테크·보험중개
for k in "AMR BMM CLW".split(): M[k] = "화학/소재"                                      # 철강·금속·종이
M["CBRS"] = "반도체"; M["SRTA"] = "바이오"
c.execute("select distinct sector_std from us_master where sector_std is not null"); have = {r[0] for r in c.fetchall()}
c.execute("select distinct sector from v_stock_sector"); dsec = {r[0] for r in c.fetchall()}
out = [f"항공사 기준 업종(대한항공): {air} · 물류(CJ대한통운): {logi}"]
n = 0
for code, s in M.items():
    if s not in dsec: out.append(f"- {code}: '{s}' 은 국내 업종에 없음 → 건너뜀"); continue
    c.execute("update us_master set sector_std=%s,sector_std_src='manual' where code=%s and not is_etf and sector_std is null", (s, code)); n += c.rowcount
out.append(f"배정 {n}종목")
c.execute("select code,coalesce(name_ko,name_en) from us_master where not is_etf and sector_std is null order by code"); r = c.fetchall()
out.append(f"남은 미분류 일반종목 {len(r)}: " + ", ".join(f"{a}({b})" for a, b in r))
c.execute("select sector_std,count(*) from us_master where not is_etf group by 1 order by 2 desc"); out.append("분포: " + ", ".join(f"{a}({b})" for a, b in c.fetchall()))
c.execute("select count(*) from (select distinct sector_std s from us_master where sector_std is not null) x where s not in (select distinct sector from v_stock_sector)"); out.append(f"국내 업종에 없는 해외 업종 수: {c.fetchone()[0]}")
open("sector_new_fix.md", "w", encoding="utf-8").write("\n".join(out)); print("\n".join(out))
