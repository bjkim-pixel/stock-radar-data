# -*- coding: utf-8 -*-
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# 요청 종목 배당 데이터 점검\n"]
def q(s, a=None):
    c.execute(s, a); return c.fetchall()
mx = q("select max(trade_date) from daily_price")[0][0]; O.append(f"- 최신 시세일 {mx}")
O.append(f"- stocks(STOCK) {q(chr(115)+'elect count(*) from stocks where security_type='+chr(39)+'STOCK'+chr(39))[0][0]}개 · stock_dividends 종목 {q('select count(distinct code) from stock_dividends')[0][0]}개 · 행 {q('select count(*) from stock_dividends')[0][0]}")
for code, nm in (("005930", "삼성전자"), ("005935", "삼성전자우"), ("003690", "코리안리"), ("049720", "고려신용정보"), ("092130", "이크레더블"), ("002960", "한국쉘석유"), ("017800", "현대엘리베이터")):
    st = q("select name,security_type,is_active from stocks where code=%s", (code,))
    px = q("select trade_date,close from daily_price where code=%s order by trade_date desc limit 1", (code,))
    sc = q("select count(*) from v_screener where code=%s and trade_date=%s", (code, mx))[0][0]
    d = q("select record_date,divi_kind,dps,pay_date,stk_kind from stock_dividends where code=%s order by record_date desc limit 8", (code,))
    O.append(f"\n## {nm}({code}) · stocks={st} · 최신시세={px} · v_screener 최신일 행수={sc}")
    for r in d: O.append(f"- {r}")
    if not d: O.append("- (stock_dividends 행 없음)")
open("div_check.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
