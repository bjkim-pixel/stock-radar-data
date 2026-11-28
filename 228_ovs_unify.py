import os, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor(); o=[]
c.execute("update us_master set sector_std='인프라',sector_std_src='manual' where not is_etf and sector_std='건설' returning code,coalesce(name_ko,name_en)"); o.append("건설→인프라: "+", ".join(f"{a}({b})" for a,b in c.fetchall()))
c.execute("update us_master set sector_std='IT/플랫폼',sector_std_src='manual' where not is_etf and sector_std='암호화폐·AI인프라' returning code,coalesce(name_ko,name_en)"); o.append("암호화폐·AI인프라→IT/플랫폼: "+", ".join(f"{a}({b})" for a,b in c.fetchall()))
cn.commit()
c.execute("select distinct v.sector from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK'"); dom={r[0] for r in c.fetchall()}
c.execute("select coalesce(sector_std,'(미분류)'),count(*) from us_master where not is_etf group by 1 order by 2 desc"); R=c.fetchall()
o.append("해외 업종 분포: "+", ".join(f"{a}({b})" for a,b in R))
o.append("국내 분류에 없는 해외 업종: "+str([a for a,_ in R if a not in dom]))
open("ovs_unify.md","w").write("\n".join(o))
