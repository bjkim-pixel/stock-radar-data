# -*- coding: utf-8 -*-
"""
STOCK RADAR · 글로벌 시황 수집 + 화면용 묶음 생성
=================================================
업종동향 페이지 맨 위 "글로벌 시황"(미국 / 한국 탭) 데이터를 만듭니다.

  1) 미국 ETF·환율 일별 종가      — Yahoo Finance 차트 API (20_collect_market_extra.py와 같은 경로)
  2) 한국 테마 ETF 일별 종가       — KIS 국내주식기간별시세 (FHKST03010100)
  3) 한국 ETF 상위 5개 보유종목    — KIS ETF 구성종목시세 (FHKST121600C0)
  4) KOSPI·KOSDAQ 상승/하락 종목수 — KIS 국내업종 일자별지수 output1 (FHPUP02120000)
     (과거 일자는 API가 주지 않아 오늘부터 쌓입니다 → ADR은 20일이 모이면 완성)
  5) global_pack(US/KR) — 차트용 종가 배열 + 요약표 지표를 탭별 JSON 1행으로 저장
     → 화면은 이 1행만 읽으므로 Supabase 읽기 부하가 거의 없습니다.

티커마다 DB에 쌓인 행 수를 보고, 부족하면 2025-09-01부터 자동 백필합니다
(별도 플래그 불필요). 평소에는 최근 1개월만 받아 upsert합니다.

필요 환경변수: KIS_APP_KEY · KIS_APP_SECRET · SUPABASE_DB_URL (· KIS_ACCESS_TOKEN)
사용법:
  python 21_collect_global.py            # 수집 + 묶음 생성
  python 21_collect_global.py --pack     # 수집 없이 묶음만 다시 생성
  python 21_collect_global.py --report global_report.md   # 결과 요약을 파일로도 저장
"""
import os, sys, time, json, math, datetime, re
import requests, psycopg2, psycopg2.extras

KIS_KEY    = os.environ.get("KIS_APP_KEY", "")
KIS_SECRET = os.environ.get("KIS_APP_SECRET", "")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")
BACKFILL_FROM = datetime.date(2025, 9, 1)
KST = datetime.timezone(datetime.timedelta(hours=9))

PACK_ONLY = "--pack" in sys.argv
REPORT_PATH = None
if "--report" in sys.argv:
    i = sys.argv.index("--report")
    REPORT_PATH = sys.argv[i + 1] if i + 1 < len(sys.argv) else "global_report.md"

REPORT = []
def log(msg=""):
    print(msg, flush=True)
    REPORT.append(msg)

