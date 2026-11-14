# -*- coding: utf-8 -*-
"""ETF 상세 페이지 데이터 수집: etf_master 전체(120) → etf_info · etf_holdings_now · etf_dividends,
관리 액티브(watch_grp 있음) → etf_holdings_weekly(상위 20, 같은 주는 마지막 영업일 값으로 덮어씀).
107_etf_collect.py(일봉) 다음에 실행. 기준일(as_of)은 etf_daily 최신 거래일.
읽기: KIS ETF 현재가(FHPST02400000)·구성종목시세(FHKST121600C0)·예탁원 배당(HHKDB669102C0). 쓰기: 위 4개 테이블만."""
import os,sys,time,datetime,importlib,requests,psycopg2
from psycopg2.extras import execute_values
HERE=os.path.dirname(os.path.abspath(__file__))
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.1)
    for _ in range(3):
        try: return requests.get(B+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"}).json()
        except Exception: time.sleep(1.5)
    return {}
def f(x):
    try: return float(str(x).replace(",",""))
    except Exception: return None
def d8(s):
    s=(s or "").replace("/","").replace("-","").strip()
    try: return datetime.datetime.strptime(s,"%Y%m%d").date() if len(s)==8 and s!="00000000" else None
    except Exception: return None
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=False; cur=conn.cursor()
cur.execute(open(os.path.join(HERE,"161_etf_detail.sql"),encoding="utf-8").read()); cur.execute("alter table etf_master add column if not exists nxt_ok boolean"); conn.commit()
cur.execute("select max(trade_date) from etf_daily"); AS_OF=cur.fetchone()[0]
cur.execute("select code,name,watch_grp,mgmt from etf_master order by code"); ETFS=cur.fetchall()
wk0=AS_OF-datetime.timedelta(days=AS_OF.weekday()); wk1=wk0+datetime.timedelta(days=6)
print(f"ETF {len(ETFS)}개 · 기준일 {AS_OF} (주 {wk0}~{wk1})",flush=True)
T=datetime.date.today(); nh=nw=nd=nn=nd2=0; empty=[]
for code,name,wg,mg in ETFS:
    e=kget("/uapi/etfetn/v1/quotations/inquire-price","FHPST02400000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code}).get("output") or {}
    c=kget("/uapi/etfetn/v1/quotations/inquire-component-stock-price","FHKST121600C0",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_COND_SCR_DIV_CODE":"11216"})
    o1=c.get("output1") or {}; o2=[x for x in (c.get("output2") or []) if x.get("stck_shrn_iscd")]
    listed=f(e.get("lstn_stcn")) or f(e.get("etf_crcl_stcn")); cu=f(o1.get("etf_cu_unit_scrt_cnt")) or f(e.get("etf_cu_unit_scrt_cnt"))
    cur.execute("""insert into etf_info(code,as_of,etf_type,div_name,idx_name,mgr,mult,div_cycle,list_date,nav,dprt,ntas_eok,listed,cfg_cnt,cu_unit,updated_at)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) on conflict(code) do update set as_of=excluded.as_of,etf_type=excluded.etf_type,div_name=excluded.div_name,
      idx_name=excluded.idx_name,mgr=excluded.mgr,mult=excluded.mult,div_cycle=excluded.div_cycle,list_date=excluded.list_date,nav=excluded.nav,dprt=excluded.dprt,
      ntas_eok=excluded.ntas_eok,listed=excluded.listed,cfg_cnt=excluded.cfg_cnt,cu_unit=excluded.cu_unit,updated_at=now()""",
      (code,AS_OF,e.get("bstp_kor_isnm"),e.get("etf_div_name"),(e.get("etf_rprs_bstp_kor_isnm") or "").strip() or None,(e.get("mbcr_name") or "").replace("(ETF)","").strip() or None,
       f(e.get("etf_trc_ert_mltp")),int(f(e.get("etf_dvdn_cycl")) or 0) or None,d8(e.get("stck_lstn_date")),f(e.get("nav")),f(e.get("dprt")),f(e.get("etf_ntas_ttam")),
       int(listed) if listed else None,int(f(o1.get("etf_cnfg_issu_cnt") or e.get("etf_cnfg_issu_cnt")) or 0) or None,int(cu) if cu else None))
    rows=[]
    for i,x in enumerate(o2,1):
        q=f(x.get("etf_cu_unit_scrt_cnt")); p=f(x.get("stck_prpr"))
        sh=round(q*listed/cu) if q is not None and listed and cu else None
        rows.append((code,i,x["stck_shrn_iscd"].strip(),(x.get("hts_kor_isnm") or "").strip(),q,sh,round(sh*p) if sh is not None and p else None,f(x.get("etf_cnfg_issu_rlim")),p,f(x.get("prdy_ctrt")),AS_OF))
    if not rows: empty.append(f"{code} {name} (구성 {o1.get('etf_cnfg_issu_cnt')})")
    if rows or c.get("rt_cd")=="0":   # 정상 응답이면 교체(빈 응답=파생형 구성 → 기존 행 삭제)
        cur.execute("delete from etf_holdings_now where etf_code=%s",(code,))
        if rows: execute_values(cur,"insert into etf_holdings_now(etf_code,rank,stock_code,stock_name,cu_qty,shares,amount,weight,price,chg_pct,as_of) values %s on conflict do nothing",rows); nh+=len(rows)
    # 2026-11-15: 일간 기록 — 액티브 구성종목 상위 30, 전 ETF 상장좌수·순자산(자금 유출입)
    if mg=="액티브" and rows:
        cur.execute("delete from etf_holdings_daily where d=%s and etf_code=%s",(AS_OF,code))
        execute_values(cur,"insert into etf_holdings_daily(d,etf_code,rank,stock_code,stock_name,cu_qty,shares,amount,weight) values %s on conflict do nothing",
                       [(AS_OF,r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7]) for r in rows[:30]]); nd2+=min(30,len(rows))
    if listed:
        cur.execute("insert into etf_flow_daily(d,etf_code,listed,ntas_eok,nav) values(%s,%s,%s,%s,%s) on conflict(d,etf_code) do update set listed=excluded.listed,ntas_eok=excluded.ntas_eok,nav=excluded.nav",
                    (AS_OF,code,int(listed),f(e.get("etf_ntas_ttam")),f(e.get("nav"))))
    if wg and rows:
        cur.execute("delete from etf_holdings_weekly where etf_code=%s and week_date between %s and %s",(code,wk0,wk1))
        execute_values(cur,"insert into etf_holdings_weekly(week_date,etf_code,rank,stock_code,stock_name,cu_qty,shares,amount,weight) values %s on conflict do nothing",
                       [(AS_OF,r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7]) for r in rows[:20]]); nw+=min(20,len(rows))
    # NXT(대체거래소) 거래 가능 여부 → etf_master.nxt_ok (종목명 옆 20/15 표시용; 148_nxt_flag.py 와 같은 KIS 주식기본조회)
    try:
        sj=kget("/uapi/domestic-stock/v1/quotations/search-stock-info","CTPF1002R",{"PRDT_TYPE_CD":"300","PDNO":code}).get("output") or {}
        v=sj.get("cptt_trad_tr_psbl_yn")
        if v in ("Y","N"): cur.execute("update etf_master set nxt_ok=%s where code=%s",(v=="Y" and sj.get("nxt_tr_stop_yn")!="Y",code)); nn+=1
    except Exception: pass
    dv=kget("/uapi/domestic-stock/v1/ksdinfo/dividend","HHKDB669102C0",{"CTS":"","GB1":"0","F_DT":(T-datetime.timedelta(days=760)).strftime("%Y%m%d"),"T_DT":(T+datetime.timedelta(days=60)).strftime("%Y%m%d"),"SHT_CD":code,"HIGH_GB":""})
    drs={}
    for x in (dv.get("output1") or []):
        rd=d8(x.get("record_date"))
        if rd and f(x.get("per_sto_divi_amt")): drs[rd]=(code,rd,f(x.get("per_sto_divi_amt")),f(x.get("divi_rate")),d8(x.get("divi_pay_dt")))
    if drs:
        execute_values(cur,"insert into etf_dividends(code,record_date,dps,rate,pay_date) values %s on conflict(code,record_date) do update set dps=excluded.dps,rate=excluded.rate,pay_date=excluded.pay_date",list(drs.values())); nd+=len(drs)
    conn.commit()
cur.execute("delete from etf_holdings_daily where d<%s",(AS_OF-datetime.timedelta(days=120),)); cur.execute("delete from etf_flow_daily where d<%s",(AS_OF-datetime.timedelta(days=400),)); conn.commit()
print(f"일간 구성 기록 {nd2}행")
print(f"NXT 표시 {nn}/{len(ETFS)}개 확인",flush=True)
print(f"구성종목(최신) {nh}행 · 주간 스냅샷 {nw}행 · 분배금 {nd}행",flush=True)
print("구성 행 없음(파생형 등):",len(empty),"개 —",", ".join(empty[:30]),flush=True)
cur.execute("select week_date,count(distinct etf_code),count(*) from etf_holdings_weekly group by 1 order by 1 desc limit 5"); print("주간 스냅샷:",cur.fetchall())
cur.execute("select pg_size_pretty(pg_total_relation_size('etf_holdings_weekly')),pg_size_pretty(pg_total_relation_size('etf_holdings_now')),pg_size_pretty(pg_database_size(current_database()))"); print("크기(주간/최신/DB):",cur.fetchone())
