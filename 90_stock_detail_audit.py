# -*- coding: utf-8 -*-
"""종목상세 데이터 정합성 점검 (읽기 전용) → 마크다운 리포트."""
import os, sys, datetime
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("SUPABASE_DB_URL 필요")
OUT = sys.argv[1] if len(sys.argv) > 1 else "audit_report.md"
L = []
def p(s=""): L.append(s); print(s)
def tbl(cols, rows, n=15):
    if not rows: p("_이상 없음_"); return
    p("| " + " | ".join(cols) + " |"); p("|" + "---|" * len(cols))
    for r in rows[:n]: p("| " + " | ".join("" if v is None else str(v) for v in r) + " |")
    if len(rows) > n: p(f"… 외 {len(rows)-n}건")

with psycopg2.connect(DB_URL) as conn, conn.cursor() as c:
    def q(sql, a=None):
        c.execute(sql, a or ()); return c.fetchall()
    last = q("select max(trade_date) from daily_price")[0][0]
    p(f"# 종목상세 데이터 점검 · 기준일 {last}\n")

    p("## 1. 최근일 커버리지 (STOCK 종목)")
    r = q("""select count(*), count(*) filter (where p.market_cap is null or p.market_cap<=0),
        count(*) filter (where p.change_pct is null), count(*) filter (where p.weight_per_share is null),
        count(*) filter (where f.code is null), count(*) filter (where g.code is null)
        from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
        left join daily_flow f on f.code=p.code and f.trade_date=p.trade_date
        left join daily_program g on g.code=p.code and g.trade_date=p.trade_date
        where p.trade_date=%s and p.close>0""", (last,))[0]
    tbl(["종목수","시총없음","등락률NULL","무게NULL","수급행없음","프로그램행없음"], [r])

    p("\n## 2. 등락률 = 종가/직전종가-1 불일치 (최근 5거래일, 오차>0.1%p)")
    tbl(["code","date","저장 등락률","재계산"], q("""
      with x as (select code,trade_date,close,change_pct,
         lag(close) over (partition by code order by trade_date) pc from daily_price where close>0)
      select code,trade_date,round(change_pct::numeric,2),round(((close::numeric/pc-1)*100),2) from x
      where pc>0 and trade_date>=(select (array_agg(d order by d desc))[5] from (select distinct trade_date d from daily_price) t)
        and abs(change_pct-((close::numeric/pc-1)*100))>0.1 order by abs(change_pct-((close::numeric/pc-1)*100)) desc limit 100"""))

    p("\n## 3. 상장주식수(시총÷종가) 전일 대비 ±30% 이상 변동 (최근 10일)")
    tbl(["code","date","전일 주식수","당일 주식수"], q("""
      with x as (select code,trade_date,market_cap::numeric/nullif(close,0) sh,
         lag(market_cap::numeric/nullif(close,0)) over (partition by code order by trade_date) psh from daily_price where close>0)
      select code,trade_date,round(psh),round(sh) from x
      where psh>0 and abs(sh/psh-1)>0.3 and trade_date>=(select (array_agg(d order by d desc))[10] from (select distinct trade_date d from daily_price) t)
      order by trade_date desc limit 100"""))

    p("\n## 4. 무게/주식수 재계산 불일치 (최근일, 상대오차>5%)")
    tbl(["code","저장","재계산(%)"], q("""
      select p.code, p.weight_per_share, round((p.change_pct*p.volume/nullif(p.market_cap::numeric/p.close,0))::numeric/100,6)
      from daily_price p where p.trade_date=%s and p.close>0 and p.weight_per_share is not null and p.market_cap>0
        and abs(p.weight_per_share - (p.change_pct*p.volume/(p.market_cap::numeric/p.close))/100) >
            0.05*greatest(abs(p.weight_per_share),0.0001) limit 100""", (last,)))
    p("_(저장값이 등락률(%)×거래량÷주식수 또는 비율 단위 중 어느 쪽인지에 따라 재계산 단위가 다를 수 있어, 대량 불일치면 단위 차이로 판단)_")

    p("\n## 5. 거래대금 vs 종가×거래량 (최근일, 비율 <0.3 또는 >3)")
    tbl(["code","거래대금","종가×거래량"], q("""
      select code,trade_amount,round(close::numeric*volume) from daily_price
      where trade_date=%s and close>0 and volume>0 and trade_amount>0
        and (trade_amount/(close::numeric*volume)<0.3 or trade_amount/(close::numeric*volume)>3) limit 100""", (last,)))

    p("\n## 6. 수급 단위/이상치 (최근 5거래일)")
    p("**|주체 순매수| > 거래대금×1.2** (단위 오류 의심)")
    tbl(["code","date","외국인","기관","개인","거래대금"], q("""
      select f.code,f.trade_date,f.foreign_net,f.inst_net,f.individual_net,p.trade_amount
      from daily_flow f join daily_price p on p.code=f.code and p.trade_date=f.trade_date
      where f.trade_date>=(select (array_agg(d order by d desc))[5] from (select distinct trade_date d from daily_flow) t)
        and p.trade_amount>0 and greatest(abs(f.foreign_net),abs(f.inst_net),abs(f.individual_net))>p.trade_amount*1.2 limit 100"""))
    p("\n**외국인+기관+개인+기타법인 합 ≠ 0 (거래대금 대비 5%↑, 최근일)**")
    tbl(["code","합","거래대금"], q("""
      select f.code, coalesce(f.foreign_net,0)+coalesce(f.inst_net,0)+coalesce(f.individual_net,0)+coalesce(f.corp_other_net,0), p.trade_amount
      from daily_flow f join daily_price p on p.code=f.code and p.trade_date=f.trade_date
      where f.trade_date=%s and p.trade_amount>0
        and abs(coalesce(f.foreign_net,0)+coalesce(f.inst_net,0)+coalesce(f.individual_net,0)+coalesce(f.corp_other_net,0))>p.trade_amount*0.05 limit 100""", (last,)))
    p("\n**기관합계 vs 세부(금융투자+투신+연기금+사모) 차이 (거래대금 대비 10%↑, 최근일 — 은행·보험 등 미포함이라 일부 차이는 정상)**")
    tbl(["code","기관","세부합","거래대금"], q("""
      select f.code,f.inst_net,coalesce(f.fin_inv_net,0)+coalesce(f.inv_trust_net,0)+coalesce(f.pension_net,0)+coalesce(f.pe_net,0),p.trade_amount
      from daily_flow f join daily_price p on p.code=f.code and p.trade_date=f.trade_date
      where f.trade_date=%s and p.trade_amount>0
        and abs(f.inst_net-(coalesce(f.fin_inv_net,0)+coalesce(f.inv_trust_net,0)+coalesce(f.pension_net,0)+coalesce(f.pe_net,0)))>p.trade_amount*0.1
      order by abs(f.inst_net-(coalesce(f.fin_inv_net,0)+coalesce(f.inv_trust_net,0)+coalesce(f.pension_net,0)+coalesce(f.pe_net,0)))/p.trade_amount desc limit 100""", (last,)))
    p("\n**프로그램 순매수 |값| > 거래대금×1.2 (최근 30일)**")
    tbl(["code","date","프로그램순매수","거래대금"], q("""
      select g.code,g.trade_date,g.pgtr_net_amt,p.trade_amount from daily_program g
      join daily_price p on p.code=g.code and p.trade_date=g.trade_date
      where g.trade_date>=%s::date-30 and p.trade_amount>0 and abs(g.pgtr_net_amt)>p.trade_amount*1.2 limit 100""", (last,)))

    p("\n## 7. 이평선 계산 영향: 최근 130거래일 중 일봉 누락 종목")
    tbl(["code","행수","기대"], q("""
      with d as (select distinct trade_date from daily_price order by trade_date desc limit 130)
      select p.code,count(*),130 from daily_price p join d using(trade_date) join stocks s on s.code=p.code and s.security_type='STOCK'
      where p.close>0 group by p.code having count(*)<130 and min(p.trade_date)<=(select min(trade_date) from d)
      order by 2 limit 100"""))

    p("\n## 8. 위쪽 매물대: 종목후보 저장값(above_high_supply_eok) vs 종목상세 방식 재계산 (시총 상위 15)")
    rows = q("""select m.code, s.name, m.above_high_supply_eok from daily_metrics m join stocks s on s.code=m.code
        where m.trade_date=%s and m.above_high_supply_eok is not null order by (select market_cap from daily_price x where x.code=m.code and x.trade_date=m.trade_date) desc nulls last limit 15""", (last,))
    out = []
    for code, name, stored in rows:
        c.execute("select trade_date, close, coalesce(individual_net,0) from v_stock_chart where code=%s order by trade_date", (code,))
        data = c.fetchall()
        cur = float(data[-1][1]); cut = last - datetime.timedelta(days=400)
        rs = [(float(cl), float(n)) for d, cl, n in data if d >= cut]
        hi = max(x[0] for x in rs); val = 0.0
        if hi > cur:
            bk = [0.0]*24
            for cl, n in rs:
                if cl > cur: bk[min(23, max(0, int((cl-cur)/(hi-cur)*24)))] += n
            val = sum(v for v in bk if v > 0)/1e8
        flag = "" if abs(val-float(stored)) <= max(1, abs(float(stored))*0.02) else "⚠"
        out.append((name, code, stored, round(val, 2), flag))
    tbl(["종목","code","저장값(억)","재계산(억)","차이"], out)
    p("\n## 9. 데이터 보유 시작일 (이평·누적 계산 한계)")
    tbl(["테이블","최초일","최근일"], [("daily_price",)+q("select min(trade_date),max(trade_date) from daily_price")[0],
        ("daily_flow",)+q("select min(trade_date),max(trade_date) from daily_flow")[0],
        ("daily_program",)+q("select min(trade_date),max(trade_date) from daily_program")[0]])

open(OUT, "w", encoding="utf-8").write("\n".join(L))