# ═════════════════════════════════════════════════════════════════════════
# 구성 — 화면에 나오는 순서 그대로
# ═════════════════════════════════════════════════════════════════════════
US_SECTOR = [
    ("XLK", "기술"), ("XLF", "금융"), ("XLV", "헬스케어"), ("XLE", "에너지"),
    ("XLI", "산업재"), ("XLY", "경기소비재"), ("XLP", "필수소비재"), ("XLB", "소재"),
    ("XLU", "유틸리티"), ("XLC", "커뮤니케이션"), ("XLRE", "부동산"),
]
US_INDEX = [
    ("SPY", "S&P 500"), ("QQQ", "나스닥 100"), ("MAGS", "매그니피센트 7"),
    ("IWM", "러셀 2000"), ("IWC", "마이크로캡"), ("SOXX", "반도체"),
    ("RATIO:IWM/SPY", "IWM/SPY"), ("IBIT", "비트코인"), ("DRAM", "메모리"),
    ("UUP", "달러"), ("FXY", "엔화"), ("TBX", "미 국채 인버스(7-10년)"),
]
US_THEME = [
    ("AIS", "AI 슈퍼사이클"), ("SOXX", "반도체"), ("BOAT", "글로벌 해운"), ("HYDR", "수소"),
    ("BUG", "사이버보안"), ("VOLT", "전력화(Tema)"), ("ARKG", "유전체"), ("SKYY", "클라우드"),
    ("LIT", "리튬·배터리"), ("ZAP", "미국 전력화"), ("HUMN", "휴머노이드"), ("DRNZ", "드론"),
    ("SHLD", "방산 테크"), ("NUKZ", "원자력"), ("TAN", "태양광"), ("MAGS", "매그니피센트 7"),
    ("PHO", "수자원"), ("NCLD", "네오클라우드"), ("LYTE", "광학·포토닉스"), ("GASZ", "가스발전·터빈"),
    ("RACK", "데이터센터 공급망"), ("QTUP", "양자컴퓨팅"), ("DRAM", "메모리"), ("NASA", "우주 혁신"),
    ("IGV", "소프트웨어"), ("OZEM", "비만치료제"), ("BIZD", "BDC·사모대출"), ("STBQ", "스테이블코인"),
    ("KWEB", "중국 인터넷"), ("CAPA", "AI 커패시터·MLCC"),
]
# 미국 ETF 보유종목 한글 종목명 (없으면 영문명을 줄여 표시)
US_KO = {
    "277810.KS": "레인보우로보틱스", "285A.JP": "키옥시아", "3081.TT": "랜드마크 옵토일렉트로닉스", "4519.JP": "주가이제약",
    "6324.JP": "하모닉 드라이브 시스템즈", "688017.C1": "리더 하모닉 드라이브", "AAPL": "애플", "ABBV": "애브비",
    "AEP": "아메리칸 일렉트릭 파워", "ALB": "앨버말", "AMD": "AMD", "AME": "애메텍",
    "AMT": "아메리칸 타워", "AMZN": "아마존", "APD": "에어 프로덕츠", "APH": "암페놀",
    "ARCC": "아레스 캐피탈", "ASTS": "AST 스페이스모바일", "AVAV": "에어로바이런먼트", "AVEX": "에이벡스",
    "AVGO": "브로드컴", "BABAF": "알리바바", "BAC": "뱅크오브아메리카", "BAIDF": "바이두",
    "BE": "블룸에너지", "BELFB": "벨 퓨즈", "BRK.B": "버크셔 해서웨이", "BSOL": "비트와이즈 솔라나 ETF",
    "BXSL": "블랙스톤 시큐어드 렌딩", "CAT": "캐터필러", "CCJ": "카메코", "CCXI": "처칠 캐피탈 XI",
    "CEG": "컨스텔레이션 에너지", "CIEN": "시에나", "COHR": "코히런트", "COP": "코노코필립스",
    "COST": "코스트코", "CRSP": "크리스퍼 테라퓨틱스", "CRWD": "크라우드스트라이크", "CRWV": "코어위브",
    "CVX": "셰브론", "CWEN": "클리어웨이 에너지", "D": "도미니언 에너지", "DHT": "DHT 홀딩스",
    "DIS": "디즈니", "DUK": "듀크 에너지", "ECL": "에코랩", "ED": "콘솔리데이티드 에디슨",
    "ENPH": "엔페이즈 에너지", "ENS": "에너시스", "EQIX": "에퀴닉스", "ET": "에너지 트랜스퍼",
    "ETHA": "아이쉐어즈 이더리움 ETF", "ETN": "이튼", "FCEL": "퓨얼셀 에너지", "FCX": "프리포트 맥모란",
    "FERG": "퍼거슨", "FGXXX": "머니마켓펀드", "FN": "파브리넷", "FRO": "프런트라인",
    "FSLR": "퍼스트솔라", "FTC.L": "필트로닉", "FTNT": "포티넷", "GBDC": "골럽 캐피탈 BDC",
    "GD": "제너럴 다이내믹스", "GE": "GE 에어로스페이스", "GEV": "GE 버노바", "GLNK": "그레이스케일 체인링크 ETF",
    "GLXY": "갤럭시 디지털", "GOOG": "알파벳 C", "GOOGL": "알파벳 A", "HASI": "HA 서스테이너블 인프라",
    "HD": "홈디포", "HQ": "호라이즌 퀀텀", "HUT": "헛 8", "IBM": "IBM",
    "IDXX": "아이덱스 래버러토리스", "ILMN": "일루미나", "INFQ": "인플렉션", "INSW": "인터내셔널 시웨이즈",
    "INTC": "인텔", "IONQ": "아이온큐", "IREN": "아이렌", "ITM.L": "ITM 파워",
    "JNJ": "존슨앤드존슨", "JPM": "JP모건 체이스", "KLRA": "카일레라 테라퓨틱스", "KMI": "킨더 모건",
    "KO": "코카콜라", "LIN": "린데", "LITE": "루멘텀", "LLY": "일라이 릴리",
    "LMT": "록히드마틴", "LNG": "셰니에르 에너지", "MA": "마스터카드", "MAIN": "메인 스트리트 캐피탈",
    "MATX": "맷슨", "MCD": "맥도날드", "META": "메타 플랫폼스", "MPC": "마라톤 페트롤리엄",
    "MRK": "머크", "MRVL": "마벨 테크놀로지", "MSFT": "마이크로소프트", "MU": "마이크론",
    "NBIS": "네비우스", "NEE": "넥스트에라 에너지", "NEM": "뉴몬트", "NETTF": "넷이즈",
    "NOC": "노스럽 그러먼", "NTNX": "뉴타닉스", "NVDA": "엔비디아", "NVO": "노보 노디스크",
    "NXT": "넥스트파워", "OBDC": "블루 아울 캐피탈", "OKE": "원오크", "OKTA": "옥타",
    "ONDS": "온다스", "ORCL": "오라클", "P": "에버퓨어", "PANW": "팔로알토 네트웍스",
    "PDD": "핀둬둬", "PEG": "퍼블릭 서비스 엔터프라이즈", "PFE": "화이자", "PG": "P&G",
    "PLD": "프롤로지스", "PLTR": "팔란티어 테크놀로지스", "PLUG": "플러그 파워", "PM": "필립모리스",
    "PSA": "퍼블릭 스토리지", "PSQL": "파스칼", "RIO": "리오 틴토", "RKLB": "로켓랩",
    "ROP": "로퍼 테크놀로지스", "RTX": "RTX", "SHW": "셔윈-윌리엄스", "SMTC": "셈텍",
    "SNDK": "샌디스크", "SO": "서던 컴퍼니", "SOLS": "솔스티스 어드밴스드 머티리얼즈", "SPCX": "스페이스X",
    "STNG": "스콜피오 탱커스", "STX": "씨게이트", "TEM": "템퍼스 AI", "TJX": "TJX 컴퍼니스",
    "TLN": "탈렌 에너지", "TSLA": "테슬라", "TSM": "TSMC", "TTWO": "테이크투 인터랙티브",
    "TWST": "트위스트 바이오사이언스", "TXG": "10x 지노믹스", "UMAC": "언유주얼 머신스", "UNH": "유나이티드헬스",
    "UNP": "유니온 퍼시픽", "USDE": "스테이블코인X", "V": "비자", "VLO": "발레로 에너지",
    "VMC": "벌컨 머티리얼즈", "VSAT": "비아샛", "WAT": "워터스", "WDC": "웨스턴 디지털",
    "WELL": "웰타워", "WMT": "월마트", "XBOX": "라운드힐 박스 스프레드 ETF", "XOM": "엑슨모빌",
    "XRP": "비트와이즈 XRP ETF", "YMM": "풀트럭 얼라이언스", "ZS": "지스케일러",
}
US_EXCH = {"NMS": "나스닥", "NGM": "나스닥", "NCM": "나스닥", "NYQ": "NYSE", "PCX": "NYSE Arca", "ASE": "NYSE American",
           "BTS": "Cboe", "PNK": "OTC", "OQB": "OTC", "OQX": "OTC", "LSE": "런던", "IOB": "런던", "TOR": "토론토", "VAN": "토론토",
           "JPX": "도쿄", "TYO": "도쿄", "HKG": "홍콩", "KSC": "코스피", "KOE": "코스닥", "TAI": "대만", "TWO": "대만", "SHH": "상하이", "SHZ": "선전",
           "NAS": "나스닥", "TEX": "도쿄", "NasdaqGS": "나스닥", "NasdaqGM": "나스닥", "NasdaqCM": "나스닥"}
US_SUFFIX = {".KS": "코스피", ".KQ": "코스닥", ".JP": "도쿄", ".T": "도쿄", ".TT": "대만", ".TW": "대만", ".C1": "중국 A주", ".L": "런던", ".HK": "홍콩"}
def exch_label(code, ex):
    if ex and US_EXCH.get(ex, ex):
        return US_EXCH.get(ex, ex)
    for sfx, lb in US_SUFFIX.items():
        if code.upper().endswith(sfx):
            return lb
    return ""
def short_en(n):
    n = re.sub(r"\b(Inc|Corp|Corporation|Ltd|Limited|Holdings?|Company|Co|plc|PLC|N\.V|S\.A|Group)\b\.?,?", "", n or "")
    return re.sub(r"\s+", " ", n).strip(" ,.")

