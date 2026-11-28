# -*- coding: utf-8 -*-
"""미국 13F 공시 수집 — SEC EDGAR → f13_fund / f13_filing / f13_holding (최근 4개 분기, 새 공시만).
환경: SUPABASE_DB_URL, SEC_UA(연락처 포함 User-Agent). 옵션: --force(이미 저장된 분기도 다시 받기)"""
import os, re, sys, json, time, statistics, datetime, requests, psycopg2
import xml.etree.ElementTree as ET
from psycopg2.extras import execute_values
HERE = os.path.dirname(os.path.abspath(__file__))
H = {"User-Agent": os.environ.get("SEC_UA") or "StockRadarResearch", "Accept-Encoding": "gzip, deflate"}
FORCE = "--force" in sys.argv
KEEP = 4                       # 보관 분기 수
L = []
def log(m=""): print(m, flush=True); L.append(str(m))

# (cik, 한글명, 대표 인물, 한 줄 소개, SEC 등록명에 들어가야 할 키워드)  — 키워드가 안 맞으면 등록하지 않고 보고
FUNDS = [
 (1067983, "버크셔 해서웨이", "워런 버핏(회장)·그레그 에이블(CEO)", "가치투자의 상징. 애플·아메리칸익스프레스·코카콜라 등을 오래 보유", "BERKSHIRE"),
 (1709323, "히말라야 캐피털", "리 루(Li Lu)", "찰리 멍거가 자산을 맡긴 가치투자자. 소수 종목 초집중", "HIMALAYA"),
 (1061768, "바우포스트 그룹", "세스 클라만", "『안전마진』 저자. 저평가·특수상황 가치투자", "BAUPOST"),
 (1336528, "퍼싱스퀘어", "빌 애크먼", "소수 종목 집중 + 경영 참여형(행동주의) 헤지펀드", "PERSHING"),
 (1040273, "서드포인트", "댄 로브", "행동주의 헤지펀드. 기업에 공개서한을 보내는 것으로 유명", "THIRD POINT"),
 (1536411, "듀케인 패밀리오피스", "스탠리 드러켄밀러", "소로스 퀀텀펀드 전 운용역. 매크로 판단 + 성장주", "DUQUESNE"),
 (1167483, "타이거 글로벌", "체이스 콜먼", "줄리언 로버트슨의 타이거 출신. 테크·성장주 중심", "TIGER GLOBAL"),
 (1135730, "코튜 매니지먼트", "필립 라퐁", "타이거 출신. 테크·AI 중심 헤지펀드", "COATUE"),
 (1029160, "소로스 펀드 매니지먼트", "조지 소로스(설립)·알렉스 소로스(회장)", "파운드화 공격으로 유명한 소로스의 가문 자산운용사", "SOROS"),
 (1350694, "브리지워터 어소시에이츠", "레이 달리오(설립)", "세계 최대급 헤지펀드. 글로벌 매크로. 13F는 ETF·대형주 위주", "BRIDGEWATER"),
 (1037389, "르네상스 테크놀로지스", "짐 사이먼스(설립, 2024 별세)", "수학자가 만든 퀀트 펀드. 알고리즘 매매로 수천 종목 보유", "RENAISSANCE"),
 (1608046, "국민연금공단(NPS)", "기금운용본부", "한국 국민연금. 미국 주식에도 대규모 분산 투자", "PENSION"),
 (1374170, "노르웨이 중앙은행(NBIM)", "니콜라이 탕겐(CEO)", "세계 최대 국부펀드(노르웨이 정부연기금). 전 세계 주식 분산. 6·12월 말 기준만 실제 공시", "NORGES"),
 (1549575, "달랄 스트리트(파브라이)", "모니시 파브라이", "버핏을 따르는 집중 가치투자자. 달랄 스트리트 LLC", "DALAL"),
 (949509, "오크트리 캐피털", "하워드 막스(공동회장)", "부실채권·대체투자 전문. 메모 『The Most Important Thing』 저자", "OAKTREE"),
 (921669, "칼 아이칸", "칼 아이칸", "기업사냥꾼 원조. 행동주의 투자의 대부", "ICAHN"),
 (1697748, "ARK 인베스트", "캐시 우드", "파괴적 혁신 ETF 운용사. 테슬라·코인베이스 등 혁신주 중심", "ARK"),
 (1103804, "바이킹 글로벌", "안드레아스 할보르센", "타이거 출신 롱숏 헤지펀드. 대형 성장주 중심", "VIKING"),
 (1791786, "엘리엇 매니지먼트", "폴 싱어", "대표적인 행동주의 헤지펀드. 대기업 지배구조 개선 요구", "ELLIOTT"),
 (1423053, "시타델 어드바이저스", "켄 그리핀", "멀티 전략 헤지펀드·마켓메이커. 회전율이 매우 높음", "CITADEL"),
 (1179392, "투시그마 인베스트먼츠", "존 오버덱·데이비드 시겔", "데이터·AI 기반 퀀트 운용사", "TWO SIGMA"),
 (1009207, "D.E. 쇼", "데이비드 쇼", "컴퓨터공학자가 만든 퀀트·멀티전략 운용사", "SHAW"),
 (1603466, "포인트72", "스티브 코언", "SAC 캐피털 후신. 멀티 매니저 헤지펀드", "POINT72"),
 (1562087, "틸 매크로", "피터 틸", "페이팔 공동 창업자·팔란티어 의장의 개인 투자회사. 5개 안팎 소수 종목에 집중", "THIEL MACRO"),
 (2045724, "시추에이셔널 어웨어니스", "레오폴드 아셴브레너", "전 오픈AI 연구원이 2024년 설립한 AI 인프라 집중 헤지펀드", "SITUATIONAL AWARENESS"),
 (1166559, "게이츠 재단 신탁", "빌 게이츠·멀린다 프렌치 게이츠", "게이츠 재단의 기부 기금 운용. 소수 대형주 위주 장기 보유", "GATES FOUNDATION"),
 (1647251, "TCI 펀드", "크리스 혼", "영국 런던 기반 집중투자·행동주의 펀드. 소수 대형 우량주 장기 보유", "TCI FUND"),
 (923093, "튜더 인베스트먼트", "폴 튜더 존스", "매크로·퀀트 헤지펀드 1세대. 다양한 전략을 쓰는 대형 헤지펀드", "TUDOR INVESTMENT"),
 (1082621, "하버드 기금(HMC)", "하버드 매니지먼트 컴퍼니", "하버드대 기금 운용사. 대학 기금 중 최대 규모", "HARVARD MANAGEMENT"),
 (1021944, "테마섹", "싱가포르 국부펀드(테마섹 홀딩스)", "싱가포르 정부 소유 투자회사. 미국 상장 보유분 일부만 13F로 공시", "TEMASEK"),
 (1273087, "밀레니엄 매니지먼트", "이즈리얼 잉글랜더", "수백 개 팀이 운용하는 멀티 매니저 헤지펀드", "MILLENNIUM"),
 (1061165, "론 파인 캐피털", "스티븐 만델", "타이거 출신 롱숏 펀드. 소비·테크 중심", "LONE PINE"),
 (1138995, "글렌뷰 캐피털", "래리 로빈스", "헬스케어 중심 헤지펀드", "GLENVIEW"),
 (915191, "페어팩스 파이낸셜", "프렘 와트사", "‘캐나다의 버핏’ 와트사가 이끄는 보험·투자 지주사", "FAIRFAX"),
 (783412, "데일리 저널", "찰리 멍거(전 회장, 2023 별세)", "멍거가 운용하던 상장사의 투자 포트폴리오. 소수 종목 집중", "DAILY JOURNAL"),
 (1510387, "고담 에셋 매니지먼트", "조엘 그린블라트", "『주식시장을 이기는 작은 책』 저자. 마법공식 투자", "GOTHAM"),
 (807985, "서던이스턴 에셋(롱리프)", "메이슨 호킨스", "롱리프 파트너스 운용. 저평가 우량주 장기 투자", "SOUTHEASTERN"),
 (1345471, "트라이언 펀드 매니지먼트", "넬슨 펠츠", "행동주의 투자자. 경영 개선을 요구하는 집중투자", "TRIAN"),
 (1541617, "알티미터 캐피털", "브래드 거스트너", "기술·성장주 집중 투자 펀드", "ALTIMETER"),
 (1747057, "D1 캐피털", "댄 서니", "타이거 출신의 성장주 중심 헤지펀드", "D1"),
 (1602189, "드래고니어 인베스트먼트", "마크 스태드", "성장주·비상장 투자. 테크 중심", "DRAGONEER"),
 (1387322, "웨일 록 캐피털", "알렉스 새서도트", "테크 중심 롱숏 헤지펀드", "WHALE ROCK"),
 (1517137, "스타보드 밸류", "제프 스미스", "행동주의 헤지펀드. 저평가 기업 경영 개선", "STARBOARD"),
 (1365341, "세비안 캐피털", "크리스티안 가델·라르스 푀르베리", "유럽 대표 행동주의 펀드", "CEVIAN"),
 (1418814, "밸류액트", "마이크 롤링스·마이슨 모핏", "경영 참여형 집중투자. 이사회 진출로 유명", "VALUEACT"),
 (1998597, "자나 파트너스", "배리 로젠스타인", "행동주의 헤지펀드. 기업 분할·매각 요구", "JANA"),
]
def get(url, tries=3):
    for i in range(tries):
        try:
            time.sleep(0.15)
            r = requests.get(url, headers=H, timeout=45)
            if r.status_code in (429, 503): time.sleep(2 + i * 3); continue
            return r
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 + i * 2)
def tag(el): return el.tag.split("}")[-1]
def child(el, name):
    for c in el:
        if tag(c) == name: return c
    return None
