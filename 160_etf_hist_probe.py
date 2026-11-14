# -*- coding: utf-8 -*-
"""ETF 과거 구성종목(PDF) 소스 점검(읽기 전용): KRX 일자별 PDF, KIS 구성종목(레버리지·인버스 형태), KIS 예탁원 분배금."""
import os,io,re,json,time,zipfile,requests,importlib
L=[]
def log(m=""): print(m,flush=True); L.append(str(m))
KIS_KEY=os.environ.get("KIS_APP_KEY",""); KIS_SECRET=os.environ.get("KIS_APP_SECRET","")
B="https://openapi.koreainvestment.com:9443"
tok=os.environ.get("KIS_ACCESS_TOKEN","").strip() or importlib.import_module("72_kis_token").get_token_cached()
def kget(path,tr,params):
    time.sleep(0.15)
    try: return requests.get(B+path,params=params,timeout=25,headers={"Content-Type":"application/json; charset=utf-8","authorization":f"Bearer {tok}","appkey":KIS_KEY,"appsecret":KIS_SECRET,"tr_id":tr,"custtype":"P"}).json()
    except Exception as e: return {"error":str(e)}
raw=zipfile.ZipFile(io.BytesIO(requests.get("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",timeout=30).content))
raw=raw.read(raw.namelist()[0]).decode("cp949","ignore").splitlines()
ISIN={x[:9].strip():x[9:21].strip() for x in raw if len(x)>=240}
log("# ETF 과거 PDF 소스 점검\n")
# 1) KRX 정보데이터시스템 MDCSTAT05001 (ETF PDF, 일자 지정)
S=requests.Session(); S.headers.update({"User-Agent":"Mozilla/5.0","Referer":"https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201030108"})
try:
    r0=S.get("https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201030108",timeout=20); log(f"- KRX 메인 {r0.status_code}")
except Exception as e: log(f"- KRX 메인 실패 {e}")
for code in ("0163Y0","474590"):
    for d in ("20261106","20261113"):
        data={"bld":"dbms/MDC/STAT/standard/MDCSTAT05001","locale":"ko_KR","isuCd":ISIN.get(code,""),"trdDd":d,"share":"1","money":"1","csvxls_isNo":"false"}
        try:
            r=S.post("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd",data=data,timeout=25)
            t=r.text[:300]; log(f"- KRX {code}({ISIN.get(code)}) {d}: HTTP {r.status_code} · {t}")
            try:
                j=r.json(); rows=j.get("output") or j.get("OutBlock_1") or []
                log(f"  행 {len(rows)} · 키 {list(rows[0].keys()) if rows else list(j.keys())}")
                for x in rows[:3]: log("  "+json.dumps(x,ensure_ascii=False)[:300])
            except Exception as e: log(f"  JSON 아님: {e}")
        except Exception as e: log(f"- KRX 요청 실패 {e}")
# 2) KIS 구성종목: 레버리지·인버스·코스닥 액티브 응답 형태, output2 개수
for code in ("0197X0","122630","252670","0163Y0"):
    d=kget("/uapi/etfetn/v1/quotations/inquire-component-stock-price","FHKST121600C0",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code,"FID_COND_SCR_DIV_CODE":"11216"})
    o1=d.get("output1") or {}; o2=d.get("output2") or []
    log(f"\n## KIS 구성 {code}: rt={d.get('rt_cd')} msg={d.get('msg1')} · 구성종목수 {o1.get('etf_cnfg_issu_cnt')} · 응답행 {len(o2)}")
    for x in o2[:5]: log("  "+json.dumps({k:x.get(k) for k in ('stck_shrn_iscd','hts_kor_isnm','etf_cu_unit_scrt_cnt','etf_cnfg_issu_rlim','etf_vltn_amt','etf_cnfg_issu_avls','stck_prpr')},ensure_ascii=False))
    e=kget("/uapi/etfetn/v1/quotations/inquire-price","FHPST02400000",{"FID_COND_MRKT_DIV_CODE":"J","FID_INPUT_ISCD":code}).get("output") or {}
    log("  현재가: "+json.dumps({k:e.get(k) for k in ('bstp_kor_isnm','etf_div_name','etf_rprs_bstp_kor_isnm','mbcr_name','etf_trc_ert_mltp','etf_dvdn_cycl','etf_ntas_ttam','nav','dprt','etf_cnfg_issu_cnt','stck_lstn_date')},ensure_ascii=False))
# 3) KIS 예탁원 배당(분배금) — ETF 코드로
for code in ("0163Y0","494890","441800"):
    d=kget("/uapi/domestic-stock/v1/ksdinfo/dividend","HHKDB669102C0",{"CTS":"","GB1":"0","F_DT":"20250101","T_DT":"20261231","SHT_CD":code,"HIGH_GB":""})
    o=d.get("output1") or d.get("output") or []
    log(f"\n## KIS 분배금 {code}: rt={d.get('rt_cd')} msg={d.get('msg1')} 행 {len(o)}")
    for x in o[:4]: log("  "+json.dumps(x,ensure_ascii=False)[:300])
open("etf_hist_probe.md","w",encoding="utf-8").write("\n".join(L))