US_MACRO = [
    ("^TNX", "미 10년물 금리"), ("GLD", "금"), ("RATIO:CPER/GLD", "구리/금"),
    ("USO", "WTI 원유"), ("^VIX", "VIX 변동성"),
]
# 인덱스·매크로 차트 제목 오른쪽(아래)에 표시할 한 줄 설명
US_DESC = {
    "SPY": "미국 대형주 500 · 시장 전체 흐름", "QQQ": "나스닥100 · 대형 기술·성장주",
    "MAGS": "빅테크 7종목 · 주도주 온도", "IWM": "러셀2000 · 중소형주(경기·금리 민감)",
    "IWC": "마이크로캡 · 초소형주, 위험선호 지표", "SOXX": "반도체 ETF · AI 사이클 선행",
    "RATIO:IWM/SPY": "중소형÷대형 · 오르면 시장 확산·위험선호", "IBIT": "비트코인 현물 ETF · 유동성·위험선호",
    "DRAM": "메모리 반도체 ETF · DRAM·HBM 사이클", "UUP": "달러 인덱스 ETF · 오르면 신흥국·원화 약세 압력",
    "FXY": "엔화 ETF · 오르면 안전자산 선호·캐리 청산", "TBX": "미 국채 7-10년 인버스 · 오르면 금리 상승",
    "^TNX": "미 10년물 국채금리(%) · 오르면 성장주·밸류에이션 부담", "GLD": "금 현물 ETF · 안전자산·실질금리",
    "RATIO:CPER/GLD": "구리÷금 · 오르면 경기 기대, 내리면 안전선호", "USO": "WTI 원유 ETF · 인플레·에너지 업종",
    "^VIX": "변동성 지수 · 20↑ 불안, 30↑ 공포",
}
KR_DESC = {
    "KOSPI": "코스피 · 한국 대형주 시장 전체", "KOSPI_DD": "1년 고점 대비 낙폭(%) · 조정의 깊이",
    "KOSPI_DISP": "코스피÷20일선 · 100 위 과열, 아래 침체", "KOSDAQ": "코스닥 · 중소형·성장주 시장",
    "KQKS": "코스닥÷코스피 · 오르면 중소형 강세", "KRW": "원/달러 · 오르면 원화 약세(외국인 매도 압력)",
    "ADR_KOSPI": "상승÷하락종목수 20일 · 120↑ 과열, 75↓ 침체", "ADR_KOSDAQ": "상승÷하락종목수 20일 · 120↑ 과열, 75↓ 침체",
}
US_YAHOO_EXTRA = {"FX:KRW": "KRW=X", "US:CPER": "CPER"}   # CPER: 구리/금 비율 계산용(카드 없음)   # 한국 탭 원/달러

# 한국 테마 ETF 카드 — (표시명, 고정코드 또는 None). 코드가 None이면 stocks 테이블에서 이름으로 찾음.
# 한국 테마 — (테마명, [(ETF 이름, 고정코드 or None), ...]) · 같은 테마끼리 묶고 ETF 시총 큰 순으로 표시
KR_THEMES = [
    ("반도체", [("KODEX 반도체", "091160"), ("SOL 반도체전공정", None), ("SOL 반도체후공정", None),
               ("PLUS AI반도체소부장액티브", "0239Z0")]),
    ("AI전력·네트워크", [("KODEX AI전력핵심설비", None), ("RISE 네트워크인프라", None)]),
    ("우주항공·위성", [("PLUS 우주항공", None), ("SOL 우주항공밸류체인", None),
                    ("KoAct 광통신&위성네트워크액티브", None)]),
    ("K방산", [("PLUS K방산", None), ("PLUS K방산소부장", None)]),
    ("조선", [("SOL 조선TOP3플러스", None)]),
    ("원자력", [("HANARO 원자력iSelect", None)]),
    ("신재생에너지", [("TIME K신재생에너지액티브", None), ("PLUS 태양광&ESS", None)]),
    ("2차전지", [("KODEX 2차전지핵심소재10", None), ("KODEX 전고체배터리ESS TOP2플러스", None)]),
    ("로봇", [("KODEX 로봇액티브", None), ("TIGER 코리아휴머노이드로봇산업", None)]),
    ("바이오", [("TIGER 바이오TOP10", None), ("TIGER 기술이전바이오액티브", None)]),
    ("금융", [("TIGER 증권", None), ("TIGER 은행", None), ("TIGER 200 금융", None)]),
    ("건설", [("KODEX 건설", None)]),
    ("K-컬처·콘텐츠", [("ACE KPOP포커스", None), ("KODEX 웹툰&드라마", "395150"),
                    ("TIGER 미디어컨텐츠", None), ("TIGER 게임TOP10", None)]),
    ("K-소비", [("TIGER 화장품", None), ("HANARO Fn K-푸드", "438900"), ("TIGER 여행레저", None)]),
    ("코스닥150", [("KODEX 코스닥150", "229200")]),
]
KR_ETF = [e for _, lst in KR_THEMES for e in lst]

# ═════════════════════════════════════════════════════════════════════════
# 공통
# ═════════════════════════════════════════════════════════════════════════
def fnum(v):
    try:
        x = float(str(v).replace(",", ""))
        return x if math.isfinite(x) else None
    except Exception:
        return None

def norm(s):
    return re.sub(r"[\s&·\-_.]", "", (s or "")).upper()

def get_token():
    t = os.environ.get("KIS_ACCESS_TOKEN", "").strip()
    if t:
        return t
    import importlib
    return importlib.import_module("72_kis_token").get_token_cached()

def kis_get(token, path, tr_id, params, retries=2):
    for attempt in range(retries + 1):
        time.sleep(0.08)  # 초당 20건 한도 아래로
        try:
            r = requests.get(f"{KIS_BASE}{path}", params=params, timeout=15, headers={
                "Content-Type": "application/json; charset=utf-8",
                "authorization": f"Bearer {token}", "appkey": KIS_KEY,
                "appsecret": KIS_SECRET, "tr_id": tr_id, "custtype": "P"})
            if r.status_code == 200:
                d = r.json()
                if d.get("rt_cd") == "0":
                    return d
                msg = str(d.get("msg1", "")).strip()
                if "초당" in msg or "EGW00201" in str(d):
                    time.sleep(1.0); continue
                return {"_err": f"rt_cd={d.get('rt_cd')} {msg}"}
            if r.status_code >= 500 and attempt < retries:
                time.sleep(1.0); continue
            return {"_err": f"HTTP {r.status_code} {r.text[:120]}"}
        except Exception as ex:
            if attempt < retries:
                time.sleep(1.0); continue
            return {"_err": f"예외 {str(ex)[:120]}"}
    return {"_err": "재시도 초과"}

