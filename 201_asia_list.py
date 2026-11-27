import os, psycopg2
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor()
L = []
c.execute("select excd,count(*),min(updated_at),max(updated_at) from us_top_asia group by 1 order by 1"); L.append("## us_top_asia 거래소별\n" + "\n".join(map(str, c.fetchall())))
c.execute("select excd,rnk,code,name_ko,mkt_cap from us_top_asia where excd<>'TSE' order by excd,rnk limit 80"); L.append("\n## 비-도쿄 목록(상위)\n" + "\n".join(map(str, c.fetchall())))
c.execute("select m.code,coalesce(m.name_ko,m.name_en),m.is_etf,m.mkt_cap,(select count(*) from us_daily d where d.code=m.code) from us_master m join us_top_asia t on t.code=m.code where t.excd='TSE' order by t.rnk"); L.append("\n## 도쿄 등록 결과(코드·이름·ETF·시총·일봉수)\n" + "\n".join(map(str, c.fetchall())))
open("asia_list.md", "w", encoding="utf-8").write("\n".join(L))
