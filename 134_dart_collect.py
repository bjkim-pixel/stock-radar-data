# -*- coding: utf-8 -*-
"""DART OpenAPI → dart_filings. 사용법: python 134_dart_collect.py [조회 일수(기본 4)]
대상: stocks 테이블(활성 종목)에 있는 종목코드만. 정정 공시([기재정정]·[첨부정정])는 원본과 중복되므로 제외.
5% 대량보유(D001)는 majorstock, 임원·주요주주(D002)는 elestock, 자사주 취득결정은 tsstkAqDecsn으로 상세를 채우고
나머지(처분·소각·유증·CB·공개매수·최대주주 변경)는 공시 목록의 보고서명만 저장합니다. 여러 번 실행해도 안전(업서트)."""
import os,re,io,sys,json,time,zipfile,datetime as dt,collections,requests,psycopg2,xml.etree.ElementTree as ET
from psycopg2.extras import execute_values,Json
KEY=os.environ["DART_API_KEY"].strip(); DAYS=int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 4
B="https://opendart.fss.or.kr/api/"
today=dt.date.today(); bgn=(today-dt.timedelta(days=DAYS)).strftime("%Y%m%d"); end=today.strftime("%Y%m%d")
calls=0
def api(ep,**p):
    global calls
    time.sleep(0.12)
    for _ in range(3):
        try:
            r=requests.get(B+ep,params={"crtfc_key":KEY,**p},timeout=40); calls+=1
            return r
        except Exception: time.sleep(1.5)
    raise RuntimeError("DART 요청 실패 "+ep)
def js(ep,**p):
    j=api(ep,**p).json(); st=j.get("status")
    if st=="020": raise SystemExit("DART 호출 한도 초과(020)")
    return j
def listall(**p):
    out=[];pg=1
    while True:
        j=js("list.json",bgn_de=bgn,end_de=end,page_no=pg,page_count=100,**p)
        if j.get("status")!="000": break
        out+=j.get("list",[])
        if pg>=int(j.get("total_page",1)): break
        pg+=1
    return out
def num(v):
    try: return float(str(v).replace(",","").strip())
    except: return None
def d8(s):
    s=(s or "").replace("-","")
    return dt.datetime.strptime(s,"%Y%m%d").date()
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"134_dart_filings.sql"),encoding="utf-8").read())
cur.execute("select code from stocks where is_active"); UNI={r[0] for r in cur.fetchall()}
def ftype(name):
    n=name or ""
    if re.search(r"자산운용|투자운용|자산신탁운용|투자자문|투자일임|에셋|AMC|Asset|Management",n,re.I): return "운용사"
    if re.search(r"국민연금|연금|공제회|사학|교직원",n): return "연기금"
    if re.search(r"증권|투자은행|Securities",n,re.I): return "증권사"
    if re.search(r"Ltd|L\.P|LLC|Fund|Capital|Inc|Corp|Limited|펀드|캐피탈",n,re.I): return "외국계"
    return "기타"
rows={}   # rcept_no → dict
# 고유번호 파일(종목코드→corp_code)
z=zipfile.ZipFile(io.BytesIO(api("corpCode.xml").content)); x=ET.fromstring(z.read(z.namelist()[0]))
print(f"기간 {bgn}~{end} · 대상 종목 {len(UNI)}",flush=True)
def base(d,kind):
    return {"rcept_no":d["rcept_no"],"rcept_dt":d8(d["rcept_dt"]),"code":d["stock_code"].strip(),"corp_code":d["corp_code"],"corp_name":d["corp_name"],"kind":kind,
            "report_nm":d["report_nm"],"filer":d.get("flr_nm"),"filer_type":None,"report_tp":None,"rt_prev":None,"rt_now":None,"shares_now":None,"shares_delta":None,"amount":None,"reason":None,"detail":None}
def keep(d): return d.get("stock_code","").strip() in UNI and not re.match(r"\[(기재|첨부|발행조건)",d["report_nm"])
# 1) 5% 대량보유
H=[d for d in listall(pblntf_detail_ty="D001") if keep(d)]
print("대량보유 목록",len(H),flush=True)
for corp in sorted({d["corp_code"] for d in H}):
    j=js("majorstock.json",corp_code=corp)
    det={it["rcept_no"]:it for it in j.get("list",[])}
    for d in H:
        if d["corp_code"]!=corp: continue
        r=base(d,"HOLD5"); it=det.get(d["rcept_no"])
        r["filer_type"]=ftype(d.get("flr_nm"))
        if it:
            now=num(it.get("stkrt")); inc=num(it.get("stkrt_irds"))
            r.update(filer=it.get("repror") or d.get("flr_nm"),report_tp=it.get("report_tp"),rt_now=now,rt_prev=(round(now-inc,2) if now is not None and inc is not None else None),
                     shares_now=int(num(it.get("stkqy")) or 0),shares_delta=int(num(it.get("stkqy_irds")) or 0),reason=(it.get("report_resn") or "")[:400])
            r["filer_type"]=ftype(r["filer"])
        rows[r["rcept_no"]]=r
