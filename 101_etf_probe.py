# -*- coding: utf-8 -*-
"""국내 ETF 현황 점검(읽기 전용, DB 변경 없음): 인버스/레버리지/일반 ETF의 추세·거래대금."""
import os,sys,time,json,datetime,zipfile,io,re,requests,importlib,collections
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
KIS_BASE="https://openapi.koreainvestment.com:9443"
L=[]
def log(m=""): print(m,flush=True); L.append(m)
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.12)
    for _ in range(2):
        try:
            r=requests.get(KIS_BASE+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
            return r.json()
        except Exception: time.sleep(1)
    return {}
T=datetime.date.today()
log(f"# 국내 ETF 현황 ({T}, KIS 일봉 기준)\n")
z=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.zip",timeout=30).content)) if False else None
r=requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",timeout=30)
z=zipfile.ZipFile(io.BytesIO(r.content)); raw=z.read(z.namelist()[0]).decode("cp949","ignore").splitlines()
etfs=[]; grp=collections.Counter()
for x in raw:
    if len(x)<240: continue
    t=x[-228:]; g=t[:2]; grp[g]+=1
    if g=="EF": etfs.append((x[:9].strip(),x[21:-228].strip()))
log(f"- 코스피 마스터 {len(raw)}행 · 그룹코드 분포 {dict(grp)} · ETF {len(etfs)}개")
def kind(n):
    if re.search(r"곱버스|인버스\s*2X|2X\s*인버스|레버리지\s*인버스|인버스.*레버리지",n) : return "레버리지인버스"
    if "인버스" in n: return "인버스"
    if re.search(r"레버리지|2X|3X|\(합성\s*H?\)?.*2X",n): return "레버리지"
    return "일반"
def theme(n):
    if re.search(r"국채|채권|금리|머니마켓|CD|KOFR|SOFR|단기|회사채|하이일드|통안",n): return "채권·현금성"
    if re.search(r"미국|나스닥|S&P|NASDAQ|중국|차이나|일본|니케이|인도|베트남|유럽|글로벌|선진국|신흥|항셍|대만|필라델피아|월드",n): return "해외주식"
    if re.search(r"금현물|골드|은선물|원유|구리|농산물|WTI|천연가스|원자재|팔라듐|탄소|리츠|부동산",n): return "원자재·기타"
    return "국내주식(지수·업종·테마)"
def sma(v,n): return sum(v[-n:])/n if len(v)>=n else None
res=[]
d2=T; d1=T-datetime.timedelta(days=150)
for i,(code,nm) in enumerate(etfs):
    d=kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice","FHKST03010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":d1.strftime("%Y%m%d"),"FID_INPUT_DATE_2":d2.strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"})
    rows=[x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date") and float(x.get("stck_clpr") or 0)>0]
    rows.sort(key=lambda x:x["stck_bsop_date"])
    if len(rows)<25: continue
    c=[float(x["stck_clpr"]) for x in rows]; tv=[float(x.get("acml_tr_pbmn") or 0) for x in rows]
    ma20=sma(c,20); ma60=sma(c,60); ma20p=sum(c[-25:-5])/20
    last=c[-1]; hi60=max(c[-60:])
    above=0
    for k in range(len(c)-1,19,-1):
        if c[k]>sum(c[k-19:k+1])/20: above+=1
        else: break
    ret=lambda n:(last/c[-1-n]-1)*100 if len(c)>n else None
    res.append(dict(code=code,name=nm,kind=kind(nm),theme=theme(nm),last=last,date=rows[-1]["stck_bsop_date"],turn=sum(tv[-20:])/20/1e8,
        r5=ret(5),r20=ret(20),r60=ret(59),ma20=ma20,ma60=ma60,up20=ma20>ma20p,align=bool(ma60 and last>ma20>ma60),above=above,gap=(last/hi60-1)*100,n=len(c)))
    if i%100==0: log(f"  (진행 {i}/{len(etfs)})")
log(f"- 일봉 확보 {len(res)}개 (25봉 미만 제외)\n")
def f(v,d=1): return "-" if v is None else f"{v:.{d}f}"
def line(r): return f"| {r['code']} | {r['name'][:22]} | {r['theme'][:4]} | {r['turn']:.1f} | {f(r['r5'])} | {f(r['r20'])} | {f(r['r60'])} | {'정배열' if r['align'] else ('MA20위' if r['last']>(r['ma20'] or 9e18) else '-')} | {r['above']} | {f(r['gap'])} |"
HEAD="| 코드 | 이름 | 구분 | 20일평균거래대금(억) | 5일% | 20일% | 60일% | 추세 | MA20위 연속일 | 60일고가대비% |\n|---|---|---|---|---|---|---|---|---|---|"
def table(title,rs,n=20):
    log(f"## {title} ({len(rs)}개 중 거래대금 상위 {min(n,len(rs))})\n"); log(HEAD)
    for r in sorted(rs,key=lambda r:-r["turn"])[:n]: log(line(r))
    log("")
cnt=collections.Counter(r["kind"] for r in res); log("- 유형별 개수: "+json.dumps(dict(cnt),ensure_ascii=False)+"\n")
table("레버리지 인버스(곱버스)",[r for r in res if r["kind"]=="레버리지인버스"])
table("인버스 (1배)",[r for r in res if r["kind"]=="인버스"])
table("레버리지 (인버스 아님)",[r for r in res if r["kind"]=="레버리지"],15)
gen=[r for r in res if r["kind"]=="일반" and r["turn"]>=3]
log(f"## 일반 ETF 추세 요약 (20일 평균 거래대금 3억 이상 {len(gen)}개)\n")
tr=[r for r in gen if r["align"] and r["up20"] and (r["r60"] or 0)>0]
log(f"- 정배열(종가>MA20>MA60)+MA20 상승+60일 수익률>0: **{len(tr)}개** ({len(tr)/max(1,len(gen))*100:.0f}%)")
log(f"- 종가>MA20: {sum(1 for r in gen if r['last']>r['ma20'])}개 · 20일 수익률 +인 종목: {sum(1 for r in gen if (r['r20'] or 0)>0)}개\n")
bt=collections.defaultdict(list)
for r in gen: bt[r["theme"]].append(r)
for k,v in bt.items(): log(f"- {k}: {len(v)}개 중 상승추세 {sum(1 for r in v if r in tr)}개, 20일 평균수익률 {sum(r['r20'] or 0 for r in v)/len(v):.1f}%")
log("")
table("상승추세 일반 ETF — 지속성 순 (MA20 위 연속일, 거래대금 10억 이상)",sorted([r for r in tr if r["turn"]>=10],key=lambda r:-r["above"]),30)
table("상승추세 일반 ETF — 60일 수익률 순 (거래대금 10억 이상)",sorted([r for r in tr if r["turn"]>=10],key=lambda r:-(r["r60"] or 0)),30)
base=[r for r in res if r["code"] in ("069500","229200","122630","252670")]
table("기준: KODEX200/코스닥150/레버리지/200선물인버스2X",base)
open('etf_probe_report.md','w',encoding='utf-8').write("\n".join(L))
