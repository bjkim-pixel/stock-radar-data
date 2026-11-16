# -*- coding: utf-8 -*-
"""시장·종목 이벤트 → market_events. 사용법: python 169_market_events.py [DART 조회 일수(기본 3)]
 1) 규칙: 앞으로 120일의 선물·옵션 만기일(매월 둘째 목요일, 휴장이면 직전 거래일) · 3·6·9·12월은 동시만기일 · 6·12월은 지수 정기변경 반영일
 2) 수동: market_events_manual.json (FOMC·CPI 등)
 3) DART: 활성 종목의 영업(잠정)실적·매출액/손익구조 변경·기업설명회(IR) 공시(정정 제외) — 공시일을 이벤트 날짜로
여러 번 실행해도 안전(업서트). DART_API_KEY 가 없으면 3)은 건너뜀."""
import os,re,sys,json,time,datetime as dt,requests,psycopg2
from psycopg2.extras import execute_values
import holidays

DAYS=int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 3
HERE=os.path.dirname(os.path.abspath(__file__))
today=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
KR=holidays.country_holidays("KR",years=range(today.year,today.year+3))
def is_open(d): return d.weekday()<5 and d not in KR and not (d.month==12 and d.day==31)   # KRX 연말휴장
def prev_open(d):
    while not is_open(d): d-=dt.timedelta(days=1)
    return d
def second_thursday(y,m):
    d=dt.date(y,m,1)
    d+=dt.timedelta(days=(3-d.weekday())%7)   # 첫 목요일
    return d+dt.timedelta(days=7)
def rule_events(start,horizon=120):
    out=[]; end=start+dt.timedelta(days=horizon); y,m=start.year,start.month
    while dt.date(y,m,1)<=end:
        d=prev_open(second_thursday(y,m))
        if start<=d<=end:
            quad=m in (3,6,9,12)
            out.append(("expiry",d,None,None,"선물·옵션 동시만기일(쿼드러플 위칭)" if quad else "옵션 만기일",
                        "만기일 장 마감 무렵 프로그램 매매 변동이 커질 수 있음" + (" · 지수 정기변경 종목 교체가 만기일 종가에 반영" if m in (6,12) else ""),"rule",f"expiry|{d}||{m}"))
            if m in (6,12): out.append(("index",d,None,None,"지수 정기변경(KOSPI200 등) 종목 교체 반영","만기일 종가 기준 — 편입·편출 종목 수급 변동","rule",f"index|{d}||regular"))
        m+=1
        if m>12: y,m=y+1,1
    return out
def manual_events():
    p=os.path.join(HERE,"market_events_manual.json")
    if not os.path.exists(p): return []
    out=[]
    for i,r in enumerate(json.load(open(p,encoding="utf-8"))):
        try: d=dt.date.fromisoformat(r["date"])
        except Exception: print("수동 파일 날짜 오류:",r); continue
        out.append((r.get("kind","other"),d,None,None,r["title"],r.get("detail"),"manual",f"{r.get('kind','other')}|{d}||manual{i}"))
    return out
def dart_events(cur):
    key=os.environ.get("DART_API_KEY","").strip()
    if not key: print("DART_API_KEY 없음 — 공시 수집 건너뜀"); return []
    cur.execute("select code,name from stocks where is_active"); uni={r[0]:r[1] for r in cur.fetchall()}
    bgn=(today-dt.timedelta(days=DAYS)).strftime("%Y%m%d"); end=today.strftime("%Y%m%d")
    pat=re.compile(r"영업\(잠정\)실적|매출액또는손익구조|기업설명회\(IR\)")
    out=[]; pg=1
    while True:
        r=None
        for _ in range(3):
            try: r=requests.get("https://opendart.fss.or.kr/api/list.json",params={"crtfc_key":key,"bgn_de":bgn,"end_de":end,"pblntf_ty":"I","page_no":pg,"page_count":100},timeout=40).json(); break
            except Exception: time.sleep(1.5)
        if not r or r.get("status")=="020": print("DART 호출 실패/한도:",r and r.get("status")); break
        if r.get("status")!="000": break
        for d in r.get("list",[]):
            code=(d.get("stock_code") or "").strip(); nm=d.get("report_nm","")
            if code not in uni or not pat.search(nm) or re.match(r"\[(기재|첨부|발행조건)",nm): continue
            kind="ir" if "기업설명회" in nm else "earnings"
            ds=dt.datetime.strptime(d["rcept_dt"],"%Y%m%d").date()
            title=re.sub(r"\(공정공시\)|\s+"," ",nm).strip()
            out.append((kind,ds,code,uni[code],title,"https://dart.fss.or.kr/dsaf001/main.do?rcpNo="+d["rcept_no"],"dart",f"{kind}|{ds}|{code}|{d['rcept_no']}"))
        if pg>=int(r.get("total_page",1)): break
        pg+=1; time.sleep(0.12)
    return out
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(HERE,"169_market_events.sql"),encoding="utf-8").read())
rows=rule_events(today)+manual_events()+dart_events(cur)
if rows:
    execute_values(cur,"insert into market_events (kind,event_date,code,name,title,detail,source,ev_key) values %s on conflict (ev_key) do update set event_date=excluded.event_date,title=excluded.title,detail=excluded.detail,name=excluded.name,updated_at=now()",rows)
cur.execute("delete from market_events where event_date < %s and source<>'dart'",(today-dt.timedelta(days=30),))   # 지난 규칙·수동 일정 정리(공시는 기록으로 남김)
by={}
for r in rows: by[(r[6],r[0])]=by.get((r[6],r[0]),0)+1
print("저장",len(rows),"건:",", ".join(f"{k[0]}/{k[1]} {v}" for k,v in sorted(by.items())))
for r in sorted(rows,key=lambda x:x[1])[:12]: print(" ",r[1],r[0],r[3] or "",r[4])