# 2) 임원·주요주주 소유보고
I=[d for d in listall(pblntf_detail_ty="D002") if keep(d)]
print("임원·주요주주 목록",len(I),flush=True)
for corp in sorted({d["corp_code"] for d in I}):
    j=js("elestock.json",corp_code=corp)
    det={it["rcept_no"]:it for it in j.get("list",[])}
    for d in I:
        if d["corp_code"]!=corp: continue
        r=base(d,"INSIDER"); it=det.get(d["rcept_no"])
        if it:
            who=it.get("isu_exctv_ofcps") if it.get("isu_exctv_ofcps") not in (None,"-","") else it.get("isu_main_shrholdr")
            r.update(filer=it.get("repror") or d.get("flr_nm"),filer_type=("임원" if it.get("isu_exctv_ofcps") not in (None,"-","") else "주요주주"),
                     report_tp=who,rt_now=num(it.get("sp_stock_lmp_rate")),shares_now=int(num(it.get("sp_stock_lmp_cnt")) or 0),shares_delta=int(num(it.get("sp_stock_lmp_irds_cnt")) or 0))
            inc=num(it.get("sp_stock_lmp_irds_rate"))
            if r["rt_now"] is not None and inc is not None: r["rt_prev"]=round(r["rt_now"]-inc,2)
        rows[r["rcept_no"]]=r
# 3) 주요사항보고서·거래소공시(수시·공정) — 보고서명으로 분류. 호재(수주·증설·지분투자·무상증자)·악재(RISK)·참고(MERGER) 포함
#    보고서명에서 공백·가운뎃점(ㆍ·)을 모두 제거한 뒤 부분 문자열로 비교하므로 키워드에는 공백·점을 쓰지 않는다. 위에서부터 먼저 맞는 종류가 이긴다.
KIND=[("자기주식취득결정","BUYBACK"),("자기주식취득신탁계약체결결정","BUYBACK"),("자기주식처분결정","SELLBACK"),("자기주식취득신탁계약해지결정","SELLBACK"),
      ("주식소각결정","CANCEL"),("유상증자결정","SUPPLY"),("전환사채권발행결정","SUPPLY"),("신주인수권부사채권발행결정","SUPPLY"),("교환사채권발행결정","SUPPLY"),
      ("공개매수신고서","TENDER"),("최대주주변경","MAJOR"),
      # ── 악재 경고(RISK): 해지·횡령·거래정지 등은 호재 키워드보다 먼저 검사
      ("단일판매공급계약해지","RISK"),("횡령","RISK"),("배임","RISK"),("불성실공시","RISK"),("감자결정","RISK"),("관리종목","RISK"),("감사의견","RISK"),("의견거절","RISK"),
      ("상장폐지","RISK"),("거래정지","RISK"),("상장적격성","RISK"),("회생절차","RISK"),("부도발생","RISK"),("파산","RISK"),("영업정지","RISK"),("채무불이행","RISK"),
      ("투자주의환기","RISK"),("해산사유","RISK"),
      # ── 호재
      ("단일판매공급계약체결","ORDER"),("신규시설투자","CAPEX"),("유형자산취득결정","CAPEX"),("타법인주식및출자증권취득결정","STAKE"),
      ("무상증자결정","BONUS"),("주식분할결정","BONUS"),("액면분할","BONUS"),
      # ── 참고(호재·악재 혼재)
      ("회사합병결정","MERGER"),("영업양수결정","MERGER"),("영업양도결정","MERGER"),("회사분할결정","MERGER"),("분할합병결정","MERGER")]
def nz(s): return re.sub(r"[\s·ㆍ‧∙•]","",s or "")
def classify(nm):
    s=nz(nm)
    for k,v in KIND:
        if k in s: return v
    return None
M=[];seen=set()
for ty in (dict(pblntf_ty="B"),dict(pblntf_ty="I"),dict(pblntf_detail_ty="D004")):
    for d in listall(**ty):
        if keep(d) and classify(d["report_nm"]) and d["rcept_no"] not in rows and d["rcept_no"] not in seen: seen.add(d["rcept_no"]);M.append(d)
print("기타 이벤트 목록",len(M),flush=True)
for d in M:
    r=base(d,classify(d["report_nm"])); rows[r["rcept_no"]]=r
# 3-1) 수주(단일판매·공급계약)·증설(신규시설투자) — 공시 본문에서 금액·비율 추출(실패하면 금액 없이 저장)
import html as _h
def doc_text(rcp):
    try:
        zz=zipfile.ZipFile(io.BytesIO(api("document.xml",rcept_no=rcp).content))
        t=" ".join(zz.read(n).decode("utf-8","ignore") for n in zz.namelist() if n.lower().endswith((".xml",".html",".htm")))
        return re.sub(r"\s+"," ",_h.unescape(re.sub(r"<[^>]+>"," ",t)))
    except Exception: return ""
def first(pat,t):
    m=re.search(pat,t); return m.group(1) if m else None
