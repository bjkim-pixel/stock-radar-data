# -*- coding: utf-8 -*-
import os, psycopg2
c=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); o=["# 배당 관련 보유 데이터 점검 (읽기 전용)\n"]
def q(sql,a=None):
    try: c.execute(sql,a); return c.fetchall()
    except Exception as e: c.connection.rollback(); o.append(f"  (조회 실패: {type(e).__name__} {str(e)[:100]})"); return []
r=q("select count(*),count(distinct code),min(record_date),max(record_date) from stock_dividends"); o.append(f"## 1. 국내 종목 배당(stock_dividends, KIS 예탁원): 행·종목·기간 = {r}")
r=q("select divi_kind,count(*) from stock_dividends where record_date>=current_date-365 group by 1 order by 2 desc"); o.append(f"- 최근 12개월 배당 종류별 행: {r}")
r=q("select count(*) from (select code from stock_dividends where record_date>=current_date-365 group by 1 having count(*)>=3) t"); o.append(f"- 최근 12개월 3회 이상 지급(분기·중간 포함) 종목: {r[0][0] if r else '?'}")
r=q("select count(*) filter (where dps is not null),count(*) from stock_earnings where dps is not null or true"); o.append(f"- 네이버 DPS(stock_earnings.dps) 채움: {r}")
Y=q("""with t as (select d.code,sum(d.dps) ttm,count(*) n from stock_dividends d where d.record_date>=current_date-365 and d.record_date<=current_date group by 1),
 p as (select distinct on (code) code,close from daily_price order by code,trade_date desc)
 select s.code,s.name,v.sector,round(t.ttm),t.n,round(t.ttm/p.close*100,2) y from t join p using(code) join stocks s using(code) left join v_stock_sector v on v.code=s.code where s.security_type='STOCK' and p.close>0 order by y desc limit 25""")
o.append("\n## 2. 국내 종목 최근 12개월 배당수익률 상위 25 (TTM 주당배당/최근 종가)")
for code,nm,sec,ttm,n,y in Y: o.append(f"- {nm}({code}) {sec} · 연 {n}회 · 주당 {ttm}원 · {y}%")
r=q("select count(*) from stocks s where security_type='STOCK' and coalesce(is_active,true)"); tot=r[0][0] if r else 0
r=q("select count(distinct d.code) from stock_dividends d join stocks s on s.code=d.code where s.security_type='STOCK' and d.record_date>=current_date-365"); o.append(f"- 국내 일반종목 {tot}개 중 최근 12개월 배당 있는 종목: {r[0][0] if r else '?'}")
E=q("""select m.code,m.name,coalesce(m.field,''),coalesce(m.subfield,''),i.div_cycle,i.ntas_eok,(select count(*) from etf_dividends e where e.code=m.code and e.record_date>=current_date-365) n,
  (select sum(rate) from etf_dividends e where e.code=m.code and e.record_date>=current_date-365) rt
  from etf_master m left join etf_info i on i.code=m.code where m.name ~ '배당|인컴|커버드콜|월배당|분배|디비던드|리츠|고배당|배당성장|프리미엄' order by i.ntas_eok desc nulls last""")
o.append(f"\n## 3. 국내 ETF 중 배당·인컴 성격(이름 기준) {len(E)}개 (코드 이름 | 분야 | 분배주기코드 | 순자산억 | 12M분배횟수 | 12M분배율합%)")
for code,nm,f,sf,dc,nt,n,rt in E: o.append(f"- {code} {nm} | {f}/{sf} | {dc} | {nt} | {n} | {rt}")
r=q("select count(*),count(distinct code),max(record_date) from etf_dividends"); o.append(f"- etf_dividends 전체: {r}")
r=q("select count(*) from etf_master"); o.append(f"- 우리 DB 국내 ETF 총 {r[0][0] if r else '?'}개")
U=q("""select m.code,coalesce(m.name_ko,m.name_en),m.kis_excd,m.is_etf,m.last,
 (select count(*) from us_rights r where r.code=m.code and r.base_date>=current_date-365) n,
 (select sum(cash_per_share) from us_rights r where r.code=m.code and r.base_date>=current_date-365) ttm
 from us_master m where m.last>0 order by 1""")
o.append("\n## 4. 해외(us_master + us_rights 배당)")
r=q("select count(*),count(distinct code),min(base_date),max(base_date) from us_rights"); o.append(f"- us_rights(배당): 행·종목·기간 = {r}")
Ue=[(c1,n1,ex,etf,last,n,ttm) for c1,n1,ex,etf,last,n,ttm in U if ttm and last]
yl=sorted([(float(ttm)/float(last)*100,c1,n1,ex,etf,n,ttm) for c1,n1,ex,etf,last,n,ttm in Ue],reverse=True)
o.append(f"- 최근 12개월 배당 있는 해외 종목·ETF: {len(Ue)}개 / 전체 {len(U)}개")
o.append("- 해외 ETF 중 이름이 배당성격(영문/한글): ")
names=q("select code,coalesce(name_ko,name_en),kis_excd from us_master where is_etf and (coalesce(name_ko,'')||coalesce(name_en,'')) ~* '배당|인컴|dividend|income|yield|covered|premium|SCHD|high div'")
o.append("  "+", ".join(f"{a}({b})" for a,b,_ in names))
o.append("- 해외 12M 배당수익률 상위 25 (최근 12개월 주당배당 합/현재가, 통화 무관 비율)")
for y,code,nm,ex,etf,n,ttm in yl[:25]: o.append(f"  - {code} {nm} {ex}{' ETF' if etf else ''} · 연 {n}회 · {y:.2f}%")
r=q("select code,coalesce(name_ko,name_en),(select count(*) from us_rights r where r.code=m.code),m.last from us_master m where code in ('SCHD','VYM','JEPI','JEPQ','HDV','DVY','VIG','DGRO','SPYD','QYLD','O','KO','PEP','JNJ','XOM','T','VZ','PFE') order by 1"); o.append(f"- 대표 배당 종목·ETF 보유 여부: {r}")
r=q("select jsonb_object_keys(info) k from us_master where info is not null limit 1"); 
r=q("select k from (select distinct jsonb_object_keys(info) k from us_master where info is not null) t where k ~* 'div|yld|yield|배당'"); o.append(f"- us_master.info 최상위 키 중 배당 관련: {r}")
r=q("select jsonb_object_keys(info->'pd') from us_master where info->'pd' is not null limit 400"); ks=sorted({x[0] for x in r}); o.append("- info.pd(현재가상세) 키: "+", ".join(ks))
r=q("select jsonb_object_keys(info->'si') from us_master where info->'si' is not null limit 400"); ks=sorted({x[0] for x in r}); o.append("- info.si(상품기본정보) 키: "+", ".join(ks))
open("div_inventory.md","w").write("\n".join(o))