def ctext(el, name):
    c = child(el, name); return (c.text or "").strip() if c is not None and c.text else ""

def window_periods():
    """최근 KEEP개 분기말(오늘 기준 아직 공시 마감 전인 분기 포함)"""
    t = datetime.date.today(); qs = []
    y, m = t.year, t.month
    q = (m - 1) // 3          # 이번 분기 0~3 → 직전 분기말부터
    ends = []
    yy, qq = y, q
    for _ in range(KEEP + 1):
        qq -= 1
        if qq < 0: qq = 3; yy -= 1
        ends.append(datetime.date(yy, [3, 6, 9, 12][qq], [31, 30, 30, 31][qq]))
    return ends[:KEEP]

def find_infotable(cik, acc):
    a = acc.replace("-", "")
    r = get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{a}/index.json")
    if r is None or r.status_code != 200: return None
    items = [i for i in r.json().get("directory", {}).get("item", []) if i["name"].lower().endswith(".xml")]
    items = [i for i in items if "primary_doc" not in i["name"].lower()]
    items.sort(key=lambda i: (0 if "info" in i["name"].lower() or "table" in i["name"].lower() else 1, -int(i.get("size") or 0)))
    out = []
    for i in items:
        x = get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{a}/{i['name']}")
        if x is not None and x.status_code == 200 and b"nfoTable" in x.content: out.append(x.content)
    return out or None

