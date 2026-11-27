# -*- coding: utf-8 -*-
"""중국 ETF 2개(0053L0 TIGER 차이나휴머노이드로봇, 0043Y0 TIME 차이나AI테크액티브) 구성종목을 받을 수 있는 출처 점검(읽기 전용)."""
import os, re, json, time, importlib, requests
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
KEY, SEC = os.environ.get("KIS_APP_KEY", ""), os.environ.get("KIS_APP_SECRET", "")
tok = os.environ.get("KIS_ACCESS_TOKEN", "").strip() or importlib.import_module("72_kis_token").get_token_cached()
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
ETFS = {"0053L0": ("TIGER 차이나휴머노이드로봇", "KR70053L0005"), "0043Y0": ("TIME 차이나AI테크액티브", "KR70043Y0003")}
KW = re.compile(r"텐센트|Tencent|0700|BYD|比亚迪|샤오미|Xiaomi|Horizon|호라이즌|UBTECH|優必選|优必选|알리바바|Alibaba|SMIC|중신국제|Unitree|CATL|寧德|Hesai")
def snip(t, n=500):
    return re.sub(r"\s+", " ", t)[:n]
log("# 중국 ETF 구성종목 출처 점검")
for code, (nm, isin) in ETFS.items():
    log(f"\n## {code} {nm}")
    # 1) KIS 구성종목시세
    time.sleep(0.2)
    d = requests.get("https://openapi.koreainvestment.com:9443/uapi/etfetn/v1/quotations/inquire-component-stock-price", timeout=20,
        params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code, "FID_COND_SCR_DIV_CODE": "11216"},
        headers={"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": "FHKST121600C0", "custtype": "P"}).json()
    o2 = d.get("output2") or []
    log(f"- KIS 구성종목시세: rt_cd={d.get('rt_cd')} msg={d.get('msg1')} output1={json.dumps(d.get('output1'), ensure_ascii=False)[:200]} output2 {len(o2)}행 {json.dumps(o2[:3], ensure_ascii=False)[:300]}")
    # 2) 펀드이투 / 운용사 / 기타 페이지
    urls = [f"https://www.funetf.co.kr/product/etf/view/{isin}",
            f"https://investments.miraeasset.com/tigeretf/ko/product/search/detail/index.do?ksdFund={isin}",
            "https://www.timeetf.co.kr/m11_view.php?idx=19",
            f"https://etfshopping.com/etf/{code}", f"https://stockhub.kr/etf/{code}"]
    for u in urls:
        if ("timeetf" in u and code != "0043Y0") or ("miraeasset" in u and code != "0053L0"): continue
        try:
            r = requests.get(u, headers=UA, timeout=25)
            t = r.text
            hits = KW.findall(t)
            pdfs = re.findall(r"[\"'(]([^\"'()\s]*(?:pdf|PDF|portfolio|구성종목|component)[^\"'()\s]*)", t)[:8]
            log(f"- {u} → HTTP {r.status_code}, {len(t)}자, 키워드 {len(hits)}회 {sorted(set(hits))[:6]} 링크 {pdfs[:5]}")
        except Exception as e:
            log(f"- {u} → 실패 {str(e)[:120]}")
# 3) 접속 가능한 구성종목 API 후보
log("\n## 추가 후보")
cands = [("TIGER PDF(ajax)", "https://investments.miraeasset.com/tigeretf/ko/product/search/pdfList.ajax?ksdFund=KR70053L0005"),
         ("TIGER PDF 엑셀", "https://investments.miraeasset.com/tigeretf/ko/product/search/detail/pdfExcel.do?ksdFund=KR70053L0005"),
         ("KRX 정보데이터시스템", "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020104")]
for n, u in cands:
    try:
        r = requests.get(u, headers=UA, timeout=25)
        log(f"- {n}: HTTP {r.status_code} {len(r.content)}바이트 {snip(r.text, 300)}")
    except Exception as e: log(f"- {n}: 실패 {str(e)[:120]}")
open("etf_hold_probe.md", "w", encoding="utf-8").write("\n".join(L))
