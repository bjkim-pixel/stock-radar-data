# -*- coding: utf-8 -*-
"""KIS 채권 3차 점검(읽기 전용): 잔존만기 6개월 이내 채권이 있는지, 호가·수익률이 있는 종목이 몇 개인지."""
import os,sys,time,json,datetime,re,zipfile,io,requests,collections,importlib
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
KIS_BASE="https://openapi.koreainvestment.com:9443"
L=[]
def log(m=""): print(m,flush=True); L.append(m)
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.15)
    try:
        r=requests.get(KIS_BASE+"/uapi/domestic-bond/v1/quotations/"+path,params=params,timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"})
        return r.json()
    except Exception as e: return {"rt_cd":"x","msg1":str(e)[:80]}
T=datetime.date.today(); today=T.strftime("%Y%m%d"); lim=(T+datetime.timedelta(days=183)).strftime("%Y%m%d")
log(f"# KIS 채권 3차: 잔존만기 6개월 이내 ({T} ~ {lim})\n")
z=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/bond_code.mst.zip",timeout=30).content))
raw=z.read(z.namelist()[0]).decode("cp949","ignore").splitlines()
rows=[]
for x in raw:
    m=re.search(r"KR[0-9A-Z]{10}",x)
    if not m: continue
    rest=x[m.end():]; d=re.search(r"(\d{2})(\d{8})(\d{8})(\d{8})",rest)
    if not d: continue
    nm=rest[:d.start()].strip(); rd=d.group(4)
    rows.append((m.group(0),nm,rd,x[:2]))
alive=[r for r in rows if r[2]>=today]
short=[r for r in alive if r[2]<=lim]
def cat(n):
    for k,p in (("국고채","국고"),("통안채","통안"),("산금채","산금"),("은행채","은행"),("국민주택","국민주택"),("한전채","한전"),("카드/캐피탈","카드|캐피탈|파이낸|금융"),("지방·공사","도시|지방|공사|공단")):
        if re.search(p,n): return k
    return "기타(회사채 등)"
cnt=collections.Counter(cat(r[1]) for r in short)
log(f"- 마스터 {len(rows)}개 · 만기 미도래 {len(alive)}개 · **6개월 이내 만기 {len(short)}개**")
log("- 6개월 이내 분류별 개수: "+json.dumps(dict(cnt),ensure_ascii=False))
# 분류별 최대 25개씩 시세 조회 (국고/통안은 전부 우선)
pick=[]; per=collections.defaultdict(list)
for r in sorted(short,key=lambda r:r[2]): per[cat(r[1])].append(r)
for k,v in per.items():
    step=max(1,len(v)//25); pick+= [(k,)+r for r in v[::step][:25]]
log(f"- 시세 조회 대상 {len(pick)}개\n")
log("## 호가(수익률) 있는 종목")
ok=0; zero=collections.Counter(); tot=collections.Counter()
for k,code,nm,rd,tp in pick:
    tot[k]+=1
    d=kget("inquire-asking-price","FHKBJ773401C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":code}); o=d.get("output") or {}
    ask=o.get("seln_ernn_rate1"); bid=o.get("shnu_ernn_rate1")
    has=any(float(v or 0)>0 for v in (ask,bid))
    if not has: zero[k]+=1; continue
    ok+=1
    p=kget("inquire-price","FHKBJ773400C0",{"FID_COND_MRKT_DIV_CODE":"B","FID_INPUT_ISCD":code}).get("output") or {}
    i=kget("issue-info","CTPF1101R",{"PDNO":code,"PRDT_TYPE_CD":"302"}).get("output") or {}
    g=i.get("nice_crdt_grad_text") or i.get("kis_crdt_grad_text") or ""
    log(f"- [{k}] {code} {nm} · 만기 {rd} · 표면 {i.get('srfc_inrt')} · 현재가 {p.get('bond_prpr')} · 체결수익률 {p.get('ernn_rate')} · 매도1호가 {o.get('bond_askp1')}/수익률 {ask} · 매수1호가 {o.get('bond_bidp1')}/수익률 {bid} · 등급 {g}")
log(f"\n## 요약: 조회 {len(pick)}개 중 호가 있는 종목 {ok}개")
log("- 분류별 호가 없음/조회: "+json.dumps({k:f"{zero[k]}/{tot[k]}" for k in tot},ensure_ascii=False))
open('bond_probe3_report.md','w',encoding='utf-8').write("\n".join(L))