def parse(xmls):
    agg = {}
    for xml in xmls: _parse1(xml, agg)
    return agg
def _parse1(xml, agg):
    root = ET.fromstring(xml)
    for it in root.iter():
        if tag(it) != "infoTable": continue
        cusip = ctext(it, "cusip").upper(); name = ctext(it, "nameOfIssuer")
        try: val = float(ctext(it, "value") or 0)
        except ValueError: val = 0.0
        sh = child(it, "shrsOrPrnAmt"); n = 0.0; ty = "SH"
        if sh is not None:
            try: n = float(ctext(sh, "sshPrnamt") or 0)
            except ValueError: n = 0.0
            ty = ctext(sh, "sshPrnamtType") or "SH"
        pc = ctext(it, "putCall").capitalize()
        if not cusip or ty == "PRN": continue          # 채권(PRN) 제외 — 주식·ETF·옵션만
        d = agg.setdefault((cusip, pc), {"name": name, "val": 0.0, "sh": 0.0})
        d["val"] += val; d["sh"] += n

def fix_unit(agg):
    """일부 제출자는 천 달러 단위로 제출 — 주당가격(value/shares) 중앙값이 1달러 미만이면 ×1000"""
    px = [d["val"] / d["sh"] for (c, pc), d in agg.items() if pc == "" and d["sh"] > 0 and d["val"] > 0]
    if px and statistics.median(px) < 1.0:
        for d in agg.values(): d["val"] *= 1000
        return True
    return False

