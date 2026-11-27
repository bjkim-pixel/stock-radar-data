# -*- coding: utf-8 -*-
"""해외 주식(ETF 제외)의 한글 회사 소개·업종·주주 구성을 네이버 증권(api.stock.naver.com/stock/{코드}/overview)에서 받아 us_master.profile 에 저장.
사용법: python 209_ovs_profile.py [종목코드,쉼표]   (비우면 전체)"""
import os, sys, re, time, json, requests, psycopg2
H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.autocommit = True; cur = c.cursor()
cur.execute("alter table us_master add column if not exists profile jsonb")
ONLY = [x for x in (sys.argv[1] if len(sys.argv) > 1 else "").replace(" ", "").split(",") if x]
cur.execute("select code,kis_excd from us_master where not is_etf order by code")
ST = [r for r in cur.fetchall() if not ONLY or r[0] in ONLY]
SUF = {"NAS": [".O", "", ".K", ".N"], "NYS": ["", ".K", ".N", ".O"], "AMS": ["", ".K", ".A", ".N"]}   # 네이버: 나스닥 .O, 뉴욕은 대부분 접미사 없음(일부 .K)
def cands(code, ex):
    if ex in SUF:
        b = [code]
        if "." in code: x = code.replace(".", ""); b += [x[:-1] + x[-1].lower(), code.replace(".", "-")]   # BRK.B → BRKb
        return [x + s for x in dict.fromkeys(b) for s in SUF[ex]]
    sfx = {"SHS": ".SS", "SZS": ".SZ", "TSE": ".T", "HKS": ".HK"}.get(ex)
    base = code.split(".")[0]
    return list(dict.fromkeys([code] + ([base + sfx] if sfx else [])))   # 표시코드가 .C1·.JP 같은 비표준이면 거래소 기준 접미사로
def get(path):
    for k in range(5):
        time.sleep(0.5)
        try:
            r = requests.get(f"https://api.stock.naver.com/stock/{path}/overview", headers=H, timeout=20)
            if r.status_code == 200: return r.json()
            if r.status_code in (400, 404, 409): return None
            time.sleep(3 * (k + 1))   # 429 등 일시 제한 → 늦춰 재시도
        except Exception: time.sleep(1.5)
    return None
# 네이버에 없는 종목은 직접 확인한 소개문(FnGuide)을 넣는다. 네이버에 생기면 아래 수집이 우선 덮어쓴다.
MANUAL = {"688836.SS": ("로봇", "Yushu Technology Co.는 중국에 본사를 둔 기업으로, 주로 로봇 및 관련 부품의 연구, 개발, 생산 및 판매를 영위하고 있습니다. 이 회사의 주요 제품으로는 휴머노이드 로봇, 사족 보행 로봇, 그리고 관절 모듈, 정교한 손, 협동 로봇 팔, 센서 등의 로봇 부품이 있습니다. 이 회사의 제품은 주로 검사 및 측량, 소방 구조, 공공 서비스 등의 분야에서 사용됩니다. 이 회사는 주로 국내외 시장에서 사업을 영위하고 있습니다."),
          "688820.SS": ("반도체 패키징·테스트", "SJ Semiconductor Corp는 주로 웨이퍼 레벨 패키징 및 집적 회로 테스트에 종사하는 회사입니다. 회사는 미드 세그먼트 실리콘 웨이퍼 처리, 웨이퍼 레벨 패키징, 멀티칩 통합 패키징 등의 서비스를 제공합니다. 회사의 서비스는 주로 고성능 컴퓨팅, 인공 지능, 데이터 센터, 자율 주행, 스마트폰 및 소비자 가전과 같은 최종 사용자 분야를 대상으로 합니다. 회사는 국내 및 해외 시장에서 사업을 운영하고 있습니다.")}
ok = 0; fail = []; nos = 0
for code, ex in ST:
    j = None
    for nc in cands(code, ex):
        j = get(nc)
        if j and (j.get("summary") or j.get("ownerInfoList")): break
    if not j and code in MANUAL:
        ind, txt = MANUAL[code]
        cur.execute("update us_master set profile=%s where code=%s", (json.dumps({"summary": txt, "industry": ind, "owners": [], "src": "manual", "src_label": "FnGuide", "fetched": time.strftime("%Y-%m-%d")}, ensure_ascii=False), code)); ok += 1; continue
    if not j: fail.append(code); continue
    summ = re.sub(r"<br\s*/?>", "\n", (j.get("summary") or "")).strip(); summ = re.sub(r"\n{3,}", "\n\n", summ)
    owners = [{"n": o.get("investorName"), "sh": o.get("position"), "p": o.get("outstanding")} for o in (j.get("ownerInfoList") or []) if o.get("investorName")]
    li = j.get("stockItemListedInfo") or {}
    prof = {"summary": summ, "industry": (j.get("industry") or {}).get("industryGroupKor"), "name_ko": j.get("companyName"), "owners": owners,
            "listed_at": (li.get("listedAt") or "")[:10], "acct_date": li.get("accountDate"), "src": "naver", "fetched": time.strftime("%Y-%m-%d")}
    cur.execute("update us_master set profile=%s where code=%s", (json.dumps(prof, ensure_ascii=False), code)); ok += 1
    if not summ: nos += 1
log(f"# 해외 주식 소개·주주 수집 · 대상 {len(ST)} · 저장 {ok} (소개문 없음 {nos}) · 실패 {len(fail)}")
log("실패: " + str(fail))
open("ovs_profile.md", "w", encoding="utf-8").write("\n".join(L))
