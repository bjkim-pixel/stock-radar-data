# -*- coding: utf-8 -*-
import os, requests, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor(); L = []
NH = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}
cur.execute("select code,name from stocks where name like '%%기가비스%%'"); r = cur.fetchall(); L.append(str(r)); code = r[0][0]
fi = requests.get(f"https://m.stock.naver.com/api/stock/{code}/finance/quarter", headers=NH, timeout=20).json().get("financeInfo") or {}
cols = fi.get("trTitleList") or []; L.append("네이버 분기 열: " + ", ".join(f"{x['key']}{'(E)' if x.get('isConsensus')=='Y' else ''}" for x in cols))
rows = {x.get("title"): x.get("columns", {}) for x in fi.get("rowList", [])}
for t in ("매출액", "영업이익", "EPS", "BPS"): L.append(t + ": " + str([(x['key'], (rows.get(t, {}).get(x['key']) or {}).get('value')) for x in cols[-4:]]))
cur.execute("select freq,period,is_est,src,op_profit,eps,bps,updated_at from stock_earnings where code=%s and freq='Q' and period>='202506' order by period", (code,)); L += ["DB " + str(x) for x in cur.fetchall()]
cur.execute("select count(*) from stock_earnings where freq='Q' and period='202609' and is_est"); L.append("202609 예상으로 남은 종목: " + str(cur.fetchone()[0]))
cur.execute("select s.code,s.name,e.updated_at::date from stock_earnings e join stocks s using(code) where e.freq='Q' and e.period='202609' and e.is_est order by 1 limit 80"); L.append("목록: " + ", ".join(f"{a}({b})" for a, b, _ in cur.fetchall()))
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L)); print("\n".join(L))
