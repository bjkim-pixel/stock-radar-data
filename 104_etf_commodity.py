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
import re as _re
PAT=_re.compile(r"구리|원유|석유|WTI|브렌트|에너지|정유|천연가스|가스|원자재|농산물|팔라듐|백금|니켈|금현물|골드|금선물|은선물|국제금|탄소|액티브")
etfs=[(x[:9].strip(),x[21:-227].strip(),x[-227:][:2]) for x in raw if len(x)>=240 and x[-227:][:2] in ("EF","EN") and PAT.search(x[21:-227])]
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
for code,nm,g in etfs:
    d=kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice","FHKST03010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":d1.strftime("%Y%m%d"),"FID_INPUT_DATE_2":d2.strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"})
    rows=sorted([x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date") and float(x.get("stck_clpr") or 0)>0],key=lambda x:x["stck_bsop_date"])
    if len(rows)<20: continue
    c=[float(x["stck_clpr"]) for x in rows]; tv=[float(x.get("acml_tr_pbmn") or 0) for x in rows]
    ret=lambda n:(c[-1]/c[-1-n]-1)*100 if len(c)>n else None
    ma20=sum(c[-20:])/20; ma60=sum(c[-60:])/60 if len(c)>=60 else None
    above=0
    for k in range(len(c)-1,18,-1):
        if c[k]>sum(c[k-19:k+1])/20: above+=1
        else: break
    res.append(dict(code=code,name=nm,g=g,n=len(c),turn20=sum(tv[-20:])/20/1e8,r20=ret(20),r60=ret(59),trend="정배열" if ma60 and c[-1]>ma20>ma60 else ("MA20위" if c[-1]>ma20 else "-"),above=above))
def sec(n):
    if re.search(r"구리",n): return "구리"
    if re.search(r"원유|석유|WTI|브렌트|정유|에너지|천연가스|가스",n): return "원유·에너지"
    if re.search(r"금|골드",n) and not re.search(r"금융|금리|은행",n): return "금"
    if re.search(r"은선물|은$",n): return "은"
    if re.search(r"농산물|팔라듐|백금|니켈|원자재|탄소",n): return "기타 원자재"
    return "액티브(기타)"
log(f"# 구리·원유·에너지·원자재 + 액티브 ETF/ETN ({T})\n\n- 대상 이름 필터 일치 {len(etfs)}개 중 일봉 확보 {len(res)}개\n")
def f1(v): return "-" if v is None else f"{v:.1f}"
for s_ in ("구리","원유·에너지","금","은","기타 원자재"):
    for g,lab in (("EF","ETF"),("EN","ETN")):
        cs=sorted([r for r in res if sec(r["name"])==s_ and r["g"]==g],key=lambda r:-r["turn20"])
        if not cs: continue
        log(f"## {s_} — {lab} ({len(cs)}개)\n\n| 코드 | 이름 | 20일평균거래대금(억) | 20일% | 60일% | 추세 | MA20위 연속일 |\n|---|---|---|---|---|---|---|")
        for r in cs[:15]: log(f"| {r['code']} | {r['name'][:28]} | {r['turn20']:.1f} | {f1(r['r20'])} | {f1(r['r60'])} | {r['trend']} | {r['above']} |")
        log("")
ac=sorted([r for r in res if sec(r["name"])=="액티브(기타)" and r["g"]=="EF"],key=lambda r:-r["turn20"])
log(f"## 액티브 ETF ({len(ac)}개 중 거래대금 상위 30)\n\n| 코드 | 이름 | 20일평균거래대금(억) | 20일% | 60일% | 추세 | MA20위 연속일 |\n|---|---|---|---|---|---|---|")
for r in ac[:30]: log(f"| {r['code']} | {r['name'][:28]} | {r['turn20']:.1f} | {f1(r['r20'])} | {f1(r['r60'])} | {r['trend']} | {r['above']} |")
tr=[r for r in ac if r["trend"]=="정배열" and r["turn20"]>=10 and not re.search(r"머니마켓|CD|KOFR|단기",r["name"])]
log(f"\n## 액티브 중 정배열(현금성 제외, 거래대금 10억+) {len(tr)}개\n\n| 코드 | 이름 | 20일평균거래대금(억) | 20일% | 60일% | MA20위 연속일 |\n|---|---|---|---|---|---|")
for r in sorted(tr,key=lambda r:-r["above"])[:25]: log(f"| {r['code']} | {r['name'][:28]} | {r['turn20']:.1f} | {f1(r['r20'])} | {f1(r['r60'])} | {r['above']} |")
open('etf_commodity_report.md','w',encoding='utf-8').write("\n".join(L))
