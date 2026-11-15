# -*- coding: utf-8 -*-
"""거래 감사 기록(trade_audit) 읽기 전용 점검 — 최근 4일 세션 열림·로그인 실패·거부 이벤트(IP·기기·시각)."""
import os,psycopg2
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur=conn.cursor()
out=["# trade_audit 점검 (KST)\n"]
cur.execute("select to_char(ts at time zone 'Asia/Seoul','MM-DD HH24:MI:SS'),event,ok,mode,ip,left(coalesce(ua,''),90) from trade_audit where ts>now()-interval '4 days' and event not in ('paper_plan') order by ts")
rows=cur.fetchall(); out.append(f"최근 4일 {len(rows)}건\n\n| 시각 | 이벤트 | ok | 모드 | IP | UA |\n|---|---|---|---|---|---|")
for r in rows: out.append("| "+" | ".join(str(x) for x in r)+" |")
cur.execute("select ip,count(*),min(to_char(ts at time zone 'Asia/Seoul','MM-DD HH24:MI')),max(to_char(ts at time zone 'Asia/Seoul','MM-DD HH24:MI')),count(*) filter (where event='session_open') from trade_audit where ts>now()-interval '30 days' group by 1 order by 3")
out.append("\n## 30일 IP별 요약 (IP, 건수, 처음, 마지막, 세션열림)\n")
for r in cur.fetchall(): out.append("- "+" · ".join(str(x) for x in r))
cur.execute("select to_char(ts at time zone 'Asia/Seoul','MM-DD HH24:MI'),event,ip from trade_audit where event in ('live_order','live_cancel','live_modify','live_plan','paper_order') and ts>now()-interval '4 days' order by ts")
out.append("\n## 최근 4일 주문 관련 이벤트\n"); out+=["- "+" · ".join(str(x) for x in r) for r in cur.fetchall()] or ["- 없음"]
open("audit_check.md","w",encoding="utf-8").write("\n".join(out)); print("\n".join(out)[:3000])