def db():
    return psycopg2.connect(DB_URL)

def ensure_schema(conn):
    sql = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "85_global_market.sql"),
               encoding="utf-8").read()
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()

def row_stats(conn):
    with conn.cursor() as cur:
        cur.execute("select symbol, count(*), min(trade_date), max(trade_date) from global_series_daily group by symbol")
        return {s: (n, a, b) for s, n, a, b in cur.fetchall()}

def upsert_series(conn, rows):
    if not rows:
        return 0
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, """
            insert into global_series_daily (symbol, trade_date, close) values %s
            on conflict (symbol, trade_date) do update set close = excluded.close
            where global_series_daily.close is distinct from excluded.close""",
            rows, page_size=1000)
    conn.commit()
    return len(rows)

def needs_backfill(stats, sym):
    n, first, _ = stats.get(sym, (0, None, None))
    return n < 150 or first is None or first > BACKFILL_FROM + datetime.timedelta(days=10)

# ═════════════════════════════════════════════════════════════════════════
# 1) Yahoo
# ═════════════════════════════════════════════════════════════════════════
YAHOO_META = {}
YAHOO_EXCH = {}
def fetch_yahoo(ysym, backfill):
    params = {"interval": "1d"}
    if backfill:
        params["period1"] = int(datetime.datetime(2025, 8, 20, tzinfo=datetime.timezone.utc).timestamp())
        params["period2"] = int(time.time()) + 86400
    else:
        params["range"] = "1mo"
    for host in ("query1", "query2"):
        try:
            r = requests.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(ysym)}",
                             params=params, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        except Exception as ex:
            err = f"예외 {str(ex)[:80]}"; continue
        if r.status_code != 200:
            err = f"HTTP {r.status_code}"; continue
        try:
            res = r.json()["chart"]["result"][0]
            meta = res.get("meta", {})
            YAHOO_META[ysym] = meta.get("longName") or meta.get("shortName") or ""
            YAHOO_EXCH[ysym] = meta.get("exchangeName") or meta.get("exchange") or ""
            off = int(meta.get("gmtoffset") or 0)
            ts = res.get("timestamp") or []
            closes = res["indicators"]["quote"][0]["close"]
        except Exception:
            return None, "응답 형식 이상(티커 없음?)"
        out = {}
        for t, c in zip(ts, closes):
            if c is None:
                continue
            d = datetime.datetime.fromtimestamp(t + off + 6 * 3600, datetime.timezone.utc).date()
            if d.weekday() < 5:
                out[d] = float(c)
        # 장중 실행 시 오늘 미확정 봉 제외 (미국은 KST 기준 다음날 아침 확정 → 마지막 봉이 오늘(현지)이고 장중이면 제외)
        reg = meta.get("currentTradingPeriod", {}).get("regular", {})
        if reg and out:
            now = time.time()
            if reg.get("start", 0) <= now < reg.get("end", 0):
                last = max(out)
                del out[last]
        return out, None
    return None, err

def collect_yahoo(conn, stats):
    with conn.cursor() as cur:  # 2026-10-25: FX 날짜가 하루 밀려 저장됐던 행 정리(주말 날짜가 있으면 전체 재수집)
        cur.execute("""select distinct symbol from global_series_daily
                       where symbol like 'FX:%%' and extract(isodow from trade_date) in (6,7)""")
        bad_fx = [r[0] for r in cur.fetchall()]
        for sym in bad_fx:
            cur.execute("delete from global_series_daily where symbol = %s", (sym,))
            stats.pop(sym, None)
    conn.commit()
    if bad_fx:
        log(f"- FX 날짜 정정: {', '.join(bad_fx)} 전체 재수집")
    syms = {}
    for lst in (US_SECTOR, US_INDEX, US_THEME, US_MACRO):
        for t, _ in lst:
            if not t.startswith("RATIO:"):
                syms["US:" + t] = t
    syms.update(US_YAHOO_EXTRA)
    ok, bad, total = 0, [], 0
    for sym, ysym in syms.items():
        bf = needs_backfill(stats, sym)
        data, err = fetch_yahoo(ysym, bf)
        if not data:
            bad.append(f"{ysym}({err or '데이터 없음'})")
            continue
        total += upsert_series(conn, [(sym, d, c) for d, c in sorted(data.items())])
        ok += 1
        time.sleep(0.15)
    log(f"- Yahoo: 성공 {ok}/{len(syms)} · upsert {total}행")
    if bad:
        log(f"  - ⚠ 실패: {', '.join(bad)}")

def holdings_stockanalysis(t, diag=False):
    """Yahoo가 막힐 때(429) 대체: stockanalysis.com ETF 보유종목 페이지(표/내장 JSON) 파싱."""
    try:
        r = requests.get(f"https://stockanalysis.com/etf/{t.lower()}/holdings/", timeout=20,
                         headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                                  "Accept-Language": "en-US,en;q=0.9"})
    except Exception as ex:
        if diag: log(f"  - [대체소스 진단] {t} 예외 {str(ex)[:80]}")
        return None
    html = r.content.decode("utf-8", "ignore") if r.status_code == 200 else ""
    import html as _h
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        pct = next((c for c in cells if re.fullmatch(r"\d+(\.\d+)?%", c)), None)
        if len(cells) >= 4 and pct:
            sym = cells[1] if re.fullmatch(r"\d+", cells[0]) else cells[0]
            nm = cells[2] if re.fullmatch(r"\d+", cells[0]) else cells[1]
            sym = sym.replace("$", "").strip()
            if re.fullmatch(r"[A-Za-z0-9.\-]{1,12}", sym):
                rows.append((sym, _h.unescape(nm), float(pct[:-1])))
    if not rows:  # 내장 JSON 형태
        for m in re.finditer(r'"s":"\$?([A-Za-z0-9.\-]{1,12})","n":"([^"]*)","as":"([\d.]+)%?"', html):
            rows.append((m.group(1), _h.unescape(m.group(2)), float(m.group(3))))
    if diag:
        log(f"  - [대체소스 진단] {t}: HTTP {r.status_code} · 길이 {len(html)} · 파싱 {len(rows)}행 · 앞 3행 {rows[:3]}")
        if not rows and html:
            i = html.find("<tbody")
            log(f"    스니펫: {re.sub(chr(10), ' ', html[i:i+300] if i >= 0 else html[:300])}")
    rows.sort(key=lambda x: -x[2])
    return rows[:5] or None

