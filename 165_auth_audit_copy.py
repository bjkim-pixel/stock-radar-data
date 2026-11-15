# -*- coding: utf-8 -*-
"""사이트 로그인(Supabase Auth) 기록을 우리 테이블 auth_audit 로 복사 — 보안 요약·보안 로그용.
auth.audit_log_entries(로그인·로그아웃·비밀번호 변경 등)는 보관 기간이 짧아 매일 복사해 400일 보관. relay(service_role)만 읽음.
여러 번 실행해도 안전(id 기준 중복 무시)."""
import os,psycopg2
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute("""create table if not exists auth_audit (id text primary key, ts timestamptz not null, action text, ip text, actor text);
create index if not exists idx_auth_audit_ts on auth_audit (ts desc);
alter table auth_audit enable row level security;
do $$ begin revoke all on auth_audit from anon, authenticated; exception when others then null; end $$;""")
cur.execute("""insert into auth_audit(id,ts,action,ip,actor)
  select id::text, created_at, payload->>'action', ip_address, left(coalesce(payload->>'actor_username',''),3)||'***'
  from auth.audit_log_entries where created_at > now() - interval '5 days' on conflict (id) do nothing""")
n1=cur.rowcount
# 호스팅 Supabase 는 audit_log_entries 를 거의 안 채움 → 로그인 세션(auth.sessions: 생성시각·IP·브라우저)도 로그인 기록으로 복사(로그아웃하면 행이 지워지므로 매일 복사)
cur.execute("""insert into auth_audit(id,ts,action,ip,actor)
  select 'sess:'||id::text, created_at, 'login', host(ip), left(coalesce(user_agent,''),120) from auth.sessions where created_at > now() - interval '5 days' on conflict (id) do nothing""")
print("새로 복사: audit_log",n1,"· sessions",cur.rowcount)
cur.execute("delete from auth_audit where ts < now() - interval '400 days'")
cur.execute("select action,count(*),max(to_char(ts at time zone 'Asia/Seoul','MM-DD HH24:MI')) from auth_audit where ts>now()-interval '2 days' group by 1 order by 2 desc")
for r in cur.fetchall(): print(" ",r)
