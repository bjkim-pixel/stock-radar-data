# -*- coding: utf-8 -*-
"""매매 보안 기반 DB 설정 — 인자: trade_security | lock_data | unlock_data
   trade_security : 160_trade_security.sql (trade_audit 테이블 + is_owner())  — 기존 화면에 영향 없음
   lock_data      : 161_lock_data_to_login.sql (anon 읽기 차단, 로그인한 주인만 읽기)
   unlock_data    : 161_unlock_data.sql (잠금 되돌리기)
   여러 번 실행해도 안전. 실행 후 anon/주인/타인 권한을 실제로 시험해서 결과를 출력(이메일은 일부만 표시)."""
import os, sys, json, psycopg2

FILES = {"trade_security": "160_trade_security.sql", "lock_data": "161_lock_data_to_login.sql", "unlock_data": "161_unlock_data.sql"}
target = sys.argv[1] if len(sys.argv) > 1 else ""
if target not in FILES: sys.exit("대상: " + " | ".join(FILES))
url = os.environ.get("SUPABASE_DB_URL", "")
if not url: sys.exit("SUPABASE_DB_URL 미설정")
here = os.path.dirname(os.path.abspath(__file__))
sql = open(os.path.join(here, FILES[target]), encoding="utf-8").read()
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor()

def mask(e):
    if not e or "@" not in e: return "?"
    a, d = e.split("@", 1); return a[:1] + "***@" + d

cur.execute("select count(*), min(created_at) from auth.users"); n, _ = cur.fetchone()
cur.execute("select email from auth.users order by created_at asc limit 1"); r = cur.fetchone()
owner = r[0] if r else None
print(f"로그인 계정 수: {n} · 주인(가장 먼저 만든 계정): {mask(owner)}")
if target == "lock_data":
    if n != 1: sys.exit("⚠ 계정이 1개가 아닙니다. Supabase › Authentication › Users 에서 내 계정만 남기고 다시 실행하세요. (잠그지 않음)")
    cur.execute("select to_regprocedure('public.is_owner()')")
    if cur.fetchone()[0] is None: sys.exit("⚠ 먼저 대상 trade_security 를 실행하세요. (잠그지 않음)")

cur.execute(sql)
print(f"{FILES[target]} 실행 완료")

def probe(role, email, query):
    c = psycopg2.connect(url); c.autocommit = False; k = c.cursor()
    try:
        k.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"email": email}) if email else "",))
        k.execute(f"set local role {role}")
        k.execute(query); v = k.fetchone()[0]
        return f"가능 ({v})"
    except Exception as e:
        return "차단 — " + str(e).strip().splitlines()[0][:70]
    finally:
        c.rollback(); c.close()

if target in ("lock_data", "unlock_data", "trade_security"):
    cur.execute("select to_regclass('public.stocks') is not null")
    probe_q = "select count(*) from public.stocks"
    print("· 로그인 없음(anon)   stocks 읽기:", probe("anon", None, probe_q))
    print("· 주인 로그인         stocks 읽기:", probe("authenticated", owner, probe_q))
    print("· 다른 계정 로그인    stocks 읽기:", probe("authenticated", "other@invalid.example", probe_q))
    print("· 로그인 없음(anon)   data_version():", probe("anon", None, "select public.data_version()"))
    print("· 주인 로그인         data_version():", probe("authenticated", owner, "select public.data_version()"))
    if target != "unlock_data":
        print("· 주인 로그인         access_log 읽기(차단이어야 정상):", probe("authenticated", owner, "select count(*) from public.access_log"))
