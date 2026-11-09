# -*- coding: utf-8 -*-
"""DART OpenAPI → gov_board / gov_owner / gov_major / gov_summary. 사용법: python 137_governance_collect.py [종목수 제한]
- 대상: stocks(is_active, STOCK). 종목별 최신 정기보고서(2026 3Q→반기→1Q→2025 사업보고서 순으로 데이터가 있는 것)를 찾아
  임원현황(exctvSttus)·최대주주현황(hyslrSttus)·소액주주(mrhlSttus)·자기주식(tesstkAcqsDspsSttus)을 저장. 같은 보고서(rcept_no)면 건너뜀.
- 5% 대량보유(majorstock)는 보고자별 최신 1건씩 매번 갱신(지분율 5% 이상만).
- 이사회 = 등기이사 중 사내이사·기타비상무이사(사외이사/독립이사·감사·미등기 제외). 개인 보유주식 = 최대주주·특수관계인 표에서 이름이 같은 행."""
import os,sys,io,re,time,zipfile,json,datetime as dt,requests,psycopg2,xml.etree.ElementTree as ET
KEY=os.environ["DART_API_KEY"].strip(); LIMIT=int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 0
B="https://opendart.fss.or.kr/api/"; calls=0; T0=time.time()
def api(ep,**p):
    global calls
    time.sleep(0.1)
    for _ in range(3):
        try:
            r=requests.get(B+ep,params={"crtfc_key":KEY,**p},timeout=40); calls+=1; return r
        except Exception: time.sleep(1.5)
    raise RuntimeError("DART 요청 실패 "+ep)
def js(ep,**p):
    j=api(ep+".json",**p).json()
    if j.get("status")=="020": raise SystemExit("DART 호출 한도 초과(020)")
    return j.get("list") or [] if j.get("status")=="000" else []
def num(v):
    try: return float(str(v).replace(",","").strip())
    except: return None
def d10(s):
    try: return dt.date.fromisoformat(str(s)[:10])
    except: return None
