# -*- coding: utf-8 -*-
"""액티브 ETF 구성 변화 텔레그램 알림 — 장마감 후 161(구성종목 수집) 다음에 실행.
전일 대비 신규 편입·편출 종목을 ETF 수 기준으로 묶어 보냄. 상위 30 경계 잡음(30위 비중의 1.25배 이하)은 제외.
같은 날짜는 한 번만 보냄(etf_alert_log)."""
import os, requests, psycopg2
TOK, CHAT = os.environ.get("TELEGRAM_BOT_TOKEN", ""), os.environ.get("TELEGRAM_CHAT_ID", "")
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
cur.execute("create table if not exists etf_alert_log (d date primary key, sent_at timestamptz default now())")
cur.execute("revoke all on etf_alert_log from anon, authenticated")
cur.execute("select distinct d from etf_holdings_daily order by d desc limit 2")
ds = [r[0] for r in cur.fetchall()]
if len(ds) < 2: print("비교할 전일 기록 없음 — 건너뜀"); raise SystemExit
d0, dp = ds
cur.execute("select 1 from etf_alert_log where d=%s", (d0,))
if cur.fetchone(): print(f"{d0} 이미 보냄 — 건너뜀"); raise SystemExit
cur.execute("select code,name from etf_master"); NM = dict(cur.fetchall())
cur.execute("select d,etf_code,stock_code,stock_name,weight from etf_holdings_daily where d in (%s,%s)", (d0, dp))
H = {}
for d, e, c, n, w in cur.fetchall(): H.setdefault((d, e), {})[c] = (n, float(w or 0))
def thr(rows): ws = sorted(w for _, w in rows.values()); return ws[0] * 1.25 if len(ws) >= 30 else 0
new, out = {}, {}
for e in {e for (_, e) in H}:
    a, b = H.get((d0, e)), H.get((dp, e))
    if not a or not b: continue
    ta, tb = thr(a), thr(b)
    for c, (n, w) in a.items():
        if c not in b and w > ta: new.setdefault(c, [n, []])[1].append((NM.get(e, e), w))
    for c, (n, w) in b.items():
        if c not in a and w > tb: out.setdefault(c, [n, []])[1].append((NM.get(e, e), w))
def block(D, title):
    L = sorted(D.values(), key=lambda x: (-len(x[1]), -sum(w for _, w in x[1])))[:10]
    if not L: return f"{title}\n• 없음"
    return title + "\n" + "\n".join(f"• {'⭐' if len(l) >= 2 else ''}{n} — {len(l)}개 ETF ({', '.join(e.split(' ', 1)[-1][:14] + f' {w:.1f}%' for e, w in l[:3])}{' 외' if len(l) > 3 else ''})" for n, l in L)
multi = [v[0] for v in new.values() if len(v[1]) >= 2]
msg = (f"📊 액티브 ETF 구성 변화 · {dp:%m/%d}→{d0:%m/%d}\n\n" + block(new, "📥 신규 편입") + "\n\n" + block(out, "📤 편출")
       + (f"\n\n⭐ 2개 이상 ETF가 같은 날 새로 담은 종목: {', '.join(multi)}" if multi else "")
       + "\n\n자세히: 사이트 ETF 허브 → 액티브")
print(msg)
if not (new or out): print("변화 없음 — 보내지 않음"); raise SystemExit
if not (TOK and CHAT): print("텔레그램 설정 없음 — 출력만"); raise SystemExit
r = requests.post(f"https://api.telegram.org/bot{TOK}/sendMessage", data={"chat_id": CHAT, "text": msg}, timeout=20)
print("텔레그램:", r.status_code)
if r.ok: cur.execute("insert into etf_alert_log(d) values (%s) on conflict do nothing", (d0,))
