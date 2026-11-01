# -*- coding: utf-8 -*-
"""ETF 최종 후보 중복 점검(읽기 전용): 후보100 + 업종동향 ETF → 클러스터별 상관관계로 사실상 중복 쌍 탐지."""
import os,sys,time,json,datetime,zipfile,io,re,requests,importlib,collections,math
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
PICK=['코드', '459580', '488770', '코드', '122630', '114800', '252670', '233740', '494310', '0193T0', '0197X0', '251340', '0193W0', '462330', '243880', '412570', '423920', '418660', '0193L0', '271050', '267770', '0100K0', '176950', '465350', '코드', '069500', '229200', '396500', '0167A0', '498400', '455850', '487240', '472150', '305720', '395270', '471990', '475300', '139260', '364980', '278530', '0209D0', '0148J0', '226490', '466920', '0091P0', '0080G0', '0117V0', '0182R0', '469150', '292150', '0177R0', '0005D0', '228790', '475310', '0094M0', '471760', '462010', '449450', '237350', '498410', '117700', '457990', '161510', '466940', '0098F0', '코드', '360750', '133690', '381180', '442580', '426030', '390390', '458730', '381170', '486290', '0173Y0', '465580', '487230', '497570', '446770', '0183J0', '456600', '494300', '490590', '441640', '0015B0', '396520', '0162L0', '491620', '414780', '482730', '코드', '475630', '0162Z0', '448330', '284430', '0183V0', '476550', '코드', '411060', '144600', '코드', '463250', '305540', '329200', '367760', '102780']
SITE=[('KODEX 반도체', '091160'), ('SOL 반도체전공정', None), ('SOL 반도체후공정', None), ('KODEX AI전력핵심설비', None), ('RISE 네트워크인프라', None), ('PLUS 우주항공', None), ('SOL 우주항공밸류체인', None), ('KoAct 광통신&위성네트워크액티브', None), ('PLUS K방산', None), ('PLUS K방산소부장', None), ('SOL 조선TOP3플러스', None), ('HANARO 원자력iSelect', None), ('TIME K신재생에너지액티브', None), ('PLUS 태양광&ESS', None), ('KODEX 2차전지핵심소재10', None), ('KODEX 전고체배터리ESS TOP2플러스', None), ('KODEX 로봇액티브', None), ('TIGER 코리아휴머노이드로봇산업', None), ('TIGER 바이오TOP10', None), ('TIGER 기술이전바이오액티브', None), ('TIGER 증권', None), ('TIGER 은행', None), ('TIGER 200 금융', None), ('KODEX 건설', None), ('ACE KPOP포커스', None), ('KODEX 웹툰&드라마', '395150'), ('TIGER 미디어컨텐츠', None), ('TIGER 게임TOP10', None), ('TIGER 화장품', None), ('HANARO Fn K-푸드', '438900'), ('TIGER 여행레저', None), ('KODEX 코스닥150', '229200')]
z=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",timeout=30).content))
raw=z.read(z.namelist()[0]).decode("cp949","ignore").splitlines()
M={x[:9].strip():x[21:-227].strip() for x in raw if len(x)>=240 and x[-227:][:2]=="EF"}
norm=lambda s:re.sub(r"[\s\(\)\-]","",s).upper()
byn={norm(n):c for c,n in M.items()}
cand={}
for c in PICK: cand[c]="신규"
unres=[]
for n,f in SITE:
    c=f or byn.get(norm(n))
    if not c:
        core=norm(" ".join(n.split()[1:])); h=[cc for nn,cc in byn.items() if core and nn.endswith(core)]
        c=h[0] if len(h)==1 else None
    if not c: unres.append(n); continue
    cand[c]="사이트+신규" if cand.get(c)=="신규" else "사이트"
