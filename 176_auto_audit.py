# -*- coding: utf-8 -*-
"""읽기 전용 점검: 전략 목록·가상↔실전 설정 차이·드라이런 진행. (쓰기 없음, 비밀값 출력 없음)"""
import os, json, psycopg2, psycopg2.extras
conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.set_session(readonly=True, autocommit=True)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
def q(sql, *a): cur.execute(sql, a); return cur.fetchall()
cols = {r["column_name"] for r in q("select column_name from information_schema.columns where table_name='auto_strategies'")}
print("## 전략 목록 (auto_strategies 열:", ", ".join(sorted(cols)), ")\n")
rows = q("select * from auto_strategies where not archived order by kind, id")
for r in rows:
    p = r["params"] or {}
    print(f"- `{r['id']}` **{r['name']}** · {r['kind']} · 켜짐={r['enabled']} · v{r['version']} · 모드={p.get('execMode','paper')} · 승인={p.get('approval') or p.get('closeBuyApproval')} · 실전자동승인={p.get('liveAutoOk')} · dryDays={p.get('dryDays')} · source={r.get('source')}")
print("\n## 짝(원본→실전) 설정 차이\n")
byid = {r["id"]: r for r in rows}
pairs = [(byid[r["source"]], r) for r in rows if r.get("source") and r["source"] in byid]
if not pairs: print("source 로 연결된 짝이 없습니다.")
for a, b in pairs:
    pa, pb = a["params"] or {}, b["params"] or {}
    diff = {k: (pa.get(k), pb.get(k)) for k in sorted(set(pa) | set(pb)) if pa.get(k) != pb.get(k)}
    print(f"### {a['name']} (`{a['id']}`) ↔ {b['name']} (`{b['id']}`) — 다른 항목 {len(diff)}개\n")
    for k, (x, y) in diff.items(): print(f"- `{k}`: 원본 `{json.dumps(x, ensure_ascii=False)}` / 실전 `{json.dumps(y, ensure_ascii=False)}`")
    print()
print("## 드라이런 기록(auto_config.dryrun)\n")
for r in q("select value from auto_config where key='dryrun'"): print("```json\n"+json.dumps(r["value"], ensure_ascii=False, indent=1)+"\n```")
print("\n## 스위치(auto_config.main: on/liveOn만)\n")
for r in q("select value from auto_config where key='main'"):
    v = r["value"] or {}; print({k: v.get(k) for k in ("on", "liveOn")})
print("\n## 최근 실행 기록(auto_runs) 전략×거래일\n")
for r in q("select strategy_id, trade_date from auto_runs where trade_date>='2026-11-10' order by strategy_id, trade_date"):
    pass
rs = q("select strategy_id, array_agg(trade_date::text order by trade_date) d from auto_runs where trade_date>='2026-11-10' group by 1 order by 1")
for r in rs: print(f"- `{r['strategy_id']}`: {', '.join(r['d'])}")
