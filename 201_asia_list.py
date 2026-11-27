import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
L = []
c.execute("select excd,count(*) from us_top_asia group by 1 order by 1"); L.append("## us_top_asia\n" + "\n".join(map(str, c.fetchall())))
c.execute("""select t.excd,t.rnk,t.code,t.name_ko,coalesce(m.name_ko,m.name_en),(select count(*) from us_daily d where d.code=t.code) from us_top_asia t left join us_master m on m.code=t.code
  where t.sym in ('300059','601985','02020','2020','3382','688825','688981','688256','688041') order by 1,2""")
L.append("\n## 확인 대상(내 목록 이름 vs KIS 이름, 일봉수)\n" + "\n".join(map(str, c.fetchall())))
c.execute("select t.excd,count(*) filter (where m.code is null),count(*) filter (where (select count(*) from us_daily d where d.code=t.code)<150) from us_top_asia t left join us_master m on m.code=t.code group by 1")
L.append("\n## 거래소별(us_master 없음, 일봉 150일 미만)\n" + "\n".join(map(str, c.fetchall())))
open("asia_list.md", "w", encoding="utf-8").write("\n".join(L))
