import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
c.execute("""select m.code,coalesce(m.name_ko,m.name_en),m.is_etf,m.mkt_cap,(select count(*) from us_daily d where d.code=m.code),m.updated_at::date
  from us_master m where m.kis_excd='HKS' and m.code not in (select code from us_top_asia) order by m.mkt_cap desc nulls last""")
r = c.fetchall()
open("asia_list.md", "w", encoding="utf-8").write(f"## 목록에 없는 홍콩 종목 {len(r)}개\n" + "\n".join(map(str, r)))
