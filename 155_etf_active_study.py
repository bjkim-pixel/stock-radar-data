# -*- coding: utf-8 -*-
"""액티브 ETF 스터디(읽기 전용, DB 변경 없음): 국내 전체 액티브 ETF 개수·시총 순위, 해외 ETP 마스터·대표 액티브 ETF 시총."""
import os,sys,time,json,datetime,zipfile,io,re,requests,importlib,collections,statistics
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
def num(x):
    try: return float(str(x).replace(",",""))
    except Exception: return None
T=datetime.date.today()
log(f"# 액티브 ETF 스터디 ({T}, KIS 기준)\n")
# ───────── A. 국내
M="https://new.real.download.dws.co.kr/common/master/"
raw=zipfile.ZipFile(io.BytesIO(requests.get(M+"kospi_code.mst.zip",timeout=30).content))
raw=raw.read(raw.namelist()[0]).decode("cp949","ignore").splitlines()
etfs=[(x[:9].strip(),x[21:-227].strip()) for x in raw if len(x)>=240 and x[-227:][:2]=="EF"]
ACT=re.compile(r"액티브|KoAct|TIME |Active|ACTIVE",re.I)
act=[(c,n) for c,n in etfs if ACT.search(n)]
def theme(n):
    if re.search(r"CD금리|머니마켓|KOFR|SOFR|초단기|단기채|단기통안|파킹|단기금융",n): return "현금성"
    if re.search(r"국고채|국채|채권|통안|회사채|하이일드|금리|크레딧|금융채|특수채",n): return "채권"
    if re.search(r"금현물|골드|은선물|원유|구리|농산물|WTI|천연가스|원자재|달러|엔화|환율",n): return "원자재·통화"
    if re.search(r"혼합|배분|TDF|자산배분|멀티에셋|인컴",n): return "혼합·배분"
    if re.search(r"미국|나스닥|S&P|글로벌|일본|니케이|중국|차이나|인도|베트남|대만|유럽|선진|신흥|해외|월드|엔비디아|테슬라|테크TOP|빅테크|반도체TOP",n): return "해외주식"
    return "국내주식"
def brand(n): return n.split()[0] if n.split() else n
log(f"## A. 국내 (KIS 종목마스터)\n- 국내 상장 ETF 전체 **{len(etfs)}개** 중 이름에 '액티브·KoAct·TIME'이 들어간 **액티브 ETF {len(act)}개**")
log("- KIS 종목마스터에는 '액티브' 구분 코드가 없어 **이름 패턴**으로 구분했습니다(패시브처럼 이름 지은 액티브가 소수 있을 수 있음).")
rows=[]
for i,(c,n) in enumerate(act):
    p=kget("/uapi/domestic-stock/v1/quotations/inquire-price","FHKST01010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":c}).get("output") or {}
    e=kget("/uapi/etfetn/v1/quotations/inquire-price","FHPST02400000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":c}).get("output") or {}
    price=num(p.get("stck_prpr")); stcn=num(p.get("lstn_stcn")); mcap=num(p.get("hts_avls"))
    rows.append(dict(code=c,name=n,theme=theme(n),brand=brand(n),price=price,stcn=stcn,mcap=mcap,ntas=num(e.get("etf_ntas_ttam")),dprt=num(e.get("dprt")),vol=num(p.get("acml_tr_pbmn"))))
    if i==0: log(f"- 응답 필드 샘플({c}): 시총 hts_avls={p.get('hts_avls')} · 상장주식수 lstn_stcn={p.get('lstn_stcn')} · 순자산 etf_ntas_ttam={e.get('etf_ntas_ttam')} · NAV={e.get('nav')} · 괴리율 dprt={e.get('dprt')}")
rows=[r for r in rows if r["mcap"]]
rows.sort(key=lambda r:-r["mcap"])
log(f"- 시가총액 조회 성공 {len(rows)}개 / 합계 **{sum(r['mcap'] for r in rows)/1e4:,.1f}조원**")
mc=[r["mcap"] for r in rows]
log("\n### 시가총액 분포(억원)")
for k in (1,5,10,20,30,50,70,100,150):
    if k<=len(mc): log(f"- {k}위: {mc[k-1]:,.0f}억")
for th in (10000,5000,3000,1000,500,300,100):
    log(f"- {th:,}억 이상: {sum(1 for x in mc if x>=th)}개")
log("\n### 분류별 개수·시총합")
cc=collections.defaultdict(lambda:[0,0.0])
for r in rows: cc[r["theme"]][0]+=1; cc[r["theme"]][1]+=r["mcap"]
for k,(n,s) in sorted(cc.items(),key=lambda x:-x[1][1]): log(f"- {k}: {n}개 · {s/1e4:,.1f}조")
log("\n### 운용사(브랜드)별 개수·시총합")
bb=collections.defaultdict(lambda:[0,0.0])
for r in rows: bb[r["brand"]][0]+=1; bb[r["brand"]][1]+=r["mcap"]
for k,(n,s) in sorted(bb.items(),key=lambda x:-x[1][1]): log(f"- {k}: {n}개 · {s/1e4:,.1f}조")
log("\n### 상위 100개(시가총액 순)\n| 순위 | 코드 | 이름 | 분류 | 시총(억) | 순자산(억) | 괴리율% | 당일거래대금(억) |\n|---|---|---|---|---|---|---|---|")
for i,r in enumerate(rows[:100],1):
    log(f"| {i} | {r['code']} | {r['name']} | {r['theme']} | {r['mcap']:,.0f} | {'' if r['ntas'] is None else format(r['ntas']/1e8 if r['ntas']>1e9 else r['ntas'],',.0f')} | {'' if r['dprt'] is None else r['dprt']} | {'' if r['vol'] is None else format(r['vol']/1e8,',.1f')} |")
