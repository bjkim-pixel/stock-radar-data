"""신용융자 잔고·반대매매 데이터 출처 탐색(1회성 진단) — 금융투자협회 FreeSIS(freesis.kofia.or.kr)의 조회 주소를 시험한다.
결과는 credit_report.md 로 저장(워크플로가 credit-report 브랜치에 게시). DB는 건드리지 않는다."""
import json, sys, time, urllib.request, datetime as dt

URL = "https://freesis.kofia.or.kr/meta/getMetaDataList.do"
END = dt.date.today(); START = END - dt.timedelta(days=40)
lines = []
def log(m=""):
    print(m); lines.append(m)

def post(obj):
    body = {"dmSearch": {"tmpV40": "1000000", "tmpV41": "1", "tmpV1": "D",
                         "tmpV45": START.strftime("%Y%m%d"), "tmpV46": END.strftime("%Y%m%d"), "OBJ_NM": obj}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json",
        "Referer": "https://freesis.kofia.or.kr/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070",
        "Origin": "https://freesis.kofia.or.kr", "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

log(f"# 신용융자·반대매매 출처 탐색 ({dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC)\n조회기간 {START} ~ {END}\n")
try:
    d = post("STATSCU0100000070BO"); log("연결 확인(STATSCU0100000070BO): 성공 · 응답 키 " + ",".join(d.keys()))
except Exception as e:
    log(f"연결 실패: {type(e).__name__} {e}")
    open("credit_report.md", "w", encoding="utf-8").write("\n".join(lines)); sys.exit(0)

found = 0
for n in range(1, 160):
    obj = f"STATSCU0100000{n:03d}BO"
    try:
        d = post(obj)
    except Exception as e:
        continue
    rows = None
    for k, v in d.items():
        if isinstance(v, list) and v and isinstance(v[0], dict): rows = (k, v); break
    if not rows: continue
    found += 1
    k, v = rows
    log(f"\n## {obj} — 키 {k}, {len(v)}행")
    log("- 첫 행: " + json.dumps(v[0], ensure_ascii=False)[:500])
    log("- 끝 행: " + json.dumps(v[-1], ensure_ascii=False)[:500])
    meta = {kk: vv for kk, vv in d.items() if kk != k}
    if meta: log("- 기타: " + json.dumps(meta, ensure_ascii=False)[:600])
    time.sleep(0.3)
log(f"\n데이터가 있는 조회 {found}건")
open("credit_report.md", "w", encoding="utf-8").write("\n".join(lines))
