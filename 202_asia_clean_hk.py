import os, psycopg2
CODES = ["1308.HK"]   # 해풍국제 삭제(사용자 요청)
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True; c = c.cursor()
out = []
for t in ("us_daily", "us_rights", "us_top_asia", "us_master"):
    c.execute(f"delete from {t} where code = any(%s)", (CODES,)); out.append(f"{t}: {c.rowcount}행 삭제")
c.execute("select code from us_master where kis_excd='HKS' and code not in (select code from us_top_asia)"); out.append("목록 외 홍콩 종목 남은 것: " + str(c.fetchall()))
c.execute("select count(*) from us_master where kis_excd='HKS'"); out.append("홍콩 종목 수: " + str(c.fetchone()[0]))
print("\n".join(out)); open("asia_list.md", "w", encoding="utf-8").write("\n".join(out))
