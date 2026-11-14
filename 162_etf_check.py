# -*- coding: utf-8 -*-
"""ETF 상세 데이터 검증(읽기 전용): 보유금액 환산(상장좌수×CU수량×가격) 합 vs 순자산·비중, 관리 ETF 행 수."""
import os,psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor();L=["# ETF 상세 데이터 검증\n"]
c.execute("""select i.code,m.name,i.ntas_eok,i.listed,i.cu_unit,i.cfg_cnt,count(h.*),round(sum(h.amount)/1e8,1),round(sum(h.weight),2),
  round(100*sum(h.amount)/1e8/nullif(i.ntas_eok,0),1)
  from etf_info i join etf_master m on m.code=i.code left join etf_holdings_now h on h.etf_code=i.code
  where m.watch_grp is not null group by 1,2,3,4,5,6 order by m.watch_ord""")
L.append("| 코드 | 이름 | 순자산(억) | 상장좌수 | CU | 구성수 | 행 | 보유금액합(억) | 비중합% | 금액합/순자산% |\n|---|---|---|---|---|---|---|---|---|---|")
for r in c.fetchall(): L.append("| "+" | ".join(str(x) for x in r)+" |")
c.execute("select etf_code,stock_name,weight,cu_qty,shares,round(amount/1e8,1),price from etf_holdings_now where etf_code='0163Y0' order by rank limit 5")
L.append("\n## 0163Y0 상위 5\n"+"\n".join(str(r) for r in c.fetchall()))
open("etf_check.md","w",encoding="utf-8").write("\n".join(L));print("\n".join(L))