# ───────── B. 해외
log("\n## B. 해외 (KIS 해외종목마스터)")
OV={}
for fn,ex in (("nasmst","NAS"),("nysmst","NYS"),("amsmst","AMS")):
    try:
        z=zipfile.ZipFile(io.BytesIO(requests.get(M+fn+".cod.zip",timeout=40).content)); lines=z.read(z.namelist()[0]).decode("cp949","ignore").splitlines()
    except Exception as e:
        log(f"- {fn} 다운로드 실패: {e}"); continue
    n3=0; hit=[]
    for x in lines:
        f=x.split("\t")
        if len(f)<9: continue
        if f[8].strip()=="3":
            n3+=1
            if re.search(r"active|actively|managed|ARK |Dynamic",f[7],re.I): hit.append((f[4].strip(),f[7].strip(),ex))
    OV[ex]=(len(lines),n3,hit)
    log(f"- {ex}: 마스터 {len(lines)}행 · ETP(ETF·ETN 등, 구분 3) **{n3}개** · 이름에 Active/Managed 등이 있는 것 {len(hit)}개")
log(f"- 해외 ETP 합계 **{sum(v[1] for v in OV.values())}개**. KIS 마스터에도 '액티브' 구분 코드는 없습니다(US 액티브 ETF는 JEPI처럼 이름에 'Active'가 없는 경우가 많아 이름 패턴으로는 과소 집계).")
KNOWN="JEPI JEPQ ARKK ARKW ARKG ARKQ ARKF DYNF JAAA JBBB PULS FTSM ICSH MINT JPST NEAR BUCK CGDV CGGR CGUS CGXU CGCP DFAC DFUS DFAT DFAI DFIV DFEM AVUV AVDV AVEM AVUS AVLV SPYI QQQI BALI TSLY NVDY CONY MSTY YMAX ULTY BOND PYLD FBND JMST JPIE JAVA TOPT".split()
exof={}
for ex,(a,b,h) in OV.items():
    pass
# 심볼→거래소 (마스터 전체에서 재조회)
sym2ex={}
for fn,ex in (("nasmst","NAS"),("nysmst","NYS"),("amsmst","AMS")):
    try:
        z=zipfile.ZipFile(io.BytesIO(requests.get(M+fn+".cod.zip",timeout=40).content)); 
        for x in z.read(z.namelist()[0]).decode("cp949","ignore").splitlines():
            f=x.split("\t")
            if len(f)>=9 and f[8].strip()=="3": sym2ex[f[4].strip()]=(ex,f[7].strip(),f[6].strip())
    except Exception: pass
cand=[s for s in KNOWN if s in sym2ex]
cand+= [h[0] for v in OV.values() for h in v[2] if h[0] not in cand][:150]
log(f"\n- 대표 액티브 ETF 후보 {len(KNOWN)}개 중 KIS 마스터에 있는 것 {len([s for s in KNOWN if s in sym2ex])}개 + 이름 패턴 후보 → 시총 조회 대상 {len(cand)}개")
ov=[];shown=False
for s in cand:
    ex,en,kn=sym2ex[s]
    d=kget("/uapi/overseas-price/v1/quotations/price-detail","HHDFS76200200",{"AUTH":"","EXCD":ex,"SYMB":s}).get("output") or {}
    if not shown: log(f"- 해외 상세 응답 필드(샘플 {s}): {json.dumps(d,ensure_ascii=False)[:700]}"); shown=True
    tomv=num(d.get("tomv")); last=num(d.get("last")); shar=num(d.get("shar"))
    cap=tomv if tomv else (last*shar if last and shar else None)
    ov.append(dict(sym=s,ex=ex,name=en,kn=kn,last=last,cap=cap))
okc=[r for r in ov if r["cap"]]
okc.sort(key=lambda r:-r["cap"])
log(f"- 시가총액 확보 {len(okc)}개 / 조회 {len(ov)}개 (단위: 달러, KIS 필드 기준 — ETF는 상장주식수×가격 추정이라 실제 순자산과 다를 수 있음)")
log("\n| 순위 | 티커 | 거래소 | 이름 | 시총(백만달러) |\n|---|---|---|---|---|")
for i,r in enumerate(okc[:60],1): log(f"| {i} | {r['sym']} | {r['ex']} | {r['name'][:46]} | {r['cap']/1e6:,.0f} |")
log("\n### 조회했으나 시총 없음\n"+", ".join(r["sym"] for r in ov if not r["cap"]))
open("etf_active_study.md","w",encoding="utf-8").write("\n".join(L))
