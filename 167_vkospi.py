# -*- coding: utf-8 -*-
"""VKOSPI(코스피200 변동성지수) — mode=setup: 테이블 생성 + CSV(종가) 적재 + KRX/인베스팅 점검 리포트(vkospi_probe.md).
KRX 인증키는 환경변수 KRX_API_KEY(GitHub Secret)로만 읽고, 로그·리포트에는 절대 출력하지 않는다."""
import os,re,csv,sys,json,datetime as dt,requests
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KEY=os.environ.get("KRX_API_KEY","").strip()
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
def last_bd(n=1):
    d=dt.date.today()
    while True:
        d-=dt.timedelta(days=1)
        if d.weekday()<5: n-=1
        if n<=0: return d.strftime("%Y%m%d")

def setup_db():
    import psycopg2
    conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
    cur.execute(open("167_vkospi.sql",encoding="utf-8").read())
    n=0
    for r in csv.DictReader(open("167_vkospi_seed.csv",encoding="utf-8")):
        cur.execute("insert into vkospi_daily(trade_date,close,src) values(%s,%s,'csv') on conflict (trade_date) do update set close=excluded.close, src='csv', updated_at=now() where vkospi_daily.src='csv'",(r["date"],r["close"])); n+=1
    cur.execute("select count(*),min(trade_date),max(trade_date) from vkospi_daily"); c=cur.fetchone()
    log(f"## DB\n- 테이블 준비 · CSV {n}건 반영 · 현재 {c[0]}건 ({c[1]} ~ {c[2]})")

def find_vol(rows,keys=("IDX_NM","idxNm","IDX_IND_NM")):
    out=[]
    for x in rows or []:
        s=" ".join(str(x.get(k,"")) for k in x if "NM" in k.upper() or "nm" in k)
        if "변동성" in s or "VKOSPI" in s.upper(): out.append(x)
    return out

def probe_krx_openapi():
    log("\n## A. KRX Open API (AUTH_KEY)"); log(f"- 키 설정: {'있음' if KEY else '없음(KRX_API_KEY 시크릿 미등록)'}")
    if not KEY: return
    for base in ("https://data-dbg.krx.co.kr/svc/apis","https://data.krx.co.kr/svc/apis"):
        for path in ("idx/drvprod_dd_trd","idx/kospi_dd_trd","idx/krx_dd_trd","idx/bon_dd_trd"):
            for bd in (last_bd(1),last_bd(2)):
                try:
                    r=requests.get(f"{base}/{path}",params={"basDd":bd},headers={**UA,"AUTH_KEY":KEY},timeout=25)
                    t=r.text.replace(KEY,"***")[:160].replace("\n"," ")
                    try: rows=r.json().get("OutBlock_1") or []
                    except Exception: rows=[]
                    v=find_vol(rows)
                    log(f"- {base.split('//')[1].split('.')[0]}/{path} {bd}: HTTP {r.status_code} · 행 {len(rows)} · 변동성 행 {len(v)} · {'' if rows else t}")
                    for x in v[:3]: log("  "+json.dumps(x,ensure_ascii=False)[:300])
                    if rows: log("  키: "+", ".join(list(rows[0].keys())[:14]))
                except Exception as e: log(f"- {base}/{path} {bd}: 실패 {str(e).replace(KEY,'***')[:120]}")

def probe_krx_marketplace():
    log("\n## B. KRX 정보데이터시스템 화면 조회(getJsonData, 키 없이)")
    S=requests.Session(); S.headers.update({**UA,"Referer":"https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020101"})
    try: S.get("https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020101",timeout=20)
    except Exception as e: log(f"- 메인 실패 {e}")
    bd=last_bd(1)
    for mid in ("01","02","03","04"):
        data={"bld":"dbms/MDC/STAT/standard/MDCSTAT00101","locale":"ko_KR","idxIndMidclssCd":mid,"trdDd":bd,"share":"2","money":"3","csvxls_isNo":"false"}
        try:
            r=S.post("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd",data=data,timeout=25)
            try: rows=r.json().get("output") or []
            except Exception: rows=[]
            v=find_vol(rows); log(f"- 분류 {mid} {bd}: HTTP {r.status_code} · 행 {len(rows)} · 변동성 행 {len(v)}" + ("" if rows else " · "+r.text[:120].replace("\n"," ")))
            for x in v[:3]: log("  "+json.dumps(x,ensure_ascii=False)[:300])
        except Exception as e: log(f"- 분류 {mid}: 실패 {str(e)[:120]}")

def probe_investing():
    log("\n## C. 인베스팅닷컴 (대안)")
    try:
        r=requests.get("https://www.investing.com/indices/kospi-volatility",headers=UA,timeout=25)
        m=re.search(r'data-test="instrument-price-last"[^>]*>([\d.,]+)<',r.text)
        log(f"- 페이지 HTTP {r.status_code} · 길이 {len(r.text)} · 현재가 {m.group(1) if m else '추출 실패'}")
    except Exception as e: log(f"- 실패 {str(e)[:120]}")

def daily(days=7):
    """최근 days일(주말 제외) 파생상품지수에서 코스피200 변동성지수 종가를 가져와 upsert. 값이 없는 날은 건너뜀(채우지 않음)."""
    import psycopg2
    if not KEY: log("KRX_API_KEY 없음"); sys.exit(1)
    conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
    d=dt.date.today(); got=0; err=0
    for i in range(days+1):
        x=d-dt.timedelta(days=i)
        if x.weekday()>=5: continue
        try:
            r=requests.get("https://data-dbg.krx.co.kr/svc/apis/idx/drvprod_dd_trd",params={"basDd":x.strftime("%Y%m%d")},headers={**UA,"AUTH_KEY":KEY},timeout=30)
            if r.status_code!=200: log(f"{x} HTTP {r.status_code}"); err+=1; continue
            rows=r.json().get("OutBlock_1") or []
            v=[q for q in rows if "코스피 200 변동성" in q.get("IDX_NM","").replace("  "," ") or "코스피200 변동성" in q.get("IDX_NM","").replace(" ","")[:0]+q.get("IDX_NM","") or "변동성" in q.get("IDX_NM","") and "200" in q.get("IDX_NM","") and "코스피" in q.get("IDX_NM","")]
            if not v: log(f"{x} 해당 지수 없음(휴장/미공시) 행 {len(rows)}"); continue
            c=float(str(v[0]["CLSPRC_IDX"]).replace(",",""))
            cur.execute("insert into vkospi_daily(trade_date,close,src) values(%s,%s,'krx') on conflict (trade_date) do update set close=excluded.close, src=case when vkospi_daily.src='csv' then 'csv' else 'krx' end, updated_at=now()",(x,c)); got+=1
            log(f"{x} {v[0]['IDX_NM']} {c}")
        except Exception as e: log(f"{x} 실패 {str(e).replace(KEY,'***')[:100]}"); err+=1
    log(f"반영 {got}건 · 오류 {err}")
    open("vkospi_probe.md","w",encoding="utf-8").write("\n".join(L))
    if got==0 and err: sys.exit(1)

if __name__=="__main__" and len(sys.argv)>1 and sys.argv[1]=="daily":
    daily(int(sys.argv[2]) if len(sys.argv)>2 else 7); sys.exit(0)
if __name__=="__main__":
    log("# VKOSPI 수집 점검\n")
    if os.environ.get("SUPABASE_DB_URL"):
        try: setup_db()
        except Exception as e: log(f"- DB 단계 실패: {e}")
    probe_krx_openapi(); probe_krx_marketplace(); probe_investing()
    open("vkospi_probe.md","w",encoding="utf-8").write("\n".join(L))
