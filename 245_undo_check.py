# -*- coding: utf-8 -*-
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); O = ["# 되돌리기 결과 확인\n"]
def q(s, a=None):
    c.execute(s, a); return c.fetchall()
O.append(f"- 운영 종목(STOCK) {q(chr(115)+'elect count(*) from stocks where security_type='+chr(39)+'STOCK'+chr(39))[0][0]}개 · 전체 stocks {q('select count(*) from stocks')[0][0]}개")
O.append(f"- 오늘 등록된 종목(first_seen=오늘): {q('select code,name,security_type from stocks where first_seen=current_date order by code')}")
O.append(f"- DB 용량 {q('select pg_size_pretty(pg_database_size(current_database()))')[0][0]}")
O.append(f"- 코리안리·삼성전자우: {q('select code,name,security_type from stocks where code in (%s,%s)', ('003690','005935'))}")
open("undo_check.md", "w", encoding="utf-8").write("\n".join(O)); print("\n".join(O))
