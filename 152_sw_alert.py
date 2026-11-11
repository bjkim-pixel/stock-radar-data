# -*- coding: utf-8 -*-
"""국면 전략 알림(ntfy). 환경변수 NTFY_TOPIC 이 없으면 아무것도 보내지 않는다.
보내는 경우: ① 매수 허용 전환 · ① 오늘 조건 충족 종목 · ② 인버스 신규 신호 · 데이터 점검 경고(153이 만든 sw_check_report.md).
같은 날 같은 종류는 sw_alert_log 로 한 번만 보낸다."""
import os, sys, json, requests, psycopg2
import datetime as _dt
_kst = _dt.datetime.utcnow() + _dt.timedelta(hours=9)
if _kst.hour * 60 + _kst.minute < 15 * 60 + 45:      # 장중 계산분은 종가 전 잠정치 — 신호가 바뀔 수 있어 알리지 않는다
    print("장중(15:45 이전) 계산분 — 알림 건너뜀"); sys.exit(0)
topic = os.environ.get("NTFY_TOPIC", "").strip()
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("create table if not exists public.sw_alert_log(key text primary key, sent_at timestamptz not null default now())")
cur.execute("alter table public.sw_alert_log enable row level security")
def send(key, title, msg, prio=3):
    cur.execute("select 1 from sw_alert_log where key=%s", (key,))
    if cur.fetchone(): return print("이미 보냄:", key)
    if not topic: return print("NTFY_TOPIC 없음 — 보내지 않음:", title, msg)
    r = requests.post("https://ntfy.sh/", data=json.dumps({"topic": topic, "title": title, "message": msg, "priority": prio, "tags": ["chart_with_upwards_trend"]}), timeout=20)
    print(key, r.status_code)
    if r.ok: cur.execute("insert into sw_alert_log(key) values(%s) on conflict do nothing", (key,))
cur.execute("select trade_date,gate_open,n_new,inv_signal,inv_hold,inv_left,kospi,pos20 from sw_daily order by trade_date desc limit 2")
rows = cur.fetchall()
if rows:
    t = rows[0]; p = rows[1] if len(rows) > 1 else None; d = t[0]
    if p and t[1] != p[1]:
        send(f"{d}:gate", "① 매수 허용 전환" if t[1] else "① 매수 보류 전환", f"{d} 코스피 {float(t[6]):,.0f} · 박스 위치 {float(t[7])*100:.0f}% → {'30% 위로 올라 신규 매수 허용' if t[1] else '30% 아래로 내려 신규 매수 보류'}", 4)
    if t[1] and t[2]:
        cur.execute("select s.name from sw_picks k join stocks s on s.code=k.code where k.trade_date=%s and k.kind='new' order by k.weight desc nulls last limit 8", (d,))
        names = ", ".join(r[0] for r in cur.fetchall())
        send(f"{d}:new", f"① 오늘 매수 대상 {t[2]}종목", f"{d} 종가 매수 · 3거래일 보유\n{names}\n(20시 마감 전 확인)", 4)
    if t[3]:
        send(f"{d}:inv", "② 인버스 신규 신호", f"{d} 하락 추세에서 3일간 4% 이상 반등 → KODEX 인버스 종가 매수, 5거래일 보유", 5)
if os.path.exists("sw_check_report.md"):
    txt = open("sw_check_report.md", encoding="utf-8").read()
    if "⚠" in txt:
        import datetime as dt
        send(f"{dt.date.today()}:check:{hash(txt)%100000}", "데이터 점검 경고", "\n".join(l for l in txt.splitlines() if "⚠" in l)[:900], 4)
