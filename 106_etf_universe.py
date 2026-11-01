# -*- coding: utf-8 -*-
"""ETF 후보 유니버스(읽기 전용): 확정100 + 액티브 + 국가지수 ETF, 시총·평균거래량·거래대금·추세 포함 CSV."""
import os,sys,time,json,datetime,zipfile,io,re,requests,importlib,csv
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
CONF=set(['305720', '364980', '0209D0', '0005D0', '462010', '305540', '461950', '458730', '161510', '466940', '157500', '091220', '139270', '139260', '329200', '0219B0', '122630', '114800', '252670', '233740', '494310', '0193T0', '0197X0', '462330', '251340', '0193W0', '243880', '412570', '0193L0', '271050', '0100K0', '176950', '0148J0', '0173Y0', '456600', '445290', '133690', '360750', '426030', '381170', '465580', '0015B0', '364970', '0168K0', '396500', '091160', '0167A0', '455850', '395270', '381180', '471990', '475300', '442580', '390390', '475310', '0182R0', '469150', '471760', '497570', '446770', '0239Z0', '396520', '0162L0', '466920', '0080G0', '449450', '463250', '0183J0', '421320', '0207G0', '0090B0', '487240', '0091P0', '487230', '457990', '367760', '0098F0', '434730', '404120', '411060', '144600', '261220', '160580', '471230', '451530', '439870', '228790', '117700', '475050', '228810', '364990', '228800', '438900', '395150', '069500', '229200', '292150', '102780', '418670', '488770'])
z=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",timeout=30).content))
raw=z.read(z.namelist()[0]).decode("cp949","ignore").splitlines()
etfs=[(x[:9].strip(),x[21:-227].strip()) for x in raw if len(x)>=240 and x[-227:][:2]=="EF"]
COUNTRY=[("일본",r"일본|니케이|TOPIX|도쿄|엔화"),("대만",r"대만|타이완|TSMC"),("중국",r"중국|차이나|CSI|항셍|홍콩|H주|과창판|심천|상해|China"),("인도",r"인도|Nifty|니프티"),("베트남",r"베트남"),("유럽",r"유럽|독일|프랑스|영국|유로|스톡스|STOXX|DAX|이탈리아|스페인|네덜란드"),("미국",r"미국|나스닥|S&P|NASDAQ|다우|필라델피아|러셀"),("신흥국·글로벌",r"신흥|선진국|글로벌|MSCI|월드|전세계|ACWI|이머징|아시아"),("기타국가",r"브라질|멕시코|인도네시아|사우디|러시아|호주|캐나다|터키|남미|아세안|중동|동남아")]
def country(n):
    for k,p in COUNTRY:
        if re.search(p,n): return k
    return ""
def flags(n):
    f=[]
    for k,p in (("합성",r"합성"),("혼합",r"혼합"),("선물",r"선물"),("환헤지(H)",r"\(H\)|합성 H"),("레버리지",r"레버리지|2X|3X"),("인버스",r"인버스"),("커버드콜",r"커버드콜"),("액티브",r"액티브|KoAct|TIME "),("TR",r"TR$|TR\)")):
        if re.search(p,n): f.append(k)
    return "/".join(f)
def theme(n):
    if re.search(r"CD금리|머니마켓|KOFR|SOFR|초단기|단기채|단기통안|파킹|단기금융",n): return "현금성"
    if re.search(r"국고채|국채|채권|통안|회사채|하이일드|금리|크레딧|금융채",n): return "채권"
    if re.search(r"금현물|골드|은선물|원유|구리|농산물|WTI|천연가스|원자재|달러|엔화|환율",n): return "원자재·통화"
    if country(n): return "해외주식"
    return "국내주식"
