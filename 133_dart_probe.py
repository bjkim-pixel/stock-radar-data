# -*- coding: utf-8 -*-
"""DART OpenAPI 점검(읽기 전용): 공시 유형 코드·보고서명 분포, 대량보유/임원소유 API 응답 필드, 고유번호 매핑."""
import os,sys,io,zipfile,json,collections,time,requests,xml.etree.ElementTree as ET
KEY=os.environ.get("DART_API_KEY","").strip()
if not KEY: sys.exit("DART_API_KEY 미설정")
B="https://opendart.fss.or.kr/api/"
BGN,END="20261102","20261108"
def call(ep,**p):
    time.sleep(0.15)
    r=requests.get(B+ep,params={"crtfc_key":KEY,**p},timeout=30)
    return r
def jl(ep,**p):
    j=call(ep,**p).json(); return j
def listall(**p):
    out=[];pg=1
    while True:
        j=jl("list.json",bgn_de=BGN,end_de=END,page_no=pg,page_count=100,**p)
        if j.get("status")!="000":
            print("   status",j.get("status"),j.get("message")); break
        out+=j.get("list",[]); 
        if pg>=int(j.get("total_page",1)): break
        pg+=1
    return out
print("# 1. 고유번호 파일")
r=call("corpCode.xml"); z=zipfile.ZipFile(io.BytesIO(r.content)); x=ET.fromstring(z.read(z.namelist()[0]))
rows=[(e.findtext("corp_code"),e.findtext("corp_name"),(e.findtext("stock_code") or "").strip()) for e in x.iter("list")]
listed=[r for r in rows if r[2]]
print("전체",len(rows),"상장(종목코드 있음)",len(listed),"예:",listed[:2])
print("\n# 2. 지분공시(D) 전체 11/2~11/8")
D=listall(pblntf_ty="D"); print("건수",len(D))
c=collections.Counter(d["report_nm"].split("(")[0].strip() for d in D)
for k,v in c.most_common(15): print("  ",v,k)
asset=[d for d in D if "자산운용" in d.get("flr_nm","")]
print("flr_nm에 '자산운용' 포함:",len(asset),"· 상장사 종목코드 있는 것:",sum(1 for d in asset if d.get("stock_code","").strip()))
print("샘플",json.dumps(D[0],ensure_ascii=False))
print("\n# 3. pblntf_detail_ty 코드별 건수(기간 동일)")
for t in ["D001","D002","D003","D004","D005","D006","B001","B002","B003","E001","E002","E003","E004","E005","E006","E007","E008","E009","I001","I002","I003","I004","I005","I006","C001","C002","C003","C004","C005"]:
    L=listall(pblntf_detail_ty=t)
    names=collections.Counter(d["report_nm"].split("(")[0].strip() for d in L).most_common(4)
    print(f"  {t}: {len(L)}건",names)
print("\n# 4. 대량보유 API(majorstock) 샘플")
smp=[d for d in D if "대량보유" in d["report_nm"] and d.get("stock_code","").strip()][:3]
for d in smp:
    j=jl("majorstock.json",corp_code=d["corp_code"])
    print(d["corp_name"],d["report_nm"],d["flr_nm"],d["rcept_no"],"status",j.get("status"))
    for it in j.get("list",[])[:3]: print("   ",json.dumps(it,ensure_ascii=False))
print("\n# 5. 임원·주요주주 소유보고(elestock) 샘플")
smp=[d for d in D if "임원" in d["report_nm"] and d.get("stock_code","").strip()][:2]
for d in smp:
    j=jl("elestock.json",corp_code=d["corp_code"])
    print(d["corp_name"],d["report_nm"],d["flr_nm"],d["rcept_no"],"status",j.get("status"))
    for it in j.get("list",[])[:3]: print("   ",json.dumps(it,ensure_ascii=False))
print("\n# 6. 주요사항보고서(B) 보고서명 분포")
Bl=listall(pblntf_ty="B"); print("건수",len(Bl))
for k,v in collections.Counter(d["report_nm"].split("(")[0].strip().replace("[기재정정]","").replace("[첨부정정]","") for d in Bl).most_common(25): print("  ",v,k)
print("\n# 7. 자기주식 취득 결정 API 샘플(tsstkAqDecsn)")
smp=[d for d in Bl if "자기주식취득" in d["report_nm"].replace(" ","")][:1]
for d in smp:
    j=jl("tsstkAqDecsn.json",corp_code=d["corp_code"],bgn_de=BGN,end_de=END)
    print(d["corp_name"],d["report_nm"],"status",j.get("status")); print(json.dumps((j.get("list") or [{}])[0],ensure_ascii=False)[:800])
