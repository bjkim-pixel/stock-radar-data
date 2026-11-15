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
