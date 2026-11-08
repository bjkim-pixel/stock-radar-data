✅ 공유 캐시 재사용 (남은 유효시간 13.3시간) — 발급 안 함

======================================================================
## KIS 예탁원 배당일정(종목)  /uapi/domestic-stock/v1/ksdinfo/dividend  tr_id=HHKDB669102C0
params={'CTS': '', 'GB1': '0', 'F_DT': '20240101', 'T_DT': '20261231', 'SHT_CD': '005930', 'HIGH_GB': ''}
http 200 rt_cd 0 msg 정상처리 되었습니다.
-- output1: list[11]
    {"record_date": "20260930", "sht_cd": "005930", "isin_name": "삼성전자", "divi_kind": "분기", "face_val": "100", "per_sto_divi_amt": "4601", "divi_rate": "4601.00", "stk_divi_rate": "0.00", "divi_pay_dt": "2026/11/27", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": "Y"}
    {"record_date": "20260630", "sht_cd": "005930", "isin_name": "삼성전자", "divi_kind": "분기", "face_val": "100", "per_sto_divi_amt": "374", "divi_rate": "374.00", "stk_divi_rate": "0.00", "divi_pay_dt": "2026/08/28", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": "Y"}
    {"record_date": "20260331", "sht_cd": "005930", "isin_name": "삼성전자", "divi_kind": "분기", "face_val": "100", "per_sto_divi_amt": "372", "divi_rate": "372.00", "stk_divi_rate": "0.00", "divi_pay_dt": "2026/05/29", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": "Y"}
    {"record_date": "20251231", "sht_cd": "005930", "isin_name": "삼성전자", "divi_kind": "결산", "face_val": "100", "per_sto_divi_amt": "566", "divi_rate": "566.00", "stk_divi_rate": "0.00", "divi_pay_dt": "2026/04/17", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": "Y"}
    {"record_date": "20250930", "sht_cd": "005930", "isin_name": "삼성전자", "divi_kind": "분기", "face_val": "100", "per_sto_divi_amt": "370", "divi_rate": "370.00", "stk_divi_rate": "0.00", "divi_pay_dt": "2025/11/19", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": ""}

======================================================================
## KIS 예탁원 배당일정(전체 기간 일부)  /uapi/domestic-stock/v1/ksdinfo/dividend  tr_id=HHKDB669102C0
params={'CTS': '', 'GB1': '0', 'F_DT': '20261101', 'T_DT': '20261231', 'SHT_CD': '', 'HIGH_GB': ''}
http 200 rt_cd 0 msg 정상처리 되었습니다.
-- output1: list[56]
    {"record_date": "20261231", "sht_cd": "381970", "isin_name": "케이지모빌리티플랫폼", "divi_kind": "결산", "face_val": "500", "per_sto_divi_amt": "0", "divi_rate": "0.00", "stk_divi_rate": "0.00", "divi_pay_dt": "", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": ""}
    {"record_date": "20261231", "sht_cd": "950140", "isin_name": "잉글우드랩 KDR", "divi_kind": "결산", "face_val": "0", "per_sto_divi_amt": "0", "divi_rate": "0.00", "stk_divi_rate": "0.00", "divi_pay_dt": "", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": ""}
    {"record_date": "20261214", "sht_cd": "293940", "isin_name": "신한알파위탁관리부동산투자회사", "divi_kind": "결산", "face_val": "1000", "per_sto_divi_amt": "184", "divi_rate": "18.40", "stk_divi_rate": "0.00", "divi_pay_dt": "", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": ""}
    {"record_date": "20261214", "sht_cd": "29394K", "isin_name": "신한알파위탁관리부동산투자회사1우", "divi_kind": "결산", "face_val": "1000", "per_sto_divi_amt": "413", "divi_rate": "41.30", "stk_divi_rate": "0.00", "divi_pay_dt": "", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "우선", "high_divi_gb": ""}
    {"record_date": "20261205", "sht_cd": "152550", "isin_name": "한국투자ANKOR유전해외자원개발특별자산투", "divi_kind": "결산", "face_val": "0", "per_sto_divi_amt": "0", "divi_rate": "0.00", "stk_divi_rate": "0.00", "divi_pay_dt": "", "stk_div_pay_dt": "", "odd_pay_dt": "", "stk_kind": "보통", "high_divi_gb": ""}

======================================================================
## KIS 배당률 상위  /uapi/domestic-stock/v1/ranking/dividend-rate  tr_id=HHKDB13470100
params={'CTS_AREA': '', 'GB1': '1', 'UPJONG': '0001', 'GB2': '0', 'GB3': '2', 'F_DT': '20250101', 'T_DT': '20251231', 'GB4': '0'}
http 200 rt_cd 0 msg 정상처리 되었습니다.
-- output: list[20]
    {"rank": "1", "sht_cd": "000815", "isin_name": "삼성화재해상보험1우", "record_date": "20250326", "per_sto_divi_amt": "19005", "divi_rate": "3801.00", "divi_kind": "결산"}
    {"rank": "2", "sht_cd": "000810", "isin_name": "삼성화재해상보험", "record_date": "20250326", "per_sto_divi_amt": "19000", "divi_rate": "3800.00", "divi_kind": "결산"}
    {"rank": "3", "sht_cd": "278470", "isin_name": "에이피알", "record_date": "20250728", "per_sto_divi_amt": "3590", "divi_rate": "3590.00", "divi_kind": "분기"}
    {"rank": "4", "sht_cd": "02826K", "isin_name": "삼성물산1우", "record_date": "20251231", "per_sto_divi_amt": "2850", "divi_rate": "2850.00", "divi_kind": "결산"}
    {"rank": "5", "sht_cd": "028260", "isin_name": "삼성물산", "record_date": "20251231", "per_sto_divi_amt": "2800", "divi_rate": "2800.00", "divi_kind": "결산"}

======================================================================
## KIS 재무비율(배당 필드 있나)  /uapi/domestic-stock/v1/finance/financial-ratio  tr_id=FHKST66430300
params={'fid_cond_mrkt_div_code': 'J', 'fid_input_iscd': '005930', 'FID_DIV_CLS_CODE': '0'}
http 200 rt_cd 0 msg 정상처리 되었습니다.
-- output: list[23]
    {"stac_yymm": "202606", "grs": "98.6700", "bsop_prfi_inrt": "1191.4400", "ntin_inrt": "790.9700", "roe_val": "31.39", "eps": "17687.00", "sps": "72276", "bps": "86052.00", "rsrv_rate": "57213.7600", "lblt_rate": "31.1000"}
    {"stac_yymm": "202512", "grs": "10.8800", "bsop_prfi_inrt": "33.2300", "ntin_inrt": "31.2200", "roe_val": "10.85", "eps": "6564.00", "sps": "49471", "bps": "63997.00", "rsrv_rate": "45296.1700", "lblt_rate": "29.9400"}
    {"stac_yymm": "202412", "grs": "16.2000", "bsop_prfi_inrt": "398.3400", "ntin_inrt": "122.4500", "roe_val": "9.03", "eps": "4950.00", "sps": "44293", "bps": "57981.00", "rsrv_rate": "41772.8400", "lblt_rate": "27.9300"}
    {"stac_yymm": "202312", "grs": "-14.3300", "bsop_prfi_inrt": "-84.8600", "ntin_inrt": "-72.1700", "roe_val": "4.15", "eps": "2131.00", "sps": "38120", "bps": "52002.00", "rsrv_rate": "39114.2800", "lblt_rate": "25.3600"}
    {"stac_yymm": "202212", "grs": "8.0900", "bsop_prfi_inrt": "-15.9900", "ntin_inrt": "39.4600", "roe_val": "17.07", "eps": "8057.00", "sps": "44494", "bps": "50817.00", "rsrv_rate": "38144.2900", "lblt_rate": "26.4100"}

======================================================================
## KIS 현재가 시세(배당 필드 있나)  /uapi/domestic-stock/v1/quotations/inquire-price  tr_id=FHKST01010100
params={'FID_COND_MRKT_DIV_CODE': 'J', 'FID_INPUT_ISCD': '005930'}
http 200 rt_cd 0 msg 정상처리 되었습니다.
-- output: {"iscd_stat_cls_code": "55", "marg_rate": "40.00", "rprs_mrkt_kor_name": "KOSPI200", "bstp_kor_isnm": "전기·전자", "temp_stop_yn": "N", "oprc_rang_cont_yn": "N", "clpr_rang_cont_yn": "N", "crdt_able_yn": "Y", "grmn_rate_cls_code": "40", "elw_pblc_yn": "Y", "stck_prpr": "193500", "prdy_vrss": "-8000", "prdy_vrss_sign": "5", "prdy_ctrt": "-3.97", "acml_tr_pbmn": "6706958072285", "acml_vol": "35516270", "prdy_vrss_vol_rate": "144.04", "stck_oprc": "180000", "stck_hgpr": "196500", "stck_lwpr": "179200", "stck_mxpr": "261500", "stck_llam": "141500", "stck_sdpr": "201500", "wghn_avrg_stck_prc": "188838.30", "hts_frgn_ehrt": "45.94", "frgn_ntby_qty": "-371509", "pgtr_ntby_qty": "544931", "pvt_scnd_dmrs_prc": "218633", "pvt_frst_dmrs_prc": "210066", "pvt_pont_val": "204933", "pvt_frst_dmsp_prc": "196366", "pvt_scnd_dmsp_prc": "191233", "dmrs_val": "207500", "dmsp_val": "193800", "cpfn": "7780", "rstc_wdth_prc": "60000", "stck_fcam": "100", "stck_sspr": "145080", "aspr_unit": "100", "hts_deal_qty_unit_val": "1", "lstn_stcn": "5846278608", "hts_avls": "11312549", "per": "29.48", "pbr": "3.02", "stac_month": "12", "vol_tnrt": "0.61", "eps": "6564.00", "bps": "63997.00", "d250_hgpr": "374500", "d250_hgpr_date": "20260619", "d250_hgpr_vrss_prpr_rate": "-48.33", "d250_lwpr": "94500", "d250_lwpr_date": "20251121", "d250_lwpr_vrss_prpr_rate": "104.76", "stck_dryy_hgpr": "374500", "dryy_hgpr_vrss_prpr_rate": "-48.33", "dryy_hgpr_date": "20260619", "stck_dryy_lwpr": "120200", "dryy_lwpr_vrss_prpr_rate": "60.98", "dryy_lwpr_date": "20260102", "w52_hgpr": "374500", "w52_hgpr_vrss_prpr_ctrt": "-48.33", "w52_hgpr_date": "20260619", "w52_lwpr": "94500", "w52_lwpr_vrss_prpr_ctrt": "104.76", "w52_lwpr_date": "20251121", "whol_loan_rmnd_rate": "0.32", "ssts_yn": "Y", "stck_shrn_iscd": "005930", "fcam_cnnm": "100", "cpfn_cnnm": "7,780 억", "frgn_hldn_qty": "2685777853", "vi_cls_code": "N", "ovtm_vi_cls_code": "N", "last_ssts_cntg_qty": "665280", "invt_caful_yn": "N", "mrkt_warn_cls_code": "00", "short_over_yn": "N", "sltr_yn": "N", "mang_issu_cls_code": "N"}

======================================================================
## 네이버 모바일 integration
https://m.stock.naver.com/api/stock/005930/integration
http 200 len 9238
keys ['stockEndType', 'itemCode', 'reutersCode', 'stockName', 'totalInfos', 'iconInfos', 'description', 'etfKeyIndicator', 'dealTrendInfos', 'researches', 'industryCode', 'industryCompareInfo', 'consensusInfo', 'shareholdersMeetingInfo', 'irScheduleInfo']
  totalInfos: {"code": "dividendYieldRatio", "key": "배당수익률", "value": "0.86%", "valueDesc": "2025.12."}
  totalInfos: {"code": "dividend", "key": "주당배당금", "value": "1,668원", "valueDesc": "2025.12."}

======================================================================
## 네이버 모바일 finance/annual
https://m.stock.naver.com/api/stock/005930/finance/annual
http 200 len 3840
기간: ['2023.12.', '2024.12.', '2025.12.', '2026.12.']
  주당배당금 {'202512': '1,668', '202612': '9,566', '202312': '1,444', '202412': '1,446'}
  전체 행 제목: ['매출액', '영업이익', '당기순이익', '지배주주순이익', '비지배주주순이익', '영업이익률', '순이익률', 'ROE', '부채비율', '당좌비율', '유보율', 'EPS', 'PER', 'BPS', 'PBR', '주당배당금']

======================================================================
## 네이버 모바일 finance/quarter
https://m.stock.naver.com/api/stock/005930/finance/quarter
http 200 len 5121
기간: ['2025.06.', '2025.09.', '2025.12.', '2026.03.', '2026.06.', '2026.09.']
  주당배당금 {'202509': '370', '202609': '-', '202606': '374', '202506': '367', '202603': '372', '202512': '566'}
  전체 행 제목: ['매출액', '영업이익', '당기순이익', '지배주주순이익', '비지배주주순이익', '영업이익률', '순이익률', 'ROE', '부채비율', '당좌비율', '유보율', 'EPS', 'PER', 'BPS', 'PBR', '주당배당금']

======================================================================
## 네이버 PC 메인
https://finance.naver.com/item/main.naver?code=005930
http 200 len 137071