def nm_key(s): return re.sub(r"\s+","",s or "")
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"137_governance.sql"),encoding="utf-8").read())
cur.execute("select code from stocks where is_active and security_type='STOCK' order by code"); codes=[r[0] for r in cur.fetchall()]
if LIMIT: codes=codes[:LIMIT]
z=zipfile.ZipFile(io.BytesIO(api("corpCode.xml").content)); x=ET.fromstring(z.read(z.namelist()[0]))
CC={(e.findtext("stock_code") or "").strip():e.findtext("corp_code") for e in x.iter("list")}
cur.execute("select code,rcept_no from gov_summary"); seen=dict(cur.fetchall())
y=dt.date.today().year
CAND=[(str(y),"11014"),(str(y),"11012"),(str(y),"11013"),(str(y-1),"11011"),(str(y-1),"11014")]
sample={}; n_new=n_skip=n_nocorp=n_nodata=0
def isCorp(n): return bool(re.search(r"\(주\)|㈜|주식회사|유한|합자|조합|재단|공사|은행|증권|펀드|투자|홀딩스|Ltd|Inc|Corp|Fund|Capital|LLC|L\.P|파트너스|코퍼레이션",n or "",re.I)) or len(nm_key(n))>=5
for code in codes:
    cc=CC.get(code)
    if not cc: n_nocorp+=1; continue
    ex=None
    for yr,rc in CAND:
        L=js("exctvSttus",corp_code=cc,bsns_year=yr,reprt_code=rc)
        if L: ex=(yr,rc,L); break
    # 5% 대량보유: 보고자별 최신 1건
    mj=js("majorstock",corp_code=cc); best={}
    for it in sorted(mj,key=lambda i:(i.get("rcept_dt",""),i.get("rcept_no",""))): best[nm_key(it.get("repror"))]=it
    cur.execute("delete from gov_major where code=%s",(code,))
    for k,it in best.items():
        rt=num(it.get("stkrt"))
        if rt is None or rt<5: continue
        cur.execute("insert into gov_major(code,repror,rcept_dt,rcept_no,report_tp,shares,rate,rate_chg,reason) values(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
          (code,it.get("repror"),d10(it.get("rcept_dt")),it.get("rcept_no"),it.get("report_tp"),num(it.get("stkqy")),rt,num(it.get("stkrt_irds")),(it.get("report_resn") or "")[:300]))
    if not ex: n_nodata+=1; continue
    yr,rc,EL=ex; rno=EL[0].get("rcept_no")
    if seen.get(code)==rno: n_skip+=1; continue
    hs=js("hyslrSttus",corp_code=cc,bsns_year=yr,reprt_code=rc)
    ml=js("mrhlSttus",corp_code=cc,bsns_year=yr,reprt_code=rc)
    ts=js("tesstkAcqsDspsSttus",corp_code=cc,bsns_year=yr,reprt_code=rc)
    if code in("192820","005930") : sample[code]={"hyslr":hs[:3],"mrhl":ml[:3],"tesstk":ts[:4]}
    stl=d10(EL[0].get("stlm_dt"))
    own={}
    for h in hs:
        if h.get("stock_knd")!="보통주": continue
        own[nm_key(h.get("nm"))]=(num(h.get("trmend_posesn_stock_co")),num(h.get("trmend_posesn_stock_qota_rt")))
    cur.execute("delete from gov_board where code=%s",(code,)); cur.execute("delete from gov_owner where code=%s",(code,))
    for e in EL:
        kind=(e.get("rgist_exctv_at") or "").strip()
        if kind not in("사내이사","기타비상무이사"): continue
        o=own.get(nm_key(e.get("nm")),(None,None))
        cur.execute("insert into gov_board(code,nm,rcept_no,stlm_dt,birth_ym,ofcps,kind,fte,chrg_job,main_career,tenure_end,own_shares,own_rate) values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(code,nm) do nothing",
          (code,re.sub(r"\s+"," ",e.get("nm") or "").strip(),rno,stl,e.get("birth_ym"),re.sub(r"\s+"," ",e.get("ofcps") or "").strip(),kind,e.get("fte_at"),(e.get("chrg_job") or "").strip()[:200],(e.get("main_career") or "").strip()[:600],e.get("tenure_end_on"),o[0],o[1]))
    for h in hs:
        nmx=(h.get("nm") or "").strip()
        cur.execute("insert into gov_owner(code,nm,relate,stock_knd,rcept_no,stlm_dt,shares,rate,shares_beg,rate_beg,is_corp) values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(code,nm,stock_knd) do nothing",
          (code,nmx,h.get("relate"),h.get("stock_knd") or "",rno,stl,num(h.get("trmend_posesn_stock_co")),num(h.get("trmend_posesn_stock_qota_rt")),num(h.get("bsis_posesn_stock_co")),num(h.get("bsis_posesn_stock_qota_rt")),isCorp(nmx) and nmx!="계"))
    sm=next((m for m in ml if "소액" in (m.get("se") or "")),ml[0] if ml else {})
    issued=num(sm.get("stock_tot_co")) if sm else None
    t1=next((t for t in ts if (t.get("stock_knd") or "")=="보통주" and (t.get("acqs_mth1") or "")=="총계"),None) or next((t for t in ts if (t.get("stock_knd") or "")=="보통주"),None)
    tq=num(t1.get("trmend_qy")) if t1 else None
    cur.execute("""insert into gov_summary(code,rcept_no,stlm_dt,board_rcept,small_holders,small_holders_rate,small_shares_rate,issued_shares,treasury_shares,treasury_rate,checked_at)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) on conflict(code) do update set rcept_no=excluded.rcept_no,stlm_dt=excluded.stlm_dt,board_rcept=excluded.board_rcept,small_holders=excluded.small_holders,
      small_holders_rate=excluded.small_holders_rate,small_shares_rate=excluded.small_shares_rate,issued_shares=excluded.issued_shares,treasury_shares=excluded.treasury_shares,treasury_rate=excluded.treasury_rate,checked_at=now()""",
      (code,rno,stl,rno,num(sm.get("shrholdr_co")) if sm else None,num(sm.get("shrholdr_rate")) if sm else None,num(sm.get("hold_stock_rate")) if sm else None,issued,tq,(tq/issued*100 if tq is not None and issued else None)))
    n_new+=1
rep=f"# 지배구조 수집 결과\n- 종목 {len(codes)} · 신규/갱신 {n_new} · 동일 보고서 건너뜀 {n_skip} · 정기보고서 없음 {n_nodata} · corp_code 없음 {n_nocorp} · API {calls}회 · {time.time()-T0:.0f}초\n"
for t in ["gov_board","gov_owner","gov_major","gov_summary"]:
    cur.execute(f"select count(*),count(distinct code) from {t}"); rep+=f"- {t}: {cur.fetchone()}\n"
cur.execute("select nm,ofcps,kind,fte,own_shares,own_rate from gov_board where code='192820' order by nm"); rep+="\n## 코스맥스 이사회\n```\n"+"\n".join(map(str,cur.fetchall()))+"\n```\n"
cur.execute("select nm,relate,stock_knd,shares,rate,is_corp from gov_owner where code='192820' order by shares desc nulls last"); rep+="\n## 코스맥스 주주\n```\n"+"\n".join(map(str,cur.fetchall()))+"\n```\n"
cur.execute("select * from gov_summary where code in('192820','005930')"); rep+="\n## 요약\n```\n"+"\n".join(map(str,cur.fetchall()))+"\n```\n"
cur.execute("select code,repror,rate,rcept_dt from gov_major where code in('192820','005930') order by code,rate desc"); rep+="\n## 5% 보유자\n```\n"+"\n".join(map(str,cur.fetchall()))+"\n```\n"
rep+="\n## 원본 샘플\n```\n"+json.dumps(sample,ensure_ascii=False,indent=1)[:3500]+"\n```\n"
open("gov_report.md","w",encoding="utf-8").write(rep); print(rep)