d1=T-datetime.timedelta(days=150)
rows=[]
for i,(code,nm) in enumerate(etfs):
    d=kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice","FHKST03010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_INPUT_DATE_1":d1.strftime("%Y%m%d"),"FID_INPUT_DATE_2":T.strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"})
    rs=sorted([x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date") and float(x.get("stck_clpr") or 0)>0],key=lambda x:x["stck_bsop_date"])
    if len(rs)<20: continue
    c=[float(x["stck_clpr"]) for x in rs]; v=[float(x.get("acml_vol") or 0) for x in rs]; tv=[float(x.get("acml_tr_pbmn") or 0) for x in rs]
    ma20=sum(c[-20:])/20; ma60=sum(c[-60:])/60 if len(c)>=60 else None; above=0
    for k in range(len(c)-1,18,-1):
        if c[k]>sum(c[k-19:k+1])/20: above+=1
        else: break
    ret=lambda n:(c[-1]/c[-1-n]-1)*100 if len(c)>n else None
    rows.append(dict(code=code,name=nm,n=len(c),vol20=sum(v[-20:])/20,tv20=sum(tv[-20:])/20/1e8,tv60=sum(tv[-60:])/len(tv[-60:])/1e8,r20=ret(20),r60=ret(59),trend="정배열" if ma60 and c[-1]>ma20>ma60 else ("MA20위" if c[-1]>ma20 else "-"),above=above))
    if i%150==0: log(f"  (일봉 {i}/{len(etfs)})")
log(f"- ETF {len(etfs)}개 중 일봉 확보 {len(rows)}개")
def src(r):
    a=[]
    if r["code"] in CONF: a.append("확정100")
    if re.search(r"액티브|KoAct|TIME ",r["name"]) and r["tv20"]>=1: a.append("액티브")
    if country(r["name"]) and country(r["name"])!="미국" and r["tv20"]>=0.5: a.append("국가지수")
    return "+".join(a)
sel=[r for r in rows if src(r)]
log(f"- 선정 대상 {len(sel)}개")
shown=False
for r in sel:
    p=kget("/uapi/domestic-stock/v1/quotations/inquire-price","FHKST01010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":r["code"]}).get("output") or {}
    r["mcap"]=p.get("hts_avls"); r["stcn"]=p.get("lstn_stcn")
    e=kget("/uapi/etfetn/v1/quotations/inquire-price","FHPST02400000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":r["code"]}).get("output") or {}
    if not shown: log(f"- ETF 현재가 응답 필드(샘플 {r['code']}): {json.dumps(e,ensure_ascii=False)[:600]}"); shown=True
    r["nav"]=e.get("nav"); r["dprt"]=e.get("dprt"); r["ntas"]=e.get("etf_ntas_ttam")
def num(x):
    try: return float(x)
    except Exception: return None
def ordk(r):
    s=src(r)
    return 0 if s.startswith("확정100") else (1 if s.startswith("액티브") else 2)
sel.sort(key=lambda r:(ordk(r),-(num(r["mcap"]) or 0)))
with open("etf_universe.csv","w",encoding="utf-8-sig",newline="") as f:
    w=csv.writer(f); w.writerow(["코드","이름","출처","분류","국가","특성","시가총액(억)","순자산총액","NAV괴리율(%)","상장주식수","20일평균거래량(주)","20일평균거래대금(억)","60일평균거래대금(억)","20일수익률%","60일수익률%","추세","MA20위연속일","봉수(최대100)"])
    for r in sel:
        w.writerow([r["code"],r["name"],src(r),theme(r["name"]),country(r["name"]),flags(r["name"]),num(r["mcap"]),num(r["ntas"]),num(r["dprt"]),num(r["stcn"]),round(r["vol20"]),round(r["tv20"],1),round(r["tv60"],1),None if r["r20"] is None else round(r["r20"],1),None if r["r60"] is None else round(r["r60"],1),r["trend"],r["above"],r["n"]])
cnt={}
for r in sel:
    for s in src(r).split("+"): cnt[s]=cnt.get(s,0)+1
log(f"- 출처별 개수(중복 포함): {cnt}")
cc={}
for r in sel:
    k=country(r["name"]) or "(국가 없음)"; cc[k]=cc.get(k,0)+1
log(f"- 국가별: {cc}")
open('etf_universe_report.md','w',encoding='utf-8').write("\n".join(L))