def main():
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit = True; cur = conn.cursor()
    cur.execute(open(os.path.join(HERE, "231_f13.sql"), encoding="utf-8").read())
    cur.execute("delete from f13_holding h using f13_filing f where h.cik=f.cik and h.period=f.period and f.n_pos<=2 and f.total_value<5e6")   # 빈 공시 정리
    cur.execute("delete from f13_filing where n_pos<=2 and total_value<5e6")
    ids = [f[0] for f in FUNDS]   # 목록에서 뺀 펀드의 데이터 정리
    for t in ("f13_holding", "f13_filing", "f13_fund"): cur.execute(f"delete from {t} where cik <> all(%s)", (ids,))
    cur.execute("select cik, period, acc from f13_filing"); have = {(c, p): a for c, p, a in cur.fetchall()}
    win = window_periods(); log(f"# 13F 수집 {datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC · 대상 분기 {', '.join(map(str, win))} · 펀드 {len(FUNDS)}곳\n")
    new_filings = 0; skipped = []
    for no, (cik, ko, mgr, intro, key) in enumerate(FUNDS, 1):
        try:
            r = get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
            if r is None or r.status_code != 200: skipped.append(f"{ko}: 목록 HTTP {r.status_code if r is not None else '-'}"); continue
            j = r.json(); nm = j.get("name") or ""
            if key not in nm.upper(): skipped.append(f"{ko}: SEC 등록명 불일치({nm}) — 제외"); continue
            f = j["filings"]["recent"]; best = {}
            for i, form in enumerate(f["form"]):
                if form != "13F-HR": continue
                per = f["reportDate"][i]
                if per and datetime.date.fromisoformat(per) in win and per not in best:   # recent 는 최신순 — 분기별 첫 건(가장 늦은 원본)
                    best[per] = (f["filingDate"][i], f["accessionNumber"][i])
            if not best: skipped.append(f"{ko}: 최근 4개 분기 공시 없음(제외)"); continue
            got = []
            for per, (filed, acc) in sorted(best.items()):
                if not FORCE and have.get((cik, datetime.date.fromisoformat(per))) == acc: continue
                xml = find_infotable(cik, acc)
                if not xml: skipped.append(f"{ko} {per}: 보유종목 XML을 못 찾음"); continue
                agg = parse(xml); fixed = fix_unit(agg)
                eq = {k: d for k, d in agg.items() if k[1] == ""}
                total = sum(d["val"] for d in eq.values()) or 1
                if len(eq) <= 2 and total < 5e6:
                    skipped.append(f"{ko} {per}: 사실상 빈 공시({len(eq)}종목, ${total:,.0f}) — 건너뜀"); continue
                n_full = len(eq); items = list(agg.items())
                if n_full > 400:   # 분산·퀀트형: 종목 수천 개 → 평가액 상위 500개만 저장(DB 용량)
                    items = sorted([kv for kv in items if kv[0][1] == ""], key=lambda kv: -kv[1]["val"])[:500]
                cur.execute("delete from f13_holding where cik=%s and period=%s", (cik, per))
                rows = [(cik, per, c, pc, d["name"], d["val"], d["sh"], round(d["val"] / total * 100, 4) if pc == "" else None) for (c, pc), d in items]
                execute_values(cur, "insert into f13_holding(cik,period,cusip,put_call,name,value,shares,pct) values %s", rows, page_size=2000)
                cur.execute("""insert into f13_filing(cik,period,filed,acc,total_value,n_pos,unit_fixed) values (%s,%s,%s,%s,%s,%s,%s)
                  on conflict(cik,period) do update set filed=excluded.filed,acc=excluded.acc,total_value=excluded.total_value,n_pos=excluded.n_pos,unit_fixed=excluded.unit_fixed""",
                  (cik, per, filed, acc, total, n_full, fixed))
                got.append(f"{per}({n_full}종목, ${total/1e9:,.2f}B{', 단위보정' if fixed else ''})"); new_filings += 1
            cur.execute("select period, filed, n_pos from f13_filing where cik=%s order by period desc limit 1", (cik,))
            last = cur.fetchone()
            if not last: skipped.append(f"{ko}: 저장된 공시 없음"); continue
            style = "집중" if last[2] <= 60 else "중간" if last[2] <= 400 else "분산·퀀트"
            cur.execute("""insert into f13_fund(cik,name_ko,name_en,manager,intro,style,sort_no,last_period,last_filed,updated_at) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
              on conflict(cik) do update set name_ko=excluded.name_ko,name_en=excluded.name_en,manager=excluded.manager,intro=excluded.intro,style=excluded.style,
              sort_no=excluded.sort_no,last_period=excluded.last_period,last_filed=excluded.last_filed,updated_at=now()""",
              (cik, ko, nm, mgr, intro, style, no, last[0], last[1]))
            log(f"- {ko} [{nm}] {style} · " + (", ".join(got) if got else "새 공시 없음"))
        except Exception as e:
            skipped.append(f"{ko}: 실패 {type(e).__name__} {str(e)[:80]}")
    log(f"\n새로 저장한 공시 {new_filings}건")
    if skipped: log("\n## 제외·실패\n" + "\n".join("- " + s for s in skipped))
    cur.execute("select count(*) from f13_fund"); log(f"\nf13_fund {cur.fetchone()[0]}곳")
    cur.execute("select count(*) from f13_holding"); log(f"f13_holding {cur.fetchone()[0]}행")
    if FORCE:
        cur.execute("vacuum full f13_holding")
    cur.execute("select pg_size_pretty(pg_total_relation_size('f13_holding')), pg_size_pretty(pg_database_size(current_database()))"); a = cur.fetchone(); log(f"f13_holding 크기 {a[0]} · DB 전체 {a[1]}")
    open("f13_report.md", "w", encoding="utf-8").write("\n".join(L))
if __name__ == "__main__": main()
