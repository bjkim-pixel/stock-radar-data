# -*- coding: utf-8 -*-
"""읽기 전용: 2025년 이전(2026-01-01 미만) 데이터를 지우면 줄어들 용량 추정(행 비율 × 테이블 크기)"""
import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True); cur = c.cursor()
cur.execute("select pg_database_size(current_database())"); total = cur.fetchone()[0]
cur.execute("""select c.relname, pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and pg_total_relation_size(c.oid)>300000 order by 2 desc""")
tabs = cur.fetchall(); tot_save = 0; out = []
for t, sz in tabs:
    cur.execute("""select column_name from information_schema.columns where table_schema='public' and table_name=%s
      and data_type in ('date','timestamp with time zone','timestamp without time zone') and column_name in
      ('trade_date','date','snap_date','d','day','as_of','created_at','at','ts','dt','base_date') order by 1""", (t,))
    cs = [r[0] for r in cur.fetchall()]
    if not cs: out.append(f"| {t} | {sz/1048576:.1f} | (날짜 열 없음) | | |"); continue
    col = cs[0]
    cur.execute(f'select count(*), count(*) filter (where "{col}" < date \'2026-01-01\'), min("{col}")::text, max("{col}")::text from public."{t}"')
    n, old, mn, mx = cur.fetchone(); save = sz * (old / n) if n else 0; tot_save += save
    out.append(f"| {t} | {sz/1048576:.1f} | `{col}` {mn[:10]}~{mx[:10]} | {old:,} / {n:,} | {save/1048576:.1f} |")
print(f"## 2025년 이하 삭제 시 예상 (현재 {total/1048576:.0f} MB)\n")
print("| 테이블 | 크기 MB | 날짜 열·범위 | 2025 이하 행 / 전체 | 예상 감소 MB |\n|---|---:|---|---:|---:|"); print("\n".join(out))
print(f"\n**예상 감소 합계 ≈ {tot_save/1048576:.0f} MB → 삭제 후 약 {(total-tot_save)/1048576:.0f} MB** (행 비율 추정. 실제로 디스크가 줄려면 VACUUM FULL 또는 테이블 재작성이 필요하고, 일반 DELETE 직후엔 대시보드 용량이 바로 안 줄 수 있음)")
