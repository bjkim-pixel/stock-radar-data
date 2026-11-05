# -*- coding: utf-8 -*-
"""시장별 투자자 매매동향(코스피·코스닥·선물) 소스 탐색 — KIS 시장별 투자자 API + 네이버 금융. 읽기 전용, 리포트만 출력."""
import os, re, json, subprocess, datetime, requests
KB = "https://openapi.koreainvestment.com:9443"
KEY, SEC = os.environ.get("KIS_APP_KEY", ""), os.environ.get("KIS_APP_SECRET", "")
out = []
def log(m=""):
    print(m, flush=True); out.append(str(m))
def token():
    t = subprocess.run(["python", "72_kis_token.py"], capture_output=True, text=True).stdout.strip().splitlines()
    return t[-1] if t else ""
def hdr(tok, tr):
    return {"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "tr_id": tr, "custtype": "P"}
today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y%m%d")
tok = token()
log(f"# 투자자 매매동향 소스 탐색 {today}\n토큰 {'OK' if tok else '없음'}")
def kis(path, tr, params, label):
    try:
        r = requests.get(KB + "/uapi/domestic-stock/v1/quotations/" + path, headers=hdr(tok, tr), params=params, timeout=20)
        log(f"\n## KIS {label}  HTTP {r.status_code}\n```\n{r.text[:1800]}\n```")
    except Exception as ex:
        log(f"\n## KIS {label} 오류 {ex}")
if tok:
    for iscd, nm in (("0001", "코스피"), ("1001", "코스닥")):
        kis("inquire-investor-daily-by-market", "FHPTJ04040000",
            {"FID_COND_MRKT_DIV_CODE": "U", "FID_INPUT_ISCD": iscd, "FID_INPUT_DATE_1": today, "FID_INPUT_ISCD_1": "KSP" if iscd == "0001" else "KSQ", "FID_INPUT_DATE_2": today, "FID_INPUT_ISCD_2": iscd}, f"일별 {nm}")
    kis("inquire-investor-time-by-market", "FHPTJ04030000", {"FID_INPUT_ISCD": "KSP", "FID_INPUT_ISCD_2": "0001"}, "시간대별 코스피")
H = {"User-Agent": "Mozilla/5.0"}
for u in ("https://finance.naver.com/sise/sise_trans_style.naver", "https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=" + today + "&sosok=01",
          "https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=" + today + "&sosok=02"):
    try:
        r = requests.get(u, headers=H, timeout=20); r.encoding = "euc-kr"
        t = re.sub(r"<script.*?</script>|<style.*?</style>", "", r.text, flags=re.S)
        t = re.sub(r"<[^>]+>", " ", t); t = re.sub(r"\s+", " ", t)
        log(f"\n## NAVER {u}  HTTP {r.status_code} 길이 {len(r.text)}\n{t[:1500]}")
        iframes = re.findall(r'<iframe[^>]+src="([^"]+)"', r.text)
        if iframes: log(f"iframes: {iframes[:6]}")
    except Exception as ex:
        log(f"\n## NAVER {u} 오류 {ex}")
open("investor_report.md", "w", encoding="utf-8").write("\n".join(out))
