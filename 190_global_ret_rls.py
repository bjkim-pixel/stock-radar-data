# -*- coding: utf-8 -*-
"""v_global_ret 를 '로그인한 주인' 권한(authenticated + RLS)으로 조회해 시간·행 수를 점검 — 읽기 전용."""
import os, time, json, psycopg2
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = False; cur = conn.cursor()
L = []
def log(m): print(m, flush=True); L.append(str(m))
cur.execute("select lower(email) from auth.users order by created_at asc limit 1"); em = cur.fetchone()[0]
cur.execute("select rolname, rolconfig from pg_roles where rolname in ('anon','authenticated','authenticator')")
log("역할 설정: " + str(cur.fetchall()))
cur.execute("select has_table_privilege('authenticated','public.v_global_ret','select'), has_table_privilege('anon','public.v_global_ret','select')")
log("뷰 권한(authenticated, anon): " + str(cur.fetchone()))
for role, claims in (("authenticated", {"email": em, "role": "authenticated"}), ("anon", {"role": "anon"})):
    conn.rollback(); cur = conn.cursor()
    cur.execute(f"set local role {role}"); cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
    cur.execute("show statement_timeout"); log(f"[{role}] statement_timeout = {cur.fetchone()[0]}")
    t = time.time()
    try:
        cur.execute("select count(*) from v_global_ret"); n = cur.fetchone()[0]
        log(f"[{role}] v_global_ret {n}행 · {(time.time()-t)*1000:.0f}ms")
    except Exception as e:
        log(f"[{role}] 오류: {str(e)[:200]} · {(time.time()-t)*1000:.0f}ms")
    conn.rollback()
open("global_ret_rls.md", "w", encoding="utf-8").write("\n".join(L))
