# -*- coding: utf-8 -*-
import os, io, zipfile, requests, psycopg2, xml.etree.ElementTree as ET
KEY = os.environ["DART_API_KEY"].strip(); B = "https://opendart.fss.or.kr/api/"; L = []
z = zipfile.ZipFile(io.BytesIO(requests.get(B + "corpCode.xml", params={"crtfc_key": KEY}, timeout=60).content)); x = ET.fromstring(z.read(z.namelist()[0]))
cc = {i.findtext("stock_code").strip(): i.findtext("corp_code") for i in x.iter("list") if (i.findtext("stock_code") or "").strip()}
c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); cur = c.cursor()
cur.execute("select s.code,s.name from stock_earnings e join stocks s using(code) where e.freq='Q' and e.period='202609' and e.is_est order by 1"); miss = cur.fetchall()
L.append(f"3분기 예상으로 남은 {len(miss)}종목 중 DART 3분기 보고서(재무)가 조회되는 수 확인(앞 12개 + 기가비스)")
test = [m for m in miss if m[0] == "420770"] + miss[:12]; ok = 0
for code, nm in test:
    j = requests.get(B + "fnlttSinglAcnt.json", params={"crtfc_key": KEY, "corp_code": cc.get(code, ""), "bsns_year": "2026", "reprt_code": "11014"}, timeout=30).json()
    if j.get("status") != "000": L.append(f"- {nm} {code}: 상태 {j.get('status')} {j.get('message')}"); continue
    rs = [r for r in j["list"] if r.get("account_nm") in ("영업이익", "영업이익(손실)") and r.get("sj_div") == "IS"]
    L.append(f"- {nm} {code}: " + " | ".join(f"{r['fs_div']} 당기3개월={r.get('thstrm_amount')} 누적={r.get('thstrm_add_amount')} 전기3개월={r.get('frmtrm_q_amount')}" for r in rs[:2])); ok += 1
L.append(f"조회 성공 {ok}/{len(test)}")
open("actual_probe.md", "w", encoding="utf-8").write("\n".join(L)); print("\n".join(L))
