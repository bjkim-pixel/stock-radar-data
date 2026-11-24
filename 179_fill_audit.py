# -*- coding: utf-8 -*-
import os, psycopg2, psycopg2.extras
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True); cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
def q(s, *a): cur.execute(s, a); return cur.fetchall()
for tbl in ("paper_orders", "dry_orders"):
    try: cols = {r["column_name"] for r in q("select column_name from information_schema.columns where table_name=%s", tbl)}
    except Exception as e: print(tbl, e); continue
    if not cols: print(f"## {tbl}: 없음\n"); continue
    print(f"## {tbl} (매수 주문, 2026-11-10~)\n")
    print("상태별:", {r['status']: r['n'] for r in q(f"select status, count(*) n from {tbl} where side='buy' and created_at>='2026-11-10' group by 1")})
    print("\n| 시각(KST) | 종목 | 주문가 | 수량 | 체결 | 상태 | 사유/출처 |\n|---|---|---:|---:|---:|---|---|")
    for r in q(f"select created_at at time zone 'Asia/Seoul' t, code, name, price, qty, filled_qty, status, reason from {tbl} where side='buy' and created_at>='2026-11-10' order by created_at desc limit 40"):
        print(f"| {str(r['t'])[5:16]} | {r['name'] or r['code']} | {r['price']} | {r['qty']} | {r['filled_qty']} | {r['status']} | {r['reason']} |")
    print()
