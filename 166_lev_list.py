# -*- coding: utf-8 -*-
"""KIS 종목마스터에서 레버리지·인버스 ETF 전체 목록(코드·이름) 조회 — 읽기 전용."""
import zipfile, io, re, requests
z = zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", timeout=30).content))
raw = z.read(z.namelist()[0]).decode("cp949", "ignore").splitlines()
etfs = [(x[:9].strip(), x[21:-227].strip()) for x in raw if len(x) >= 240 and x[-227:][:2] == "EF"]
L = [(c, n) for c, n in etfs if re.search(r"레버리지|인버스|2X|3X|곱버스", n)]
out = [f"ETF {len(etfs)}개 중 레버리지·인버스 {len(L)}개", ""] + [f"{c}\t{n}" for c, n in sorted(L, key=lambda x: x[1])]
open("lev_list.md", "w", encoding="utf-8").write("\n".join(out))
print("\n".join(out[:3]))
# 해외 레버리지 효율 체크용 기초(1배) ETF 후보
P = r"미국나스닥100$|미국나스닥100\(H\)|미국S&P500$|미국S&P500\(H\)|필라델피아반도체|일본TOPIX|유로스탁스50|MSCI|신흥국|이머징|미국30년국채|미국장기국채|미국달러선물$|빅테크TOP7|미국테크TOP10|차이나H|항셍테크|차이나전기차|중국본토CSI300|BBIG"
B = [(c, n) for c, n in etfs if re.search(P, n) and not re.search(r"레버리지|인버스|2X|커버드|버퍼|타겟|데일리|채권혼합|액티브", n)]
open("lev_list.md", "a", encoding="utf-8").write("\n\n## 기초 후보\n" + "\n".join(f"{c}\t{n}" for c, n in sorted(B, key=lambda x: x[1])))
