import os, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor(); o=[]
def setsec(code,sec,note):
    c.execute("insert into sector_override(code,sector_override,note) values(%s,%s,%s) on conflict (code) do update set sector_override=excluded.sector_override,note=excluded.note",(code,sec,note))
c.execute("select v.sector from stocks s join v_stock_sector v on v.code=s.code where s.name in ('S-Oil','에스오일','S-OIL') or s.code='010950'"); r=c.fetchone(); so=r[0] if r else None; o.append(f"S-Oil 업종: {so}")
for code,sec in (("049720","금융"),("092130","금융"),("002960",so)):
    if sec: setsec(code,sec,"사용자 지정 신규 등록")
cn.commit()
for code in ("049720","092130","002960"):
    c.execute("select s.code,s.name,s.market,s.is_active,v.sector,(select count(*) from daily_price d where d.code=s.code),(select max(trade_date) from daily_price d where d.code=s.code) from stocks s left join v_stock_sector v on v.code=s.code where s.code=%s",(code,))
    o.append(str(c.fetchone()))
open("new3.md","w").write("\n".join(o))
