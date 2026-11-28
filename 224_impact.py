import os, psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); o=["# 업종 변경 영향도 점검\n"]
c.execute("select distinct v.sector from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK'"); cur={r[0] for r in c.fetchall()}
c.execute("select max(trade_date) from sector_daily"); d=c.fetchone()[0]
c.execute("select sector,stock_count,rs_rank,rs5_rank from sector_daily where trade_date=%s and market='ALL' order by rs_rank nulls last,sector",(d,)); R=c.fetchall()
o.append(f"## 1. 최신일({d}) sector_daily")
for s,n,r1,r5 in R: o.append(f"- {s}: 종목 {n} · RS순위 {r1} · RS5순위 {r5}{'  ⚠ 현재 분류에 없음(잔존 행)' if s not in cur else ''}")
c.execute("select v.sector,count(*) from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK' group by 1"); act=dict(c.fetchall())
o.append("\n## 2. 종목수 불일치(sector_daily vs 실제 분류, 최신일)")
for s,n,_,_ in R:
    if s in act and act[s]!=n: o.append(f"- {s}: 집계 {n} vs 실제 {act[s]} (거래 정지·가격0 제외 차이일 수 있음)")
o.append("\n## 3. 과거 행의 옛 업종 잔존 (현재 분류에 없는 업종명, 행수·최종일)")
c.execute("select sector,count(*),min(trade_date),max(trade_date) from sector_daily where market='ALL' group by 1")
for s,n,a,b in c.fetchall():
    if s not in cur: o.append(f"- {s}: {n}행 {a}~{b}")
o.append("\n## 4. 변경 업종의 이력 일수(sector_daily)")
for s in ("화장품","엔터·미디어","종합상사","증권","보안","기계","반도체","금융","인프라","화학/소재","소비재","IT/플랫폼"):
    c.execute("select count(*),min(trade_date),max(stock_count),min(stock_count) from sector_daily where sector=%s and market='ALL'",(s,)); o.append(f"- {s}: {c.fetchone()}")
o.append("\n## 5. 'sector' 계열 컬럼을 가진 다른 테이블 중 현재 분류에 없는 값")
c.execute("select table_name,column_name from information_schema.columns where table_schema='public' and column_name ilike '%sector%' and table_name not in ('sector_daily','stocks','sector_override') order by 1")
for t,col in c.fetchall():
    try:
        c.execute(f'select "{col}",count(*) from public."{t}" where "{col}" is not null group by 1'); vals=c.fetchall()
        bad=[(v,n) for v,n in vals if isinstance(v,str) and v not in cur]
        o.append(f"- {t}.{col}: 값 {len(vals)}종 · 현재 분류에 없는 값 {bad[:8]}")
    except Exception as e: c.connection.rollback(); o.append(f"- {t}.{col}: 조회 불가 ({type(e).__name__})")
c.execute("select count(*) from stocks where security_type='STOCK' and coalesce(is_active,true)"); o.append(f"\n활성 국내 일반종목: {c.fetchone()[0]}")
open("impact.md","w").write("\n".join(o))