def collect_us_holdings(conn):
    """미국 섹터·테마 ETF 상위 5개 보유종목 + 전일 등락률 → etf_holdings(US:티커). Yahoo topHoldings(crumb 필요)."""
    etfs = []
    for lst in (US_SECTOR, US_THEME):
        for t, _ in lst:
            if t not in etfs:
                etfs.append(t)
    ses = requests.Session()
    ses.headers.update({"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"})
    crumb = None
    try:
        ses.get("https://fc.yahoo.com", timeout=15)
        r = ses.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=15)
        if r.status_code == 200 and r.text and "<" not in r.text and len(r.text) < 40:
            crumb = r.text.strip()
        else:
            log(f"- ⚠ Yahoo crumb 실패: HTTP {r.status_code}")
    except Exception as ex:
        log(f"- ⚠ Yahoo crumb 예외: {str(ex)[:80]}")
    found, bad = {}, []
    for t in etfs:
        got = None
        for host in (("query2", "query1") if crumb else ()):
            try:
                r = ses.get(f"https://{host}.finance.yahoo.com/v10/finance/quoteSummary/{t}",
                            params={"modules": "topHoldings", "crumb": crumb}, timeout=15)
                if r.status_code != 200:
                    got = f"HTTP {r.status_code}"; continue
                hs = r.json()["quoteSummary"]["result"][0]["topHoldings"]["holdings"]
                rows = []
                for h in hs:
                    sym = str(h.get("symbol") or "").strip()
                    w = (h.get("holdingPercent") or {}).get("raw")
                    if re.fullmatch(r"[A-Za-z0-9.\-]{1,12}", sym) and w:
                        rows.append((sym, (h.get("holdingName") or "").strip(), float(w) * 100))
                rows.sort(key=lambda x: -x[2])
                got = rows[:5]; break
            except Exception as ex:
                got = f"예외 {str(ex)[:50]}"
        if not (isinstance(got, list) and got):
            alt = holdings_stockanalysis(t, diag=(t == etfs[0]))
            if alt:
                got = alt
            time.sleep(0.4)
        if isinstance(got, list) and got:
            found[t] = got
        else:
            bad.append(f"{t}({got if isinstance(got, str) else '보유종목 없음'})")
        time.sleep(0.15)
    # 보유종목 전일 등락률 (마지막 확정 봉 2개)
    chg = {}
    for sym in sorted({h[0] for v in found.values() for h in v}):
        data, _ = fetch_yahoo(sym, False)
        if data and len(data) >= 2:
            ks = sorted(data)
            chg[sym] = round((data[ks[-1]] / data[ks[-2]] - 1) * 100, 2)
        time.sleep(0.12)
    today = datetime.datetime.now(KST).date()
    with conn.cursor() as cur:
        for t, rows in found.items():
            cur.execute("delete from etf_holdings where etf_symbol = %s", ("US:" + t,))
            for i, (sym, nm, w) in enumerate(rows, 1):
                cur.execute("""insert into etf_holdings (etf_symbol, rank, stock_code, stock_name, weight, change_pct, as_of, exch)
                               values (%s,%s,%s,%s,%s,%s,%s,%s)""", ("US:" + t, i, sym, nm, round(w, 4), chg.get(sym), today, YAHOO_EXCH.get(sym) or None))
    conn.commit()
    log(f"- 미국 ETF 보유종목: 성공 {len(found)}/{len(etfs)} · 종목 등락률 {len(chg)}개")
    if bad:
        log(f"  - ⚠ 실패/없음: {', '.join(bad)}")

# ═════════════════════════════════════════════════════════════════════════
# 2) KR ETF 코드 매핑 + 일별 종가 + 보유종목
# ═════════════════════════════════════════════════════════════════════════
def load_etf_names(conn):
    with conn.cursor() as cur:
        cur.execute("select code, name from stocks where security_type = 'ETF'")
        return cur.fetchall()

def resolve(name_or_kw, fixed, etfs):
    if fixed:
        return fixed, None
    if isinstance(name_or_kw, list):
        hits = [(c, n) for c, n in etfs if any(k in (n or "") for k in name_or_kw)]
        hits.sort(key=lambda x: (len(x[1] or ""), x[0]))
        return (hits[0][0], hits[0][1]) if hits else (None, None)
    key = norm(name_or_kw)
    for c, n in etfs:
        if norm(n) == key:
            return c, n
    # 브랜드(첫 단어) 빼고 일치하는 유일한 ETF (브랜드 변경 대비: ARIRANG→PLUS, KBSTAR→RISE 등)
    core = norm(" ".join(name_or_kw.split()[1:]))
    hits = [(c, n) for c, n in etfs if core and norm(n).endswith(core)]
    if len(hits) == 1:
        return hits[0]
    return None, None

def load_kis_master():
    """KIS 공개 종목 마스터(kospi_code.mst) — stocks 테이블에 없는 신규 상장 ETF 이름→코드 보완용."""
    import io, zipfile
    try:
        r = requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", timeout=30)
        z = zipfile.ZipFile(io.BytesIO(r.content))
        raw = z.read(z.namelist()[0])
    except Exception as ex:
        log(f"  - ⚠ KIS 종목 마스터 다운로드 실패: {str(ex)[:80]}")
        return []
    out = []
    for line in raw.split(b"\n"):
        line = line.rstrip(b"\r")
        if len(line) < 250:
            continue
        code = line[0:9].decode("cp949", "ignore").strip()
        name = line[21:len(line) - 228].decode("cp949", "ignore").strip()
        if code and name:
            out.append((code[-6:] if len(code) > 6 else code, name))
    return out

def build_kr_map(conn):
    etfs = load_etf_names(conn)
    log(f"- stocks 테이블 ETF {len(etfs)}개에서 이름 매핑")
    need = [nm for nm, fx in KR_ETF if not fx and not resolve(nm, None, etfs)[0]]
    if need:
        mst = load_kis_master()
        known = {c for c, _ in etfs}
        add = [(c, n) for c, n in mst if c not in known]
        log(f"  - stocks에 없는 {len(need)}개 → KIS 종목 마스터 {len(mst)}개로 보완")
        etfs = etfs + add
    etf_codes, miss, theme_of = [], [], {}
    for th, lst in KR_THEMES:
        for nm, fixed in lst:
            c, matched = resolve(nm, fixed, etfs)
            if c:
                etf_codes.append((nm, c)); theme_of[c] = th
            else:
                miss.append(nm)
    if miss:
        log(f"  - ⚠ 코드 못 찾음: {', '.join(miss)}")
    return etf_codes, theme_of

