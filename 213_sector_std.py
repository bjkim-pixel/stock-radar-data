# -*- coding: utf-8 -*-
"""해외 일반종목 → 우리 업종(23개 체계) 매핑. us_master.sector_std 채움. 국내 업종은 건드리지 않음.
우선순위: 네이버 industry 매핑 → (매핑 없음) KIS sector 매핑. 판단 보류 업종은 NULL로 두고 리포트."""
import os, re, psycopg2, collections
N={
"반도체":"반도체 반도체장비및테스트 반도체패키징테스트",
"바이오":"제약 생명공학및의학연구 의료장비물품및유통 첨단의료장비및기술 의료시설및서비스 의료관리",
"금융":"은행 투자은행및중개서비스 투자관리및펀드운영 생명및건강보험 손해보험 소비자대출 금융상품시장운영및서비스제공 다각적투자서비스",
"IT/플랫폼":"소프트웨어 온라인서비스 IT서비스및컨설팅 컴퓨터하드웨어 전자장비및부품",
"통신":"통신및네트워킹 통합통신서비스 무선통신서비스",
"전력/에너지":"전력유틸리티 민자발전사업 유틸리티 복합유틸리티 통합오일및가스 오일가스정제및마케팅 오일및가스수송서비스 오일가스탐사및생산 석탄 우라늄 재생가능에너지장비및서비스 전기부품및장비 중전기장비",
"화학/소재":"상품화학 특수화학제 다각적화학산업 금 특수채굴및금속 다각적채굴 타이어및고무제품",
"자동차":"자동차및트럭제조 자동차트럭및오토바이부품",
"방산":"항공우주및방위",
"조선/해운":"해양화물및물류 조선",
"인프라":"고속도로및철도 지상및해상여객운송 지상화물및물류 건설및엔지니어링",
"건설":"건설자재및비품 건설자재 주택개조제품및서비스소매",
"기계":"산업용기계및장비 중장비및차량 로봇",
"부동산":"특수REITs 상업용REITs 부동산임대개발및운영",
"소비재":"가전제품도구및가정용품 가정용전자제품 무알콜음료 증류주및포도주 담배 식품가공 식품소매및유통 어업및농업 개인생활필수용품 백화점 할인점 기타전문소매 의류및액세서리 의류및액세서리소매 레스토랑및바 장난감및어린이제품 경영지원서비스 고용서비스",
}
HOLD="소비재대기업 다각적산업용제품도매 블록체인및암호화폐 전화및소형장치 방송 여가및오락시설".split()
K={
"금융":"상업은행 보험 금융서비스","반도체":"반도체및반도체장비","바이오":"제약 바이오 건강관리장비및서비스",
"IT/플랫폼":"인터넷소프트웨어및IT서비스 컴퓨터전자장비/기기 미디어","통신":"통신장비 유선및기타통신 무선통신",
"전력/에너지":"에너지및관련서비스 공익사업 전기","화학/소재":"화학 금속&채광","자동차":"자동차 자동차관련부품",
"방산":"우주항공및국방","조선/해운":"해운","부동산":"REIT's및부동산관리개발","기계":"기계및전기장비 복합기업 무역회사",
"건설":"건설및건축제품 건축자재","인프라":"운송인프라",
"소비재":"음식료및담배생산 가정용내구재 도/소매 섬유의복및호화제품 여행서비스및제품 가정및개인용품 상업및전문서비스 음식료도매"}
nz=lambda s:re.sub(r"[\s,·]","",s or "")
NM={nz(x):k for k,v in N.items() for x in v.split()}; KM={nz(x):k for k,v in K.items() for x in v.split()}
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor()
c.execute("alter table us_master add column if not exists sector_std text")
c.execute("alter table us_master add column if not exists sector_std_src text")
c.execute("select code,coalesce(name_ko,name_en),sector,profile->>'industry' from us_master where not is_etf order by code")
R=c.fetchall(); out=collections.defaultdict(list); hold=[]; unm=collections.Counter(); diff=[]
for code,nm,ks,ni in R:
    a=NM.get(nz(ni)); b=KM.get(nz(ks)); s=src=None
    if nz(ni) in HOLD: hold.append((code,nm,ni,ks,b)); 
    elif a: s,src=a,"naver"
    elif b: s,src=b,"kis"
    else: unm[(ni,ks)]+=1
    if a and b and a!=b: diff.append((code,nm,ni,ks,a,b))
    c.execute("update us_master set sector_std=%s,sector_std_src=%s where code=%s",(s,src,code))
c.execute("update us_master set sector_std=null,sector_std_src=null where is_etf")
cn.commit()
cnt=collections.Counter(); c.execute("select sector_std,count(*) from us_master where not is_etf group by 1 order by 2 desc"); cnt=c.fetchall()
o=[f"# 해외 업종 매핑 적용 · {len(R)}종목\n","## 분포\n"+", ".join(f"{a or '(보류/미매핑)'}({b})" for a,b in cnt)+"\n"]
o.append(f"## 판단 보류 업종 종목 {len(hold)}\n(코드 이름 | 네이버 | KIS | KIS기준 후보)\n"+"\n".join(f"- {a} {b} | {c_} | {d} | {e}" for a,b,c_,d,e in hold)+"\n")
o.append(f"## 매핑 누락(네이버·KIS 모두 미대응) {sum(unm.values())}\n"+"\n".join(f"- {k}: {v}" for k,v in unm.items())+"\n")
o.append(f"## 네이버 vs KIS 결과가 다른 종목 {len(diff)}\n(코드 이름 | 네이버업종 | KIS업종 | 네이버결과 | KIS결과)\n"+"\n".join(f"- {a} {b} | {c_} | {d} | {e} | {f}" for a,b,c_,d,e,f in diff))
open("sector_std.md","w").write("\n".join(o))
