# -*- coding: utf-8 -*-
"""종목별 대체거래소(NXT) 거래 가능 여부(=20시 마감) → stocks.nxt_ok. KIS 주식기본조회(CTPF1002R)의 cptt_trad_tr_psbl_yn.
7일 안에 확인한 종목은 건너뜀. 사용: python 148_nxt_flag.py"""
import os,time,importlib,datetime,requests,psycopg2
KEY=os.environ["KIS_APP_KEY"]; SEC=os.environ["KIS_APP_SECRET"]
tok=importlib.import_module("72_kis_token").get_token_cached()
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=True; cur=conn.cursor()
cur.execute(open("147_sw_strategy.sql",encoding="utf-8").read())
cur.execute("select code from stocks where is_active and security_type='STOCK' and (nxt_checked is null or nxt_checked < current_date - 7) order by code")
codes=[r[0] for r in cur.fetchall()]; ok=bad=0; today=datetime.date.today()
H={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KEY,"appsecret":SEC,"tr_id":"CTPF1002R","custtype":"P"}
for c in codes:
    for _ in range(3):
        time.sleep(0.13)
        try:
            j=requests.get("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info",params={"PRDT_TYPE_CD":"300","PDNO":c},headers=H,timeout=20).json()
            if "초당" in str(j.get("msg1","")): time.sleep(1); continue
            o=j.get("output") or {}; v=o.get("cptt_trad_tr_psbl_yn")
            if v in ("Y","N"):
                cur.execute("update stocks set nxt_ok=%s, nxt_checked=%s where code=%s",(v=="Y" and o.get("nxt_tr_stop_yn")!="Y",today,c)); ok+=1
            else: bad+=1
            break
        except Exception: time.sleep(1)
cur.execute("select count(*) filter (where nxt_ok), count(*) filter (where nxt_ok is false), count(*) filter (where nxt_ok is null) from stocks where is_active and security_type='STOCK'")
print(f"NXT 표시 갱신: 대상 {len(codes)} · 성공 {ok} · 실패 {bad} · 현재 가능/불가/미확인 = {cur.fetchone()}")