def fetch_kr_daily(token, code, d1, d2):
    out, end, errs = {}, d2, None
    while end >= d1:
        start = max(d1, end - datetime.timedelta(days=130))
        d = kis_get(token, "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
            "FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": start.strftime("%Y%m%d"), "FID_INPUT_DATE_2": end.strftime("%Y%m%d"),
            "FID_PERIOD_DIV_CODE": "D", "FID_ORG_ADJ_PRC": "0"})
        if "_err" in d:
            errs = d["_err"]; break
        rows = [x for x in (d.get("output2") or []) if x and x.get("stck_bsop_date")]
        for x in rows:
            c = fnum(x.get("stck_clpr"))
            if c:
                out[datetime.datetime.strptime(x["stck_bsop_date"], "%Y%m%d").date()] = c
        if not rows:
            break
        oldest = min(datetime.datetime.strptime(x["stck_bsop_date"], "%Y%m%d").date() for x in rows)
        end = min(start, oldest) - datetime.timedelta(days=1)
    return out, errs

def kr_session_closed(now_kst):
    return now_kst.weekday() >= 5 or now_kst.time() >= datetime.time(15, 40) or now_kst.time() < datetime.time(9, 0)

def collect_kr(conn, stats, token, etf_codes):
    today = datetime.datetime.now(KST)
    codes = sorted({c for _, c in etf_codes})
    ok, bad, total = 0, [], 0
    for c in codes:
        sym = "KR:" + c
        bf = needs_backfill(stats, sym)
        d1 = BACKFILL_FROM - datetime.timedelta(days=10) if bf else today.date() - datetime.timedelta(days=20)
        data, err = fetch_kr_daily(token, c, d1, today.date())
        if not kr_session_closed(today):
            data.pop(today.date(), None)  # 장중 미확정 종가 제외
        if not data:
            bad.append(f"{c}({err or '데이터 없음'})"); continue
        total += upsert_series(conn, [(sym, d, v) for d, v in sorted(data.items())])
        ok += 1
    log(f"- 한국 ETF 시세: 성공 {ok}/{len(codes)} · upsert {total}행")
    if bad:
        log(f"  - ⚠ 실패: {', '.join(bad)}")

    # ETF 시가총액(억원) — 현재가 API의 hts_avls. KRM:코드 로 하루 1행 저장(최신값만 화면에 사용)
    cap_ok, cap_bad = 0, []
    for c in codes:
        d = kis_get(token, "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
                    {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": c})
        o = d.get("output") or {}
        cap = fnum(o.get("hts_avls"))
        if not cap:
            sh, px = fnum(o.get("lstn_stcn")), fnum(o.get("stck_prpr"))
            cap = sh * px / 1e8 if sh and px else None
        if cap and cap > 0:
            upsert_series(conn, [("KRM:" + c, today.date(), round(cap, 1))]); cap_ok += 1
        else:
            cap_bad.append(f"{c}({d.get('_err', '값 없음')[:40]})")
    log(f"- 한국 ETF 시가총액: 성공 {cap_ok}/{len(codes)}")
    if cap_bad:
        log(f"  - ⚠ 실패: {', '.join(cap_bad)}")

    # 보유종목 (ETF 카드용)
    hold_ok, hold_bad = 0, []
    with conn.cursor() as cur:
        for nm, c in etf_codes:
            d = kis_get(token, "/uapi/etfetn/v1/quotations/inquire-component-stock-price", "FHKST121600C0", {
                "FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": c, "FID_COND_SCR_DIV_CODE": "11216"})
            if "_err" in d:
                hold_bad.append(f"{c}({d['_err'][:40]})"); continue
            rows = []
            for x in (d.get("output2") or []):
                sc = str(x.get("stck_shrn_iscd") or "").strip()
                w = fnum(x.get("etf_cnfg_issu_rlim"))
                if len(sc) == 6 and w is not None and w > 0:
                    rows.append((sc, (x.get("hts_kor_isnm") or "").strip(), w, fnum(x.get("prdy_ctrt"))))
            rows.sort(key=lambda r: -r[2])
            if not rows:
                hold_bad.append(f"{c}(구성종목 없음)"); continue
            cur.execute("delete from etf_holdings where etf_symbol = %s", ("KR:" + c,))
            for i, (sc, sn, w, chg) in enumerate(rows[:5], 1):
                cur.execute("""insert into etf_holdings (etf_symbol, rank, stock_code, stock_name, weight, change_pct, as_of)
                               values (%s,%s,%s,%s,%s,%s,%s)""", ("KR:" + c, i, sc, sn, w, chg, today.date()))
            hold_ok += 1
    conn.commit()
    log(f"- 한국 ETF 보유종목: 성공 {hold_ok}/{len(etf_codes)}")
    if hold_bad:
        log(f"  - ⚠ 실패: {', '.join(hold_bad)}")

    # 상승/하락 종목수
    for mk, iscd in (("KOSPI", "0001"), ("KOSDAQ", "1001")):
        d = kis_get(token, "/uapi/domestic-stock/v1/quotations/inquire-index-daily-price", "FHPUP02120000", {
            "FID_PERIOD_DIV_CODE": "D", "FID_COND_MRKT_DIV_CODE": "U", "FID_INPUT_ISCD": iscd,
            "FID_INPUT_DATE_1": today.strftime("%Y%m%d")})
        if "_err" in d:
            log(f"  - ⚠ {mk} 등락종목수 실패: {d['_err']}"); continue
        o1 = d.get("output1") or {}
        o2 = [x for x in (d.get("output2") or []) if x.get("stck_bsop_date")]
        if not o2:
            continue
        dd = datetime.datetime.strptime(o2[0]["stck_bsop_date"], "%Y%m%d").date()
        if dd == today.date() and not kr_session_closed(today):
            log(f"  - {mk} 등락종목수: 장중이라 저장 생략"); continue
        adv, dec = fnum(o1.get("ascn_issu_cnt")), fnum(o1.get("down_issu_cnt"))
        if adv is None or dec is None:
            continue
        upsert_series(conn, [(f"KRB:{mk}_ADV", dd, adv), (f"KRB:{mk}_DEC", dd, dec)])
        log(f"- {mk} {dd} 상승 {int(adv)} / 하락 {int(dec)}")

# ═════════════════════════════════════════════════════════════════════════
# 3) 묶음(pack) 생성
# ═════════════════════════════════════════════════════════════════════════
CHART_N = 260

def pct(a, b):
    return None if a is None or b in (None, 0) else round((a / b - 1) * 100, 2)

def metrics(dates, c, bench):
    """c, bench: 같은 dates에 정렬된 종가(None 가능, 앞쪽만 None)."""
    v = [(d, x) for d, x in zip(dates, c) if x is not None]
    if len(v) < 2:
        return None
    vd = [d for d, _ in v]; vc = [x for _, x in v]
    last = vc[-1]
    back = lambda n: vc[-1 - n] if len(vc) > n else None
    prev_year = [x for d, x in v if d.year < vd[-1].year]
    m = {"d": pct(last, back(1)), "w": pct(last, back(5)), "m": pct(last, back(21)),
         "m3": pct(last, back(63)), "ytd": pct(last, prev_year[-1]) if prev_year else None,
         "hi": pct(last, max(vc[-252:]))}
    if len(vc) >= 60:
        ma50 = sum(vc[-50:]) / 50
        ma50p = sum(vc[-60:-10]) / 50
        m["tr"] = 2 if last > ma50 and ma50 > ma50p else (1 if last > ma50 else 0)
    if bench:
        bv = [x for x in bench if x is not None]
        if len(bv) > 63:
            bm, bm3 = pct(bv[-1], bv[-22]), pct(bv[-1], bv[-64])
            if m["m"] is not None and bm is not None:
                m["rs1"] = round(m["m"] - bm, 2)
            if m["m3"] is not None and bm3 is not None:
                m["rs3"] = round(m["m3"] - bm3, 2)
            if "rs1" in m and "rs3" in m:
                m["ph"] = ("lead" if m["rs1"] >= 0 else "weak") if m["rs3"] >= 0 else ("impr" if m["rs1"] >= 0 else "lag")
    return m

def align(cal, series):
    """cal(날짜 리스트)에 맞춰 forward-fill. series: {date: close}"""
    out, last = [], None
    keys = sorted(series)
    j = 0
    for d in cal:
        while j < len(keys) and keys[j] <= d:
            last = series[keys[j]]; j += 1
        out.append(last)
    return out

def rnd(x):
    if x is None:
        return None
    a = abs(x)
    return round(x, 0 if a >= 10000 else 2 if a >= 10 else 4)

def load_all(conn):
    with conn.cursor() as cur:
        cur.execute("select symbol, trade_date, close from global_series_daily where trade_date >= %s order by trade_date",
                    (BACKFILL_FROM - datetime.timedelta(days=15),))
        S = {}
        for s, d, c in cur.fetchall():
            S.setdefault(s, {})[d] = float(c)
        cur.execute("""select market, trade_date, index_close from market_daily
                       where trade_date >= %s and index_close is not null and extract(isodow from trade_date) between 1 and 5
                       order by trade_date""", (BACKFILL_FROM - datetime.timedelta(days=15),))
        for mk, d, c in cur.fetchall():
            S.setdefault("IDX:" + mk, {})[d] = float(c)
        cur.execute("select etf_symbol, rank, stock_code, stock_name, weight, change_pct, exch from etf_holdings order by etf_symbol, rank")
        H = {}
        for e, r, sc, sn, w, ch, ex in cur.fetchall():
            H.setdefault(e, []).append({"c": sc, "n": sn, "w": float(w) if w is not None else None,
                                        "ch": float(ch) if ch is not None else None, "x": ex})
    return S, H

def item(cal, series, name, bench_al, kind="px", sym=None):
    al = align(cal, series) if series else [None] * len(cal)
    if not any(x is not None for x in al):
        return None
    it = {"n": name, "c": [rnd(x) for x in al[-CHART_N:]], "m": metrics(cal, al, bench_al), "k": kind}
    if sym:
        it["s"] = sym
    return it

def build_us(S, H):
    spy = S.get("US:SPY") or {}
    cal = sorted(spy)
    if len(cal) < 30:
        return None
    bench = align(cal, spy)
    items, groups = {}, []
    def add(grp_id, title, lst, period):
        keys = []
        for t, nm in lst:
            if t.startswith("RATIO:"):
                a, b = t[6:].split("/")
                sa, sb = S.get("US:" + a) or {}, S.get("US:" + b) or {}
                ser = {d: sa[d] / sb[d] for d in sa if d in sb and sb[d]}
                it = item(cal, ser, nm, None, "ratio", t[6:])
            else:
                it = item(cal, S.get("US:" + t) or {}, nm, None if t == "SPY" else bench,
                          "yld" if t == "^TNX" else "lvl" if t == "^VIX" else "px", t)
            if it:
                if t in US_DESC and grp_id in ("index", "macro"):
                    it["d_"] = US_DESC[t]
                if grp_id in ("sector", "theme") and not t.startswith("RATIO:"):
                    it["h"] = [{"c": x["c"], "n": x["c"], "f": x["n"], "k": US_KO.get(x["c"]) or short_en(x["n"]),
                                "x": exch_label(x["c"], x.get("x")), "w": x["w"], "ch": x["ch"]}
                               for x in H.get("US:" + t, [])]
                items[f"{grp_id}:{t}"] = it
                keys.append(f"{grp_id}:{t}")
        groups.append({"id": grp_id, "title": title, "period": period, "keys": keys})
    add("sector", "섹터", US_SECTOR, 126)
    add("index", "인덱스", US_INDEX, 252)
    add("macro", "금리·원자재·심리", US_MACRO, 252)
    add("theme", "테마", US_THEME, 126)
    return {"tab": "US", "as_of": cal[-1].isoformat(), "bench": "SPY",
            "dates": [d.isoformat() for d in cal[-CHART_N:]],
            "summary": ["sector", "theme"], "groups": groups, "items": items}

def build_kr(S, H, etf_codes, theme_of):
    ks = S.get("IDX:KOSPI") or {}
    cal = sorted(ks)
    if len(cal) < 30:
        return None
    bench = align(cal, ks)
    kq = S.get("IDX:KOSDAQ") or {}
    items, groups = {}, []
    # 인덱스
    idx = []
    def put(key, it):
        if it:
            if key.split(":", 1)[1] in KR_DESC:
                it["d_"] = KR_DESC[key.split(":", 1)[1]]
            items[key] = it; idx.append(key)
    put("index:KOSPI", item(cal, ks, "KOSPI", None))
    # 고점대비 (252일 최고 대비 %)
    ksl = align(cal, ks)
    dd, ds = {}, {}
    for i, d in enumerate(cal):
        w = [x for x in ksl[max(0, i - 251):i + 1] if x]
        if w and ksl[i]:
            dd[d] = (ksl[i] / max(w) - 1) * 100
        w20 = [x for x in ksl[max(0, i - 19):i + 1] if x]
        if len(w20) == 20 and ksl[i]:
            ds[d] = ksl[i] / (sum(w20) / 20) * 100
    put("index:KOSPI_DD", item(cal, dd, "KOSPI 고점대비", None, "lvlpct"))
    put("index:KOSPI_DISP", item(cal, ds, "KOSPI 이격도(20일)", None, "lvl"))
    put("index:KOSDAQ", item(cal, kq, "KOSDAQ", None))
    put("index:KQKS", item(cal, {d: kq[d] / ks[d] for d in kq if d in ks and ks[d]}, "KOSDAQ / KOSPI", None, "ratio"))
    put("index:KRW", item(cal, S.get("FX:KRW") or {}, "원/달러", None))
    for mk in ("KOSPI", "KOSDAQ"):
        adv, dec = S.get(f"KRB:{mk}_ADV") or {}, S.get(f"KRB:{mk}_DEC") or {}
        days = sorted(d for d in adv if d in dec)
        ser = {}
        for i, d in enumerate(days):
            w = days[max(0, i - 19):i + 1]
            sd = sum(dec[x] for x in w)
            if sd:
                ser[d] = sum(adv[x] for x in w) / sd * 100
        it = item(cal, ser, f"{mk} ADR(20일)", None, "lvl")
        if it:
            it["days"] = len(days)
        put(f"index:ADR_{mk}", it)
    groups.append({"id": "index", "title": "인덱스", "period": "ytd", "keys": idx})
    # 테마 — 같은 테마끼리 묶고, 테마 안은 ETF 시총 큰 순, 테마는 시총 합계 큰 순
    def last_cap(c):
        sr = S.get("KRM:" + c) or {}
        return float(sr[max(sr)]) if sr else None
    by_th = {}
    for nm, c in etf_codes:
        it = item(cal, S.get("KR:" + c) or {}, nm, bench, "px", c)
        if not it:
            continue
        th = theme_of.get(c, "기타")
        cap = last_cap(c)
        it["th"] = th
        it["cap"] = round(cap) if cap else None
        it["h"] = H.get("KR:" + c, [])
        items["etf:" + c] = it
        by_th.setdefault(th, []).append((cap or 0, "etf:" + c))
    secs = []
    for th, lst in by_th.items():
        lst.sort(key=lambda x: -x[0])
        secs.append({"n": th, "cap": round(sum(x[0] for x in lst)), "keys": [k for _, k in lst]})
    secs.sort(key=lambda x: -x["cap"])
    groups.append({"id": "theme", "title": "테마", "period": 63,
                   "keys": [k for sc in secs for k in sc["keys"]], "sections": secs})
    return {"tab": "KR", "as_of": cal[-1].isoformat(), "bench": "KOSPI",
            "dates": [d.isoformat() for d in cal[-CHART_N:]],
            "summary": ["theme"], "groups": groups, "items": items}

def save_pack(conn, pack):
    js = json.dumps(pack, ensure_ascii=False, separators=(",", ":"), default=str)
    with conn.cursor() as cur:
        cur.execute("""insert into global_pack (tab, as_of, payload, updated_at) values (%s,%s,%s::jsonb, now())
                       on conflict (tab) do update set as_of=excluded.as_of, payload=excluded.payload, updated_at=now()""",
                    (pack["tab"], pack["as_of"], js))
    conn.commit()
    n_ok = sum(len(g["keys"]) for g in pack["groups"])
    log(f"- pack {pack['tab']}: 기준일 {pack['as_of']} · 항목 {n_ok}개 · {len(js)/1024:.0f}KB")
    if REPORT_PATH:  # 검증용 사본 (리포트 브랜치에 같이 게시)
        open(f"pack_{pack['tab']}.json", "w", encoding="utf-8").write(js)

# ═════════════════════════════════════════════════════════════════════════
def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    t0 = time.time()
    log(f"# 글로벌 시황 수집 리포트 ({datetime.datetime.now(KST):%Y-%m-%d %H:%M} KST)")
    conn = db()
    ensure_schema(conn)
    etf_codes, theme_of = build_kr_map(conn)
    if not PACK_ONLY:
        stats = row_stats(conn)
        collect_yahoo(conn, stats)
        try:
            collect_us_holdings(conn)
        except Exception as ex:
            log(f"- ⚠ 미국 ETF 보유종목 수집 예외: {str(ex)[:100]}")
        if KIS_KEY:
            collect_kr(conn, stats, get_token(), etf_codes)
        else:
            log("- ⚠ KIS 키 없음 — 한국 ETF 수집 생략")
    S, H = load_all(conn)
    us = build_us(S, H)
    if us: save_pack(conn, us)
    kr = build_kr(S, H, etf_codes, theme_of)
    if kr: save_pack(conn, kr)
    # 검증용: 티커별 행 수·기간, Yahoo 이름
    st = row_stats(conn)
    log("\n## 티커별 저장 현황")
    log("| symbol | rows | first | last | yahoo name |")
    log("|---|---|---|---|---|")
    for s in sorted(st):
        n, a, b = st[s]
        nm = YAHOO_META.get(s.split(":", 1)[1], "") if s.startswith("US:") else ""
        log(f"| {s} | {n} | {a} | {b} | {nm} |")
    log("\n## 한국 매핑 (테마 · ETF → 코드 · 시총 억원)")
    for nm, c in etf_codes:
        sr = S.get("KRM:" + c) or {}
        log(f"- [{theme_of.get(c)}] {nm} → {c} · 시총 {sr[max(sr)] if sr else '–'}")
    conn.close()
    log(f"\n완료 ({time.time()-t0:.0f}초)")
    if REPORT_PATH:
        open(REPORT_PATH, "w", encoding="utf-8").write("\n".join(REPORT) + "\n")

if __name__ == "__main__":
    main()
