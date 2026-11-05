# -*- coding: utf-8 -*-
"""시장별 투자자 매매동향(코스피·코스닥·코스피200 선물) — 개인·외국인·기관계 순매수(억원)를 market_investor_daily에 적재.
출처: 네이버 증권 모바일 API (m.stock.naver.com/api/index/{KOSPI|KOSDAQ|FUT}/trend) — 당일 값. KIS 시장별 투자자 API와
코스피 외국인 값이 일치함을 확인(-34,010억 vs -34,011억). 선물은 KIS에 공개 집계가 없어 네이버만 사용.
사용: SUPABASE_DB_URL=... python 115_market_investor.py [--report r.md]"""
import os, re, sys, json, datetime, requests, psycopg2
DB_URL = os.environ.get("SUPABASE_DB_URL", "")
H = {"User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Accept": "application/json"}
MK = [("KOSPI", "KOSPI"), ("KOSDAQ", "KOSDAQ"), ("FUT", "FUT")]
lines = []
def log(m=""):
    print(m, flush=True); lines.append(str(m))
def num(v):
    try:
        return int(str(v).replace(",", "").replace("+", ""))
    except ValueError:
        return None
def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    here = os.path.dirname(os.path.abspath(__file__))
    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute(open(os.path.join(here, "115_market_investor.sql"), encoding="utf-8").read()); conn.commit()
    log(f"# 시장별 투자자 매매동향 수집 ({datetime.datetime.now():%Y-%m-%d %H:%M} UTC)")
    n = 0
    for market, code in MK:
        try:
            r = requests.get(f"https://m.stock.naver.com/api/index/{code}/trend", headers=H, timeout=20)
            j = r.json()
            d = datetime.datetime.strptime(j["bizdate"], "%Y%m%d").date()
            p, f, i = num(j.get("personalValue")), num(j.get("foreignValue")), num(j.get("institutionalValue"))
            if None in (p, f, i):
                raise ValueError(f"값 파싱 실패 {j}")
            with conn.cursor() as cur:
                cur.execute("""insert into market_investor_daily (trade_date, market, personal, foreign_net, inst, updated_at)
                               values (%s,%s,%s,%s,%s,now())
                               on conflict (trade_date, market) do update set personal=excluded.personal, foreign_net=excluded.foreign_net,
                                 inst=excluded.inst, updated_at=now()""", (d, market, p, f, i))
            conn.commit(); n += 1
            log(f"- {market} {d}: 개인 {p:+,} · 외국인 {f:+,} · 기관계 {i:+,} (억원)")
        except Exception as ex:
            conn.rollback(); log(f"- ⚠ {market} 실패: {str(ex)[:150]}")
    log(f"- 저장 {n}/3")
    rep = sys.argv[sys.argv.index("--report") + 1] if "--report" in sys.argv else None
    if rep:
        open(rep, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    if n == 0:
        raise SystemExit(1)
if __name__ == "__main__":
    main()
