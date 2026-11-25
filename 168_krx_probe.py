# -*- coding: utf-8 -*-
"""KRX Open API 엔드포인트별 권한/응답 점검. 키는 KRX_API_KEY 시크릿에서만 읽고 출력하지 않음."""
import os,json,datetime as dt,requests
KEY=os.environ.get("KRX_API_KEY","").strip(); L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
def bd(n):
    d=dt.date.today()
    while n>0:
        d-=dt.timedelta(days=1)
        if d.weekday()<5: n-=1
    return d.strftime("%Y%m%d")
P=["idx/bon_dd_trd","idx/drvprod_dd_trd","idx/kosdaq_dd_trd","idx/kospi_dd_trd","idx/krx_dd_trd",
   "etp/etf_bydd_trd","etp/etn_bydd_trd","etp/elw_bydd_trd",
   "drv/fut_bydd_trd","drv/opt_bydd_trd","drv/eqsfu_stk_bydd_trd","drv/eqkfu_ksp_bydd_trd","drv/eqsop_bydd_trd","drv/eqkop_bydd_trd",
   "drv/eqkfu_ksq_bydd_trd",
   "sto/stk_bydd_trd","sto/ksq_bydd_trd","sto/knx_bydd_trd","sto/sw_bydd_trd","sto/sr_bydd_trd","sto/stk_isu_base_info","sto/ksq_isu_base_info","sto/knx_isu_base_info",
   "sts/stk_bydd_trd","sts/ksq_bydd_trd","sts/stk_isu_base_info","sts/ksq_isu_base_info",
   "bon/kts_bydd_trd","bon/bnd_bydd_trd","bon/smb_bydd_trd",
   "gen/oil_bydd_trd","gen/gold_bydd_trd","gen/ets_bydd_trd"]
log("# KRX Open API 엔드포인트 점검 (기준일 "+bd(1)+")\n")
for p in P:
    for d in (bd(1),bd(2)):
        try:
            r=requests.get("https://data-dbg.krx.co.kr/svc/apis/"+p,params={"basDd":d},headers={"AUTH_KEY":KEY,"User-Agent":"Mozilla/5.0"},timeout=40)
            try: rows=r.json().get("OutBlock_1") or []
            except Exception: rows=[]
            msg="" if rows else r.text[:90].replace("\n"," ")
            log(f"- {p} {d}: HTTP {r.status_code} · 행 {len(rows)} {msg}")
            if rows:
                log("  키: "+", ".join(rows[0].keys())); log("  예: "+json.dumps(rows[0],ensure_ascii=False)[:380]); break
        except Exception as e: log(f"- {p} {d}: 실패 {str(e).replace(KEY,'***')[:80]}")
open("krx_probe.md","w",encoding="utf-8").write("\n".join(L))