ok_o=ok_c=0
for r in list(rows.values()):
    if r["kind"] not in ("ORDER","CAPEX"): continue
    t=doc_text(r["rcept_no"])
    if not t: continue
    det={}
    if r["kind"]=="ORDER":
        a=num(first(r"계약\s*금액(?:\s*총액)?\s*\(원\)\s*([\d,]{3,})",t) or first(r"계약\s*금액[^\d]{0,25}([\d,]{4,})",t))
        rt=first(r"매출액\s*대비\s*\(%\)\s*(-?[\d.,]+)",t)
        cp=first(r"계약\s*상대\s*([^\d]{2,40}?)\s+(?:-|최근|회사와|상장|판매|해당)",t)
        pe=re.search(r"시작일\s*([\d.\-]{8,10})\s*종료일\s*([\d.\-]{8,10})",t)
        if rt: det["매출대비%"]=num(rt)
        if cp: det["계약상대"]=cp.strip()[:40]
        if pe: det["기간"]=pe.group(1)+"~"+pe.group(2)
        if a: r["amount"]=a; ok_o+=1
    else:
        a=num(first(r"투자\s*금액\s*\(원\)\s*([\d,]{3,})",t))
        rt=first(r"자기자본\s*대비\s*\(%\)\s*(-?[\d.,]+)",t)
        if rt: det["자기자본대비%"]=num(rt)
        if a: r["amount"]=a; ok_c+=1
    if det: r["detail"]=det
print(f"본문 파싱 성공 수주 {ok_o} · 증설 {ok_c}",flush=True)
for corp in sorted({d["corp_code"] for d in M if "자기주식취득결정" in d["report_nm"].replace(" ","")}):
    j=js("tsstkAqDecsn.json",corp_code=corp,bgn_de=bgn,end_de=end)
    for it in j.get("list",[]) or []:
        r=rows.get(it.get("rcept_no"))
        if r and r["kind"]=="BUYBACK":
            r.update(shares_delta=int(num(it.get("aqpln_stk_ostk")) or 0),amount=num(it.get("aqpln_prc_ostk")),reason=((it.get("aq_pp") or "")+" · "+(it.get("aq_mth") or ""))[:300],
                     detail={"기간":f'{it.get("aqexpd_bgd")}~{it.get("aqexpd_edd")}',"비율%":it.get("aq_wtn_div_ostk_rt")})
vals=[(r["rcept_no"],r["rcept_dt"],r["code"],r["corp_code"],r["corp_name"],r["kind"],r["report_nm"],r["filer"],r["filer_type"],r["report_tp"],r["rt_prev"],r["rt_now"],r["shares_now"],r["shares_delta"],r["amount"],r["reason"],Json(r["detail"]) if r["detail"] else None) for r in rows.values()]
if vals:
    execute_values(cur,"""insert into dart_filings(rcept_no,rcept_dt,code,corp_code,corp_name,kind,report_nm,filer,filer_type,report_tp,rt_prev,rt_now,shares_now,shares_delta,amount,reason,detail) values %s
      on conflict(rcept_no) do update set report_nm=excluded.report_nm,filer=excluded.filer,filer_type=excluded.filer_type,report_tp=excluded.report_tp,rt_prev=excluded.rt_prev,rt_now=excluded.rt_now,
        shares_now=excluded.shares_now,shares_delta=excluded.shares_delta,amount=excluded.amount,reason=excluded.reason,detail=excluded.detail,updated_at=now()""",vals,page_size=500)
# 더 이상 수집하지 않는 종류(배당·실적·기술신약)와 1개월 보관 기준을 넘은 공시 정리 — 여러 번 실행해도 안전
cur.execute("delete from dart_filings where kind in ('DIVIDEND','EARN','TECH') or rcept_dt < current_date - 35"); print("정리 삭제",cur.rowcount,"건",flush=True)
cur.execute("select kind,count(*),min(rcept_dt),max(rcept_dt) from dart_filings group by kind order by kind"); t=cur.fetchall()
rep=f"# DART 공시 수집 결과\n- 본문 파싱 성공 수주 {ok_o} · 증설 {ok_c}\n- 기간 {bgn}~{end} · API 호출 {calls}회 · 이번 업서트 {len(vals)}건\n\n| 종류 | 건수 | 최소일 | 최대일 |\n|---|---|---|---|\n"+"\n".join(f"| {a} | {b} | {c} | {d} |" for a,b,c,d in t)
cur.execute("select rcept_dt,corp_name,filer,filer_type,rt_prev,rt_now from dart_filings where kind='HOLD5' and filer_type='운용사' order by rcept_dt desc,corp_name limit 12")
rep+="\n\n## 운용사 5% 샘플\n```\n"+"\n".join(str(x) for x in cur.fetchall())+"\n```\n"
cur.execute("select rcept_dt,corp_name,filer,report_tp,shares_delta from dart_filings where kind='INSIDER' and shares_delta<>0 order by rcept_dt desc limit 8")
rep+="\n## 내부자 샘플\n```\n"+"\n".join(str(x) for x in cur.fetchall())+"\n```\n"
open("dart_report.md","w",encoding="utf-8").write(rep); print(rep)
