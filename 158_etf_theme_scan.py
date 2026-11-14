# -*- coding: utf-8 -*-
"""국내 ETF 전체를 업종·테마별로 분류해 시총 순으로 나열(읽기 전용). 액티브/패시브 구분 포함."""
import os,time,io,re,zipfile,requests,importlib
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
L=[]
def log(m=""): print(m,flush=True); L.append(m)
def kget(path,tr,params):
    time.sleep(0.08)
    for _ in range(2):
        try: return requests.get(B+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"}).json()
        except Exception: time.sleep(1)
    return {}
raw=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",timeout=30).content))
raw=raw.read(raw.namelist()[0]).decode("cp949","ignore").splitlines()
etfs=[(x[:9].strip(),x[21:-227].strip()) for x in raw if len(x)>=240 and x[-227:][:2]=="EF"]
EXC=re.compile(r"레버리지|인버스|2X|3X|선물|합성|채권|국고|머니마켓|CD금리|KOFR|SOFR|금리|단기|미국|중국|일본|글로벌|나스닥|S&P|차이나|인도|베트남|대만|유럽|선진|신흥|월드|아시아|해외|달러|금현물|골드|은$|구리|원유|WTI|리츠.*(미국|글로벌)|TDF|TRF|혼합")
FV=re.compile(r"구글|마이크로소프트|팔란티어|브로드컴|BYD|샤오미|엔비디아|테슬라|애플|아마존|TSMC|알리바바")
THEMES=[("반도체·AI반도체",r"반도체|HBM|소부장|비메모리|SK하이닉스|삼성전자"),("AI·소프트웨어·플랫폼·게임",r"플랫폼|인터넷|소프트웨어|AI|게임|인공지능|클라우드|데이터|메타버스"),
("바이오·헬스케어",r"바이오|제약|헬스케어|의료|신약|CDMO|의료기기"),("2차전지·전기차",r"2차전지|배터리|전기차|리튬|소재.*2차전지"),
("자동차·모빌리티",r"자동차|모빌리티|자율주행|친환경차|전장"),("전력·원전·신재생",r"전력|원자력|원전|신재생|태양광|풍력|수소|에너지|ESS|전력인프라|그리드|SMR"),
("조선·해운",r"조선|해운|선박|해양"),("방산·우주항공",r"방산|우주|항공|에어로|국방"),("금융(은행·증권·보험)",r"은행|증권|보험|금융|파이낸셜"),
("지주·지배구조",r"지주|지배구조|그룹주"),("화학·소재·철강",r"화학|소재|철강|비철|희토류|배터리소재|정유"),("소비·유통·음식료",r"소비|음식료|화장품|뷰티|K푸드|식품|유통|미디어|엔터|K컬처|콘텐츠"),
("건설·인프라·리츠",r"건설|인프라|리츠|부동산"),("통신·로봇·기계",r"통신|로봇|기계|장비|휴머노이드|광통신|위성")]
rows=[]
for i,(c,n) in enumerate(etfs):
    if EXC.search(n) or re.search(r"커버드콜",n): continue
    th=[t for t,p in THEMES if re.search(p,n)]
    if not th: continue
    p=kget("/uapi/domestic-stock/v1/quotations/inquire-price","FHKST01010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":c}).get("output") or {}
    try: mc=float(p.get("hts_avls") or 0)
    except: mc=0
    rows.append(dict(code=c,name=n,th=th,mc=mc,act=bool(re.search(r"액티브|KoAct|TIME |Active",n,re.I)),fv=bool(FV.search(n))))
log(f"# 국내 ETF 업종·테마 스캔 (전체 {len(etfs)}개 중 대상 {len(rows)}개, 레버리지·인버스·커버드콜·채권·해외지수 제외)\n")
for t,_ in THEMES:
    R=sorted([r for r in rows if t in r["th"]],key=lambda r:-r["mc"])
    na=sum(1 for r in R if r["act"])
    log(f"\n## {t} — ETF {len(R)}개(액티브 {na} · 패시브 {len(R)-na}), 시총 합 {sum(r['mc'] for r in R)/1e4:,.1f}조\n| 유형 | 코드 | 이름 | 시총(억) | 비고 |\n|---|---|---|---|---|")
    for r in R[:14]:
        log(f"| {'액티브' if r['act'] else '패시브'} | {r['code']} | {r['name']} | {r['mc']:,.0f} | {'해외 밸류체인?' if r['fv'] else ''}{' · 복수테마:'+'/'.join(x for x in r['th'] if x!=t) if len(r['th'])>1 else ''} |")
open("etf_theme_scan.md","w",encoding="utf-8").write("\n".join(L))
