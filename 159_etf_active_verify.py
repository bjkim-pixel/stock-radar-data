# -*- coding: utf-8 -*-
"""사용자 관리 ETF 76개가 실제 액티브 ETF인지 KIS 상품 구분값(bstp_kor_isnm 등)으로 확인(읽기 전용)."""
import os,time,requests,importlib,collections
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
CODES=["451060", "385590", "494890", "413930", "445290", "433250", "0208N0", "0243M0", "385720", "0193G0", "403790", "445690", "448570", "487130", "395750", "395760", "401470", "385520", "476850", "472720", "391670", "471780", "457930", "495060", "364690", "495230", "387280", "404120", "447430", "444200", "441800", "474590", "388420", "0151P0", "365040", "496130", "373490", "0166S0", "0172Y0", "442260", "486240", "0226G0", "0074K0", "494330", "494220", "442090", "491510", "438740", "0254H0", "385600", "482030", "422420", "385710", "385510", "445150", "0150K0", "463050", "0000Z0", "498050", "462900", "0214M0", "0168K0", "0001P0", "407820", "0222D0", "470310", "0219B0", "0184V0", "0239Z0", "0053M0", "0220B0", "0162Y0", "0163Y0", "0191B0", "0204S0", "0166N0"]
def kget(code):
    time.sleep(0.1)
    for _ in range(2):
        try: return requests.get(B+"/uapi/etfetn/v1/quotations/inquire-price",params={"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code},timeout=20,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":"FHPST02400000","custtype":"P"}).json().get("output") or {}
        except Exception: time.sleep(1)
    return {}
L=["# 액티브 여부 확인 (KIS 상품 구분값)\n","| 코드 | 업종구분(bstp_kor_isnm) | ETF구분(etf_div_name) | 기초지수(etf_rprs_bstp_kor_isnm) | 운용사 |","|---|---|---|---|---|"]
cnt=collections.Counter()
for c in CODES:
    d=kget(c); k=d.get("bstp_kor_isnm"); cnt[k]+=1
    L.append(f"| {c} | {k} | {d.get('etf_div_name')} | {d.get('etf_rprs_bstp_kor_isnm')} | {d.get('mbcr_name')} |")
L.insert(1,"- 업종구분 분포: "+str(dict(cnt))+"\n")
open("etf_active_verify.md","w",encoding="utf-8").write("\n".join(L)); print(dict(cnt))
