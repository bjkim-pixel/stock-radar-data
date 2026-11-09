# -*- coding: utf-8 -*-
"""2027 예상실적 소스 점검 2차(읽기 전용): KIS 종목추정실적 커버리지 전체, FnGuide·와이즈리포트 연간 컨센서스 열."""
import os,sys,re,json,time,importlib,requests,psycopg2,collections
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
print("# A. FnGuide 메인(Financial Highlight 연간 열)")
for c in ["005930","192820","161890"]:
    for url in [f"https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A{c}&cID=&MenuYn=Y&ReportGB=&NewMenuID=101&stkGb=701",
                f"https://comp.fnguide.com/SVO2/ASP/SVD_Finance.asp?pGB=1&gicode=A{c}&cID=&MenuYn=Y&ReportGB=D&NewMenuID=103&stkGb=701"]:
        try:
            r=requests.get(url,headers=UA,timeout=25); t=r.text
            print(c,r.status_code,len(t),url.split("/")[-1][:20],sorted(set(re.findall(r"20\d\d/\d\d(?:\(E\))?",t)))[:14])
        except Exception as e: print(c,"ERR",e)
        time.sleep(0.4)
print("\n# B. 와이즈리포트(네이버 기업현황)")
for c in ["005930","192820"]:
    for url in [f"https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd={c}",
                f"https://navercomp.wisereport.co.kr/v2/company/ajax/cF1001.aspx?cmp_cd={c}&fin_typ=0&freq_typ=Y&encparam=&id="]:
        try:
            r=requests.get(url,headers={**UA,"Referer":"https://navercomp.wisereport.co.kr/"},timeout=25); t=r.text
            print(c,r.status_code,len(t),url.split("/")[-1][:30],sorted(set(re.findall(r"20\d\d/\d\d(?:\(E\))?",t)))[:14])
        except Exception as e: print(c,"ERR",e)
        time.sleep(0.4)
print("\n# C. KIS 종목추정실적 커버리지(DB 전 종목)")
tok=importlib.import_module("72_kis_token").get_token_cached(); K=os.environ["KIS_APP_KEY"]; S=os.environ["KIS_APP_SECRET"]
cur=psycopg2.connect(os.environ["SUPABASE_DB_URL"]).cursor(); cur.execute("select code from stocks where is_active and security_type='STOCK' order by code"); codes=[r[0] for r in cur.fetchall()]
H=lambda:{"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":K,"appsecret":S,"tr_id":"HHKST668300C0","custtype":"P"}
cnt=collections.Counter(); samp={}
for i,c in enumerate(codes):
    time.sleep(0.12)
    try:
        j=requests.get("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/estimate-perform",params={"SHT_CD":c},headers=H(),timeout=20).json()
    except Exception as e: cnt["err"]+=1; continue
    o4=j.get("output4") or []; o2=j.get("output2") or []
    has27=any("2027" in (x.get("dt") or "") for x in o4)
    key="2027있음" if has27 and o2 and (o2[0].get("data5") not in (None,"","0.0")) else ("열만있음" if o4 else "비어있음")
    cnt[key]+=1
    if len(samp)<4 or (key=="비어있음" and "empty" not in samp): samp[c if key!="비어있음" else "empty"]=(key,j.get("output1",{}).get("name1"),j.get("output1",{}).get("estdate"),o4[-2:])
print(dict(cnt),len(codes)); print(samp)
for c in ["005930","000660"]:
    j=requests.get("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/estimate-perform",params={"SHT_CD":c},headers=H(),timeout=20).json(); print(c,json.dumps(j,ensure_ascii=False)[:900])
