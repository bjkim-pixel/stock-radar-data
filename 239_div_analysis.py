# -*- coding: utf-8 -*-
"""고배당 기준 분석(읽기 전용): 한국 고배당 ETF 3개 구성종목의 최근 12개월 배당수익률 분포 + 국내 전체 분포 + 미국 배당 ETF 4개 요약."""
import os, statistics, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# 고배당 기준 분석\n"]
def q(sql, a=None):
    c.execute(sql, a); return c.fetchall()
def pct(v, p):
    v = sorted(v); k = (len(v) - 1) * p; f = int(k); r = k - f
    return v[f] if f + 1 >= len(v) else v[f] * (1 - r) + v[f + 1] * r
Y = {r[0]: float(r[1]) for r in q("""with t as (select code,sum(dps) ttm from stock_dividends where record_date>=current_date-365 and record_date<=current_date and coalesce(stk_kind,'보통')<>'우선' group by 1),
  p as (select distinct on (code) code,close from daily_price where close>0 order by code,trade_date desc)
  select t.code, t.ttm/p.close*100 from t join p using(code)""")}
ETFS = [("161510", "PLUS 고배당주"), ("279530", "KODEX 고배당"), ("210780", "TIGER 코스피고배당")]
O.append("## 1. 한국 고배당 ETF 구성종목의 최근 12개월 배당수익률(보통주, TTM 주당배당/최근 종가)\n")
allv = {}
for code, nm in ETFS:
    h = q("select stock_code,stock_name,weight from etf_holdings_now where etf_code=%s order by rank", (code,))
    if not h: O.append(f"- {nm}({code}): 구성종목 데이터 없음(아직 수집 전)"); continue
    ys = [(sc, sn, float(w or 0), Y.get(sc)) for sc, sn, w in h]
    have = [y for *_, y in ys if y is not None]; miss = [(sc, sn) for sc, sn, w, y in ys if y is None]
    for sc, sn, w, y in ys:
        if y is not None: allv[sc] = y
    O.append(f"### {nm}({code}) · 구성종목 {len(h)}개(KIS 제공 상위 30) · 배당수익률 계산 가능 {len(have)}개")
    if have:
        wsum = sum(w for sc, sn, w, y in ys if y is not None)
        wavg = sum(w * y for sc, sn, w, y in ys if y is not None) / wsum if wsum else 0
        O.append(f"- 분포: 최소 {min(have):.2f}% · 하위25% {pct(have,.25):.2f}% · 중앙값 {pct(have,.5):.2f}% · 상위25% {pct(have,.75):.2f}% · 최대 {max(have):.2f}% · 가중평균 {wavg:.2f}%")
    O.append("- 종목: " + ", ".join(f"{sn} {y:.1f}%" for sc, sn, w, y in ys if y is not None))
    if miss: O.append(f"- 우리 DB에 없거나 배당 이력 없음 {len(miss)}개: " + ", ".join(f"{sn}({sc})" for sc, sn in miss))
if allv:
    v = list(allv.values())
    O.append(f"\n### 3개 ETF 합산(중복 제거 {len(v)}종목): 하위25% {pct(v,.25):.2f}% · 중앙값 {pct(v,.5):.2f}% · 상위25% {pct(v,.75):.2f}% · 평균 {statistics.mean(v):.2f}%")
O.append("\n## 2. 국내 전체 일반종목의 배당수익률 분포(필터 눈금 후보)\n")
base = q("select count(*) from stocks where security_type='STOCK' and coalesce(is_active,true)")[0][0]
vals = sorted(Y.values())
O.append(f"- 국내 일반종목 {base}개 중 최근 12개월 배당 있는 종목 {len(vals)}개 · 중앙값 {pct(vals,.5):.2f}% · 상위25% {pct(vals,.75):.2f}% · 상위10% {pct(vals,.9):.2f}%")
O.append("| 배당수익률 | 종목 수 | 비율 |\n|---|---|---|")
for t in (2, 3, 4, 5, 6, 7, 8, 10):
    n = sum(1 for x in vals if x >= t); O.append(f"| {t}% 이상 | {n} | {n/base*100:.1f}% |")
O.append("\n## 3. 미국 배당 ETF 4개(참고용)\n")
for code in ("SCHD", "VYM", "HDV", "SPYD"):
    r = q("select code,coalesce(name_ko,name_en),last,is_etf from us_master where code=%s", (code,))
    if not r: O.append(f"- {code}: 아직 등록 전"); continue
    ttm = q("select coalesce(sum(cash_per_share),0),count(*) from us_rights where code=%s and base_date>=current_date-365", (code,))[0]
    last = float(r[0][2] or 0)
    O.append(f"- {code} {r[0][1]} · 현재가 {last:.2f} · 최근 12개월 분배 {float(ttm[0]):.3f} ({ttm[1]}회) · 분배율 {float(ttm[0])/last*100 if last else 0:.2f}%")
open("div_analysis.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
