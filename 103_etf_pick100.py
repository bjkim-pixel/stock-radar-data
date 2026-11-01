# -*- coding: utf-8 -*-
"""ETF 100개 후보 선정(읽기 전용): 거래대금 기준 + 같은 기초지수 중복 제거 + 유형별 정원."""
import os,sys,time,json,datetime,zipfile,io,re,requests,importlib,collections
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
KIS_BASE="https://openapi.koreainvestment.com:9443"
L=[]
def log(m=""): print(m,flush=True); L.append(m)
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.08)
    for _ in range(2):
        try: return requests.get(KIS_BASE+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"}).json()
        except Exception: time.sleep(1)
    return {}
T=datetime.date.today()
z=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",timeout=30).content))
raw=z.read(z.namelist()[0]).decode("cp949","ignore").splitlines()
etfs=[(x[:9].strip(),x[21:-227].strip()) for x in raw if len(x)>=240 and x[-227:][:2]=="EF"]
BRANDS=r"KODEX|TIGER|RISE|ACE|SOL|PLUS|KIWOOM|HANARO|1Q|HK|WON|FOCUS|TIMEFOLIO|KoAct|마이티|에셋플러스|ARIRANG|KBSTAR|TREX|BNK|DAISHIN343|히어로즈|UNICORN|조선|대신|메리츠|삼성|미래에셋|키움|한투|신한|하나|NH|IBK|트러스톤|Koact|ITF|파워|RISE|BIG|VITA|아이엠"
def kind(n):
    if re.search(r"곱버스|인버스\s*2X|2X\s*인버스|레버리지\s*인버스",n): return "곱버스"
    if "인버스" in n: return "인버스"
    if re.search(r"레버리지|2X|3X",n): return "레버리지"
    return "일반"
def theme(n):
    if re.search(r"CD금리|머니마켓|KOFR|SOFR|초단기|단기채|단기통안|파킹",n): return "현금성"
    if re.search(r"국고채|국채|채권|통안|회사채|하이일드|금리|TLT|크레딧",n): return "채권"
    if re.search(r"금현물|골드|은선물|원유|구리|농산물|WTI|천연가스|원자재|팔라듐|달러|엔화|유로|환율|위안",n): return "원자재·통화"
    if re.search(r"미국|나스닥|S&P|NASDAQ|중국|차이나|일본|니케이|인도|베트남|유럽|글로벌|선진국|신흥|항셍|대만|필라델피아|월드|브라질|멕시코|독일|인도네시아|MSCI|해외",n): return "해외"
    return "국내"
def key(n):
    k=re.sub(r"\(.*?\)","",n)
    k=re.sub(BRANDS,"",k)
    k=re.sub(r"TOP\d+|액티브|플러스|Plus|Fn|선물|단일종목|ETF|\s|-|_|·|증권상장지수투자신탁|합성|H$","",k,flags=re.I)
    return k
res=[]
d2=T; d1=T-datetime.timedelta(days=150)
for i,(code,nm) in enumerate(etfs):
    d=kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice","FHKST03010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":d1.strftime("%Y%m%d"),"FID_INPUT_DATE_2":d2.strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"})
    rows=sorted([x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date") and float(x.get("stck_clpr") or 0)>0],key=lambda x:x["stck_bsop_date"])
    if len(rows)<20: continue
    c=[float(x["stck_clpr"]) for x in rows]; tv=[float(x.get("acml_tr_pbmn") or 0) for x in rows]
    ret=lambda n:(c[-1]/c[-1-n]-1)*100 if len(c)>n else None
    res.append(dict(code=code,name=nm,kind=kind(nm),theme=theme(nm),key=key(nm),n=len(c),turn20=sum(tv[-20:])/20/1e8,turn60=sum(tv[-60:])/len(tv[-60:])/1e8,r20=ret(20),r60=ret(59)))
log(f"# ETF 100개 후보 ({T}, KIS 일봉)\n\n- 전체 ETF {len(etfs)}개 중 일봉 확보 {len(res)}개\n")
elig=[r for r in res if r["n"]>=80 and min(r["turn20"],r["turn60"])>=(5 if r["kind"]!="일반" else 20)]
log(f"- 상장 약 4개월 이상(80봉+) · 20일·60일 평균 거래대금 최소 기준(일반 20억, 인버스/레버리지 5억) 충족: {len(elig)}개")
# 같은 기초지수(key) 중복 제거: 거래대금(20·60일 평균) 1위만
grp=collections.defaultdict(list)
for r in elig: grp[(r["kind"] if r["kind"]!="일반" else "G",r["key"])].append(r)
rep=[]; dup=0
for k,v in grp.items():
    v.sort(key=lambda r:-(r["turn20"]+r["turn60"])); rep.append(v[0]); r0=v[0]; r0["alt"]=len(v)-1; dup+=len(v)-1
log(f"- 같은 기초지수 중복 제거: {dup}개 제거 → 대표 {len(rep)}개\n")
Q=[("현금성",2,lambda r:r["theme"]=="현금성"),("인버스·레버리지",20,lambda r:r["kind"]!="일반"),("국내(지수·업종·테마)",40,lambda r:r["kind"]=="일반" and r["theme"]=="국내"),("해외",25,lambda r:r["kind"]=="일반" and r["theme"]=="해외"),("채권",6,lambda r:r["kind"]=="일반" and r["theme"]=="채권"),("원자재·통화",7,lambda r:r["kind"]=="일반" and r["theme"]=="원자재·통화")]
chosen=[]; used=set()
def lv(r): return r["kind"]!="일반"
for qn,qt,f in Q:
    c=[r for r in sorted(rep,key=lambda r:-(r["turn20"]+r["turn60"])) if f(r) and r["code"] not in used and (qn=="인버스·레버리지" or lv(r)==False)][:qt]
    for r in c: used.add(r["code"]); r["slot"]=qn
    chosen+=c
    log(f"- {qn}: 정원 {qt} → {len(c)}개")
rest=[r for r in sorted(rep,key=lambda r:-(r["turn20"]+r["turn60"])) if r["code"] not in used and r["kind"]=="일반" and r["theme"]!="현금성"]
need=100-len(chosen)
for r in rest[:max(need,0)]: r["slot"]="보충(거래대금순)"; chosen.append(r)
log(f"- 부족분 보충 {max(need,0)}개 → 총 {len(chosen)}개\n")
def f1(v): return "-" if v is None else f"{v:.1f}"
for qn in [q[0] for q in Q]+["보충(거래대금순)"]:
    cs=[r for r in chosen if r["slot"]==qn]
    if not cs: continue
    log(f"## {qn} ({len(cs)}개)\n\n| 코드 | 이름 | 유형 | 20일평균거래대금(억) | 60일평균(억) | 20일% | 60일% | 같은지수 제외 |\n|---|---|---|---|---|---|---|---|")
    for r in cs: log(f"| {r['code']} | {r['name'][:26]} | {r['kind']}/{r['theme']} | {r['turn20']:.0f} | {r['turn60']:.0f} | {f1(r['r20'])} | {f1(r['r60'])} | {r.get('alt',0)} |")
    log("")
open('etf_pick100_report.md','w',encoding='utf-8').write("\n".join(L))