log(f"# ETF 최종 후보 중복 점검 ({T})\n\n- 후보 100 + 업종동향 {len(SITE)} → 합집합 {len(cand)}개 (사이트와 겹침 {sum(1 for v in cand.values() if v=='사이트+신규')}개)")
if unres: log(f"- 코드 못 찾음: {unres}")
d1=T-datetime.timedelta(days=150)
D={}
for c in cand:
    d=kget("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice","FHKST03010100",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":c,"FID_INPUT_DATE_1":d1.strftime("%Y%m%d"),"FID_INPUT_DATE_2":T.strftime("%Y%m%d"),"FID_PERIOD_DIV_CODE":"D","FID_ORG_ADJ_PRC":"0"})
    rows=sorted([x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date") and float(x.get("stck_clpr") or 0)>0],key=lambda x:x["stck_bsop_date"])
    if len(rows)<20: continue
    D[c]=dict(px={x["stck_bsop_date"]:float(x["stck_clpr"]) for x in rows},turn=sum(float(x.get("acml_tr_pbmn") or 0) for x in rows[-20:])/20/1e8,n=len(rows),first=rows[0]["stck_bsop_date"])
def rets(c):
    ks=sorted(D[c]["px"]); return {ks[i]:D[c]["px"][ks[i]]/D[c]["px"][ks[i-1]]-1 for i in range(1,len(ks))}
R={c:rets(c) for c in D}
def corr(a,b):
    ks=sorted(set(R[a])&set(R[b]))
    if len(ks)<40: return None
    x=[R[a][k] for k in ks]; y=[R[b][k] for k in ks]; mx=sum(x)/len(x); my=sum(y)/len(y)
    sxy=sum((p-mx)*(q-my) for p,q in zip(x,y)); sx=math.sqrt(sum((p-mx)**2 for p in x)); sy=math.sqrt(sum((q-my)**2 for q in y))
    return sxy/(sx*sy) if sx and sy else None
CL=[("레버리지·인버스",r"레버리지|인버스|2X"),("현금성",r"CD금리|머니마켓|KOFR|초단기"),("커버드콜",r"커버드콜"),("반도체",r"반도체|HBM|하이닉스"),("2차전지·배터리",r"2차전지|배터리|전고체"),("방산·우주·조선",r"방산|우주|조선|항공"),("원자력·전력·에너지",r"원자력|SMR|전력|태양광|ESS|신재생|에너지|네트워크인프라"),("로봇·AI",r"로봇|AI|인공지능|사이버"),("바이오",r"바이오"),("금융·배당",r"금융|은행|증권|배당|고배당|밸류업"),("콘텐츠·소비",r"KPOP|웹툰|미디어|게임|화장품|푸드|여행|레저|건설"),("미국 지수·빅테크",r"미국S&P|미국나스닥|미국테크|빅테크|S&P500|나스닥100"),("한국 지수",r"KODEX 200|코스닥150|코스피|코리아TOP10|삼성그룹|^KODEX 200TR"),("채권·혼합",r"채권|국채|국고채|혼합"),("원자재",r"금현물|은선물|원유|구리")]
def cl(n):
    for k,p in CL:
        if re.search(p,n): return k
    return "기타"
G=collections.defaultdict(list)
for c in D: G[cl(M[c])].append(c)
log("")
dups=[]
for k,_ in CL+[("기타","")]:
    cs=sorted(G.get(k,[]),key=lambda c:-D[c]["turn"])
    if not cs: continue
    log(f"## {k} ({len(cs)}개)\n\n| 코드 | 이름 | 출처 | 20일평균거래대금(억) | 상장 후 봉수 | 가장 비슷한 종목(상관) |\n|---|---|---|---|---|---|")
    for c in cs:
        best=None
        for o in cs:
            if o==c: continue
            r=corr(c,o)
            if r is not None and (best is None or r>best[1]): best=(o,r)
        nb=f"{M[best[0]][:16]} ({best[1]:.2f})" if best else "-"
        log(f"| {c} | {M[c][:26]} | {cand[c]} | {D[c]['turn']:.0f} | {D[c]['n']} | {nb} |")
        if best and best[1]>=0.95 and c<best[0]: dups.append((c,best[0],best[1]))
    log("")
log(f"## 상관 0.95 이상 = 사실상 중복 쌍 ({len(dups)}쌍, 같은 클러스터 내)\n\n| A | B | 상관 | 거래대금(억) A/B | 출처 A/B |\n|---|---|---|---|---|")
for a,b,r in sorted(dups,key=lambda t:-t[2]): log(f"| {M[a][:22]} | {M[b][:22]} | {r:.3f} | {D[a]['turn']:.0f}/{D[b]['turn']:.0f} | {cand[a]}/{cand[b]} |")
open('etf_final_report.md','w',encoding='utf-8').write("\n".join(L))
