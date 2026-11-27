# -*- coding: utf-8 -*-
"""KIS 해외 종목 마스터 파일 규모 점검(읽기 전용)."""
import io, zipfile, requests
L = []
def log(m=""): print(m, flush=True); L.append(str(m))
log("# KIS 해외종목 마스터(거래소별 종목 수)")
log("| 거래소 | 파일 | HTTP | 행 수 | 보통주 추정(구분 2) | 샘플 |"); log("|---|---|---|---|---|---|")
for nm, f in [("홍콩", "hks"), ("도쿄", "tse"), ("상해", "shs"), ("심천", "szs"), ("나스닥", "nas"), ("뉴욕", "nys")]:
    u = f"https://new.real.download.dws.co.kr/common/master/{f}mst.cod.zip"
    try:
        r = requests.get(u, timeout=40)
        if r.status_code != 200: log(f"| {nm} | {f} | {r.status_code} | | | |"); continue
        z = zipfile.ZipFile(io.BytesIO(r.content)); raw = z.read(z.namelist()[0]).decode("cp949", "ignore").splitlines()
        cols = [l.split("\t") for l in raw if l.strip()]
        typ2 = [c for c in cols if len(c) > 8 and c[8].strip() == "2"]
        s = " / ".join(f"{c[4] if len(c)>4 else ''}:{c[6] if len(c)>6 else ''}" for c in (typ2 or cols)[:3])
        log(f"| {nm} | {f} | 200 | {len(cols)} | {len(typ2)} | {s[:80]} |")
        if f == "hks": log("\n- 컬럼 예시: " + " | ".join(cols[0][:12]) + "\n")
    except Exception as e: log(f"| {nm} | {f} | 오류 | {str(e)[:60]} | | |")
open("kis_master_probe.md", "w", encoding="utf-8").write("\n".join(L))
