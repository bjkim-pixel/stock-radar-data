# -*- coding: utf-8 -*-
"""data/kiwoom_accounts.xlsx → kiwoom_accounts 테이블 upsert (여러 번 실행해도 안전).
엑셀 1행에 'N월 M일' 형태 헤더가 있는 열이 스냅샷 날짜(연도는 월이 줄어들 때 +1, 시작 연도는 B열 날짜의 연도).
'6월 대비' 같은 비율 열은 무시합니다(화면에서 다시 계산)."""
import os, re, sys, datetime as dt
import openpyxl, psycopg2
from psycopg2.extras import execute_values
here = os.path.dirname(os.path.abspath(__file__))
url = os.environ.get("SUPABASE_DB_URL", "")
if not url: sys.exit("SUPABASE_DB_URL 미설정")
default = os.path.join(here, "data", "kiwoom_accounts.csv")
if not os.path.exists(default): default = os.path.join(here, "data", "kiwoom_accounts.xlsx")
path = sys.argv[1] if len(sys.argv) > 1 else default
rows = []
if path.lower().endswith(".csv"):
    # CSV: 1행=날짜(YYYY-MM-DD) 열들, 2행=머리글(종목코드,종목명,6월,8월,…), 3행~=종목. 코드 앞 ' 와 숫자의 쉼표·공백 제거. 6월/8월 비율 열은 무시.
    import csv
    raw = open(path, "rb").read()
    try: txt = raw.decode("utf-8-sig")
    except UnicodeDecodeError: txt = raw.decode("cp949")
    data = list(csv.reader(txt.splitlines()))
    snaps = [(i, dt.date.fromisoformat(h.strip())) for i, h in enumerate(data[0]) if re.fullmatch(r"\s*\d{4}-\d{2}-\d{2}\s*", h or "")]
    if not snaps: sys.exit("1행에서 YYYY-MM-DD 날짜 열을 찾지 못했습니다")
    for r in data[2:]:
        code = (r[0] if r else "").strip().lstrip("'").zfill(6)
        if not re.fullmatch(r"\w{6}", code): continue
        for i, d in snaps:
            t = r[i].replace(",", "").strip() if i < len(r) else ""
            if t.isdigit() and int(t) > 0: rows.append((code, d, int(t), r[1].strip(), None))
else:
    ws = openpyxl.load_workbook(path, data_only=True).active
    hdr = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
    sub = [c.value for c in next(ws.iter_rows(min_row=2, max_row=2))]
    col = {n: i for i, n in enumerate(sub) if n}
    ic, inm, imk = col["종목코드"], col["종목명"], col["시장구분"]
    first = next(ws.iter_rows(min_row=3, max_row=3, values_only=True))
    year = first[col["날짜"]].year if isinstance(first[col["날짜"]], dt.datetime) else dt.date.today().year
    snaps, prev = [], 0
    for i, h in enumerate(hdr):
        m = re.fullmatch(r"\s*(\d+)월\s*(\d+)일\s*", str(h or ""))
        if not m: continue
        mo, d = int(m[1]), int(m[2])
        if mo < prev: year += 1
        prev = mo; snaps.append((i, dt.date(year, mo, d)))
    if not snaps: sys.exit("날짜 헤더('N월 M일')를 찾지 못했습니다")
    for r in ws.iter_rows(min_row=3, values_only=True):
        code = str(r[ic] or "").strip().zfill(6)
        if not re.fullmatch(r"\w{6}", code): continue
        for i, d in snaps:
            v = r[i]
            if isinstance(v, (int, float)) and v > 0: rows.append((code, d, int(v), r[inm], r[imk]))
print("날짜:", [str(d) for _, d in snaps], "행:", len(rows), "종목:", len({x[0] for x in rows}))
conn = psycopg2.connect(url); conn.autocommit = True
cur = conn.cursor()
cur.execute(open(os.path.join(here, "130_kiwoom_accounts.sql"), encoding="utf-8").read())
# 시장 구분이 없는 행(CSV)은 기존 kiwoom_accounts → stocks 테이블 순으로 채움
if any(r[4] is None for r in rows):
    cur.execute("select code, market from stocks where market is not null"); mk = dict(cur.fetchall())
    cur.execute("select distinct on (code) code, market from kiwoom_accounts where market is not null"); mk.update(dict(cur.fetchall()))
    rows = [(c, d, a, n, m if m is not None else mk.get(c)) for c, d, a, n, m in rows]
execute_values(cur, """insert into kiwoom_accounts(code,snap_date,accounts,name,market) values %s
  on conflict (code,snap_date) do update set accounts=excluded.accounts, name=excluded.name, market=coalesce(excluded.market, kiwoom_accounts.market)""", rows, page_size=1000)
cur.execute("select count(*), count(distinct code), max(snap_date) from kiwoom_accounts"); print("DB:", cur.fetchone())
