# -*- coding: utf-8 -*-
"""K-컬처 분리(엔터·미디어 / 화장품), 종합상사 추가, 화장품 종목(이미지 목록) 재분류. 국내는 sector_override, 해외는 us_master.sector_std."""
import os, re, psycopg2
cn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c=cn.cursor(); o=[]
nz=lambda s:re.sub(r"\s","",s or "")
c.execute("select s.code,s.name,v.sector from stocks s left join v_stock_sector v on v.code=s.code where s.security_type='STOCK'")
ST=c.fetchall(); byname={}
for code,nm,sec in ST: byname.setdefault(nz(nm),[]).append((code,nm,sec))
def setsec(code,sec,note):
    c.execute("insert into sector_override(code,sector_override,note) values(%s,%s,%s) on conflict (code) do update set sector_override=excluded.sector_override,note=excluded.note",(code,sec,note))
# 1) 엔터·미디어 (기존 K-컬처 중 엔터/콘텐츠)
ENT="352820 041510 035900 122870 035760 253450 419530 079160 214320".split()
o.append("## 엔터·미디어(국내)")
for code in ENT:
    setsec(code,"엔터·미디어","K-컬처 분리: 엔터·미디어"); o.append(f"- {code} {[n for k,n,s in ST if k==code]}")
# 2) 화장품: 기존 K-컬처 화장품 + 이미지 목록
IMG="""아모레퍼시픽홀딩스 리더스코스메틱 브이티 차AI헬스케어 코리아나 신세계인터내셔날 원익 에이블씨엔씨 아모레퍼시픽 네오팜 제닉 한국화장품 토니모리 강스템바이오텍 잇츠한불
세화피앤씨 오가닉티코스메틱 클리오 아우딘퓨쳐스 애경산업 라파스 HK이노엔 아이패밀리에스씨 마녀공장 에이피알 삐아 바이오비쥬 달바글로벌 뉴키즈온 아로마티카
삼양케이씨아이 승일 현대바이오랜드 대봉엘에스 한국콜마 펌텍코리아 엔에프씨 선진뷰티사이언스 지에프씨생명과학 에이에스텍 제이투케이바이오
한국화장품제조 모나미 콜마홀딩스 코스맥스 본느 잉글우드랩 코스메카코리아 씨앤씨인터내셔널 뷰티스킨 LG생활건강 실리콘투""".split()
o.append("\n## 화장품(국내) — 목록 중 DB에 있는 종목 (이전 업종)")
miss=[]; done=set()
for n in IMG:
    r=byname.get(nz(n))
    if not r: miss.append(n); continue
    for code,nm,sec in r:
        setsec(code,"화장품","화장품 분리(사용자 지정 목록)"); done.add(code); o.append(f"- {code} {nm} ({sec} → 화장품)")
o.append("\n## DB에 없음(미등록, 등록하지 않음)\n"+", ".join(miss))
# 3) 추가 후보: 이름 키워드로 DB에서 탐색
o.append("\n## 추가 발굴(이름에 화장품 관련 키워드, 목록 외)")
for code,nm,sec in ST:
    if code in done or code in ENT: continue
    if re.search(r"코스메|뷰티|화장품|콜마|아모레|생활건강|코스맥스|인터코스|스킨|메디컬뷰티",nm):
        setsec(code,"화장품","화장품 분리(이름 키워드 발굴)"); done.add(code); o.append(f"- {code} {nm} ({sec} → 화장품)")
# 4) 종합상사
o.append("\n## 종합상사 추가(국내)")
for n in ("GS글로벌","현대코퍼레이션","코오롱글로벌","LX인터내셔널","포스코인터내셔널"):
    r=byname.get(nz(n))
    if not r: o.append(f"- {n}: DB에 없음"); continue
    for code,nm,sec in r: setsec(code,"종합상사","종합상사 지정"); o.append(f"- {code} {nm} ({sec} → 종합상사)")
# 5) 해외
c.execute("update us_master set sector_std='엔터·미디어',sector_std_src='manual' where code='DIS'")
c.execute("select code,coalesce(name_ko,name_en),sector_std,profile->>'industry' from us_master where not is_etf and (profile->>'industry' like '개인 생활 필수%%' or coalesce(name_ko,'') ~ '에스티|로레알|코티|엘프|콜게이트|프록터|유니레버|시세이도|코세|고세|마니|화장품')")
rows=c.fetchall(); o.append("\n## 해외 화장품 후보")
for code,nm,sec,ind in rows:
    o.append(f"- {code} {nm} | 업종 {ind} | 현재 {sec}")
    c.execute("update us_master set sector_std='화장품',sector_std_src='manual' where code=%s",(code,))
cn.commit()
c.execute("select v.sector,count(*) from v_stock_sector v join stocks s on s.code=v.code where s.security_type='STOCK' group by 1 order by 2 desc"); o.append("\n## 국내 업종 분포\n"+", ".join(f"{a}({b})" for a,b in c.fetchall()))
c.execute("select coalesce(sector_std,'(미분류)'),count(*) from us_master where not is_etf group by 1 order by 2 desc"); o.append("## 해외 업종 분포\n"+", ".join(f"{a}({b})" for a,b in c.fetchall()))
open("sector_split.md","w").write("# 업종 분리·재분류 결과\n"+"\n".join(o))
