"""신용융자 잔고·반대매매 데이터 출처 검증(1회성 진단) — 금융투자협회 FreeSIS 조회 결과의 열 의미를 뉴스 수치와 대조한다.
DB는 건드리지 않는다. 결과는 credit_report.md."""
import json, sys, time, urllib.request, datetime as dt
URL = "https://freesis.kofia.or.kr/meta/getMetaDataList.do"
lines = []
def log(m=""): print(m); lines.append(m)
def post(obj, s, e):
    body = {"dmSearch": {"tmpV40": "1000000", "tmpV41": "1", "tmpV1": "D", "tmpV45": s, "tmpV46": e, "OBJ_NM": obj}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json",
        "Referer": "https://freesis.kofia.or.kr/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070",
        "Origin": "https://freesis.kofia.or.kr", "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
log(f"# FreeSIS 열 의미 검증 ({dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC)\n")
# 1) 2026-07-27 ~ 2026-08-12 구간(뉴스: 8월초 빚투 급감·미수 반대매매) 일별 값
for obj in ["STATSCU0100000070BO", "STATSCU0100000060BO"]:
    d = post(obj, "20260727", "20260812")
    log(f"\n## {obj} 2026-07-27~08-12 ({len(d['ds1'])}행, 오래된 순으로)")
    for r in reversed(d["ds1"]):
        log("  " + " | ".join(str(r.get(f"TMPV{i}")) for i in range(1, 10) if f"TMPV{i}" in r))
# 2) 시작일 최대 범위 — 가장 오래된 일자
d = post("STATSCU0100000070BO", "20000101", dt.date.today().strftime("%Y%m%d"))
log(f"\n## 070 전체 기간 {len(d['ds1'])}행, 가장 오래된 {d['ds1'][-1]['TMPV1']} / 최신 {d['ds1'][0]['TMPV1']}")
d = post("STATSCU0100000060BO", "20000101", dt.date.today().strftime("%Y%m%d"))
log(f"## 060 전체 기간 {len(d['ds1'])}행, 가장 오래된 {d['ds1'][-1]['TMPV1']} / 최신 {d['ds1'][0]['TMPV1']}")
# 3) 코스피/코스닥 나눠진 신용 조회가 있는지: 다른 접두어 탐색
found = []
for pre in ["STATSCU0100000", "STATSCU0200000", "STATSCU0300000", "STATSCU0400000", "STATSCU0500000"]:
    for n in range(1, 40 if pre != "STATSCU0100000" else 0):
        obj = f"{pre}{n:03d}BO"
        try: d = post(obj, "20261012", "20261023")
        except Exception: continue
        if d.get("ds1"):
            found.append(obj); log(f"\n{obj}: " + json.dumps(d["ds1"][0], ensure_ascii=False)[:300])
        time.sleep(0.2)
for n in range(160, 400):
    obj = f"STATSCU0100000{n:03d}BO" if n < 1000 else None
    try: d = post(obj, "20261012", "20261023")
    except Exception: continue
    if d.get("ds1"):
        log(f"\n{obj}: " + json.dumps(d["ds1"][0], ensure_ascii=False)[:300])
    time.sleep(0.2)
open("credit_report.md", "w", encoding="utf-8").write("\n".join(lines))
