# -*- coding: utf-8 -*-
"""수집 데이터 이상 점검(읽기 전용) → sw_check_report.md. 문제는 '⚠' 로 표시되고 152_sw_alert.py 가 알림으로 보낸다.
점검: 최신일 종목 수 급감 · 시고저 0값 · 시가총액 단위 이상 · 주말 날짜 행 · 수급 누락 · 전략 계산 최신성 · 글로벌 시황 최신성"""
import os, datetime as dt, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True); cur = c.cursor()
L = ["# 데이터 점검"]; W = []
cur.execute("""select p.trade_date, count(*), count(*) filter (where p.open<=0 or p.high<=0 or p.low<=0),
   count(*) filter (where f.code is null), count(*) filter (where p.market_cap is null or p.market_cap<=0)
   from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
   left join daily_flow f on f.code=p.code and f.trade_date=p.trade_date
   where p.close>0 and p.trade_date>=current_date-20 group by 1 order by 1 desc limit 6""")
r = cur.fetchall()
if not r: W.append("⚠ 최근 20일 가격 데이터가 없습니다")
else:
    d, n, bad, nof, nocap = r[0]; prev = r[1][1] if len(r) > 1 else n
    L.append(f"- 최신 가격일 {d} · {n}종목 (직전 {prev})")
    if (dt.date.today() - d).days > 4: W.append(f"⚠ 가격 최신일이 {d} 입니다(4일 이상 지남)")
    if n < prev * 0.9: W.append(f"⚠ {d} 종목 수가 {n}개로 직전({prev})보다 10% 넘게 줄었습니다")
    if bad: W.append(f"⚠ {d} 시가·고가·저가가 0인 종목 {bad}개")
    _k = dt.datetime.utcnow() + dt.timedelta(hours=9)
    if nof > n * 0.1 and d == _k.date() and _k.hour < 19: L.append(f"- 수급 미확정 {nof}종목(저녁 19시 이전이라 정상)")
    elif nof > n * 0.1: W.append(f"⚠ {d} 수급 데이터가 없는 종목 {nof}개")
    if nocap > n * 0.05: W.append(f"⚠ {d} 시가총액이 비어 있는 종목 {nocap}개")
    for x in r:
        if x[0].weekday() >= 5: W.append(f"⚠ 주말 날짜 {x[0]} 에 가격 행 {x[1]}개")
cur.execute("select max(market_cap), percentile_cont(0.5) within group (order by market_cap) from daily_price where trade_date=(select max(trade_date) from daily_price) and market_cap>0")
mx, md = cur.fetchone()
if mx and (mx > 1e16 or md < 1e8): W.append(f"⚠ 시가총액 단위가 이상합니다(최대 {mx:,.0f} · 중앙값 {md:,.0f})")
cur.execute("select max(trade_date) from sw_daily"); sd = cur.fetchone()[0]
cur.execute("select max(trade_date) from daily_price"); pd_ = cur.fetchone()[0]
L.append(f"- 전략 계산 최신일 {sd} · 가격 최신일 {pd_}")
if sd and pd_ and sd < pd_: W.append(f"⚠ 국면 전략 계산({sd})이 가격({pd_})보다 늦습니다 — 계산 실행 확인")
try:
    cur.execute("select max(trade_date) from global_series_daily where symbol like 'KRMC:%'"); g = cur.fetchone()[0]
    L.append(f"- 시가총액 비중 최신일 {g}")
    if g and pd_ and (pd_ - g).days > 3: W.append(f"⚠ 시가총액 비중 최신일 {g} 이 가격({pd_})보다 3일 넘게 늦습니다")
except Exception as e: L.append(f"- 글로벌 시황 점검 건너뜀: {str(e)[:80]}")
L += W or ["- 이상 없음 ✓"]
open("sw_check_report.md", "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
