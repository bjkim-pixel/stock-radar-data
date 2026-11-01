# KIS 채권 API 점검 (2026-11-01 01:48 UTC)

- 토큰: OK
## 1) 채권 종목 코드 확보
- bond_code.mst.zip: HTTP 200 262411B
  - bond_code.mst: 18140행 · 예: ['F902KR101701D716국민주택2종17-01                        12201701022017013120270131                        N', 'F902KR101701D757국민주택2종17-05                        12201705022017053120270531                        N', 'F902KR102701GFB2외평채권02500-2611(25-11)               13202511242025111020261110                        N']
- bondmst.zip: HTTP 404 345B
- 마스터에서 추출한 코드 4000개 · 예 ['KR101701D716', 'KR101701D757', 'KR102701GFB2', 'KR102701GFC0', 'KR102701GG13']

## 2) 채권 기본/발행정보
- search-bond-info KR101701D716/300: HTTP 200 rt_cd=7 msg=조회된 데이터가 없습니다.(예탁원수신채권종목일반)                               
- search-bond-info KR101701D716/302: HTTP 200 rt_cd=0 msg=조회되었습니다                                                               
  - output 필드 81개(값있음 64): {"pdno": "KR101701D716", "prdt_type_cd": "302", "ksd_bond_item_name": "국민주택2종 2017-01", "ksd_bond_item_eng_name": "KOREA NATIONAL HOUSING BOND (Ⅱ) 2017-01", "ksd_bond_lstg_type_cd": "11", "ksd_ofrg_dvsn_cd": "11", "ksd_bond_int_dfrm_dvsn_cd": "3", "issu_dt": "20170131", "rdpt_dt": "20270131", "rvnu_dt": "20170131", "iso_crcy_cd": "KRW", "mdwy_rdpt_dt": "00000000", "ksd_rcvg_bond_dsct_rt": "0.000000000000", "ksd_rcvg_bond_srfc_inrt": "0.000000000000", "bond_expd_rdpt_rt": "100.000000000000", "ksd_prca_rdpt_mthd_cd": "11", "int_caltm_mcnt": "12", "ksd_int_calc_unit_cd": "2", "uval_cut_dvsn_cd": "2", "ksd_dydv_caltm_aply_dvsn_cd": "1", "bond_expd_asrc_erng_rt": "0.000000000000", "padf_plac_hdof_name": "우리", "lstg_dt": "20170102", "lstg_abol_dt": "20270201", "ksd_bond_issu_mthd_cd": "2", "laps_indf_yn": "N", "ksd_lhdy_pnia_dfrm_mthd_cd": "2", "frst_int_dfrm_dt": "00000000", "ksd_prcm_lnkg_gvbd_yn": "N", "dpsi_end_dt": "20270201", "dpsi_strt_dt": "20190913", "dpsi_psbl_yn": "Y", "atyp_rdpt_bond_erlm_yn": "N", "dshn_occr_yn": "N", "expd_exts_yn": "N", "expd_exts_srdp_rt": "0.000000000000", "bond_int_dfrm_mthd_cd": "02", "nxtm_int_dfrm_dt": "20270131", "sprx_psbl_yn": "N", "bond_clsf_cd": "111300"}
- issue-info: HTTP 200 rt_cd=0 msg=조회되었습니다                                                               
  - output 필드 86개(값있음 45): {"pdno": "KR101701D716", "prdt_type_cd": "302", "prdt_name": "국민주택2종채권17-01", "prdt_eng_name": "KOREA NATIONAL HOUSING BOND (Ⅱ)17-01", "ivst_heed_prdt_yn": "N", "exts_yn": "N", "bond_clsf_cd": "111300", "bond_clsf_kor_name": "국민주택2종채권", "papr": "10000", "int_mned_dvsn_cd": "2", "issu_amt": "282120000", "lstg_rmnd": "282120000", "int_dfrm_mcnt": "12", "bond_int_dfrm_mthd_cd": "02", "int_anap_dvsn_cd": "2", "prdt_abrv_name": "국민주택2종17-01", "prdt_eng_abrv_name": "KNHB (Ⅱ)17-01", "sprx_psbl_yn": "N", "pbff_pplc_ofrg_mthd_cd": "01", "issu_istt_cd": "GB017", "issu_istt_name": "국민주택2종채권", "pnia_dfrm_agcy_istt_cd": "1107", "bond_grte_istt_name": "국민주택2종채권", "ksd_int_calc_unit_cd": "2", "int_wunt_uder_prcs_dvsn_cd": "1", "rvnu_dt": "20170102", "issu_dt": "20170131", "lstg_dt": "20170102", "expd_dt": "20270131", "sbst_pric": "9740", "nxtm_int_dfrm_dt": "20270131", "oprt_stfno": "BATCH", "nxtm_int_dfrm_wday": "01", "dpsi_psbl_yn": "Y", "prcm_idx_bond_yn": "N", "loan_psbl_yn": "Y", "grte_dvsn_cd": "4", "fnrr_rank_dvsn_cd": "1", "krx_lstg_abol_dvsn_cd": "Y", "crfd_item_yn": "N"}

## 3) 시세(현재가·호가·체결·일별·차트)
- 현재가(시세) (FHKBJ773400C0): HTTP 200 rt_cd=0 msg=정상처리 되었습니다.
  - output 필드 17개(값있음 15): {"stnd_iscd": "KR101701D716", "hts_kor_isnm": "국민주택2종17-01", "bond_prpr": "9900.00", "bond_prdy_vrss": "0.00", "prdy_ctrt": "0.00", "bond_prdy_clpr": "9900.00", "bond_oprc": "0.00", "bond_hgpr": "0.00", "bond_lwpr": "0.00", "ernn_rate": "0.000", "oprc_ert": "0.000", "hgpr_ert": "0.000", "lwpr_ert": "0.000", "bond_mxpr": "12923.60", "bond_llam": "6959.00"}
- 현재가(호가) (FHKBJ773401C0): HTTP 200 rt_cd=0 msg=정상처리 되었습니다.
  - output 필드 34개(값있음 21): {"aspr_acpt_hour": "104808", "bond_askp1": "0.00", "bond_askp2": "0.00", "bond_askp3": "0.00", "bond_askp4": "0.00", "bond_askp5": "0.00", "bond_bidp1": "0.00", "bond_bidp2": "0.00", "bond_bidp3": "0.00", "bond_bidp4": "0.00", "bond_bidp5": "0.00", "seln_ernn_rate1": "0.000", "seln_ernn_rate2": "0.000", "seln_ernn_rate3": "0.000", "seln_ernn_rate4": "0.000", "seln_ernn_rate5": "0.000", "shnu_ernn_rate1": "0.000", "shnu_ernn_rate2": "0.000", "shnu_ernn_rate3": "0.000", "shnu_ernn_rate4": "0.000", "shnu_ernn_rate5": "0.000"}
- 현재가(체결) (FHKBJ773403C0): HTTP 200 rt_cd=0 msg=정상처리 되었습니다.
  - output=list[0]
- 현재가(일별) (FHKBJ773404C0): HTTP 200 rt_cd=0 msg=정상처리 되었습니다.
  - output=list[13] | output 필드 9개(값있음 8): {"stck_bsop_date": "20261030", "bond_prpr": "9900.00", "bond_prdy_vrss": "0.00", "prdy_vrss_sign": "3", "prdy_ctrt": "0.00", "bond_oprc": "0.00", "bond_hgpr": "0.00", "bond_lwpr": "0.00"}
- 기간별시세(일) (FHKBJ773701C0): HTTP 200 rt_cd=0 msg=정상처리 되었습니다.
  - output=list[13] | output 필드 6개(값있음 5): {"stck_bsop_date": "20261030", "bond_oprc": "0.00", "bond_hgpr": "0.00", "bond_lwpr": "0.00", "bond_prpr": "9900.00"}
- 평균단가 (CTPF2005R): HTTP 200 rt_cd=7 msg=입력항목  오류입니다.존재하지 않는 상품                                         
  - {'rt_cd': '7', 'msg_cd': 'KIER2190', 'msg1': '입력항목  오류입니다.존재하지 않는 상품                                         '}

## 4) 금리 종합(국내채권/금리)
- 금리종합 FHPST07020000: HTTP 200 rt_cd=0 msg=정상처리 되었습니다.
  - output1=list[7] | output1 필드 7개(값있음 7): {"bcdt_code": "Y0201", "hts_kor_isnm": "미국 30년T-BOND", "bond_mnrt_prpr": "5.3100", "prdy_vrss_sign": "5", "bond_mnrt_prdy_vrss": "-0.0100", "prdy_ctrt": "-0.19", "stck_bsop_date": "20261030"} | output2=list[18] | output2 필드 7개(값있음 7): {"bcdt_code": "Y0101", "hts_kor_isnm": "Y0109", "bond_mnrt_prpr": "Y0117", "prdy_vrss_sign": "국고채 30년", "bond_mnrt_prdy_vrss": "4.1560", "bstp_nmix_prdy_ctrt": "5", "stck_bsop_date": "-0.0560"}
    · {"bcdt_code": "Y0201", "hts_kor_isnm": "미국 30년T-BOND", "bond_mnrt_prpr": "5.3100", "prdy_vrss_sign": "5", "bond_mnrt_prdy_vrss": "-0.0100", "prdy_ctrt": "-0.19", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0202", "hts_kor_isnm": "미국 10년T-NOTE 수익률", "bond_mnrt_prpr": "4.9400", "prdy_vrss_sign": "5", "bond_mnrt_prdy_vrss": "-0.0400", "prdy_ctrt": "-0.80", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0203", "hts_kor_isnm": "미국 1년T-BILL", "bond_mnrt_prpr": "4.3600", "prdy_vrss_sign": "5", "bond_mnrt_prdy_vrss": "-0.0600", "prdy_ctrt": "-1.36", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0204", "hts_kor_isnm": "미국 연방기금금리(콜)", "bond_mnrt_prpr": "3.8800", "prdy_vrss_sign": "3", "bond_mnrt_prdy_vrss": "0.0000", "prdy_ctrt": "0.00", "stck_bsop_date": "20261029"}
    · {"bcdt_code": "Y0205", "hts_kor_isnm": "미국 재할인률", "bond_mnrt_prpr": "4.0000", "prdy_vrss_sign": "3", "bond_mnrt_prdy_vrss": "0.0000", "prdy_ctrt": "0.00", "stck_bsop_date": "20261029"}
    · {"bcdt_code": "Y0206", "hts_kor_isnm": "미국 단기우대금리", "bond_mnrt_prpr": "7.0000", "prdy_vrss_sign": "3", "bond_mnrt_prdy_vrss": "0.0000", "prdy_ctrt": "0.00", "stck_bsop_date": "20261029"}
    · {"bcdt_code": "Y0207", "hts_kor_isnm": "일본 10년 국채수익률", "bond_mnrt_prpr": "2.8760", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.0090", "prdy_ctrt": "0.31", "stck_bsop_date": "20261029"}
    · {"bcdt_code": "Y0101", "hts_kor_isnm": "Y0109", "bond_mnrt_prpr": "Y0117", "prdy_vrss_sign": "국고채 30년", "bond_mnrt_prdy_vrss": "4.1560", "bstp_nmix_prdy_ctrt": "5", "stck_bsop_date": "-0.0560"}
    · {"bcdt_code": "Y0103", "hts_kor_isnm": "Y0111", "bond_mnrt_prpr": "Y0199", "prdy_vrss_sign": "CD AAA 3개월(13주)", "bond_mnrt_prdy_vrss": "219.5401", "bstp_nmix_prdy_ctrt": "2"}
    · {"bcdt_code": "Y0104", "hts_kor_isnm": "Y0112", "bond_mnrt_prpr": "C D (91��)", "prdy_vrss_sign": "3.3200", "bond_mnrt_prdy_vrss": "2", "bstp_nmix_prdy_ctrt": "0.0300"}
    · {"bcdt_code": "Y0105", "hts_kor_isnm": "Y0113", "bond_mnrt_prpr": "C P (91��)", "prdy_vrss_sign": "3.8000", "bond_mnrt_prdy_vrss": "2", "bstp_nmix_prdy_ctrt": "0.0100"}
    · {"bcdt_code": "Y0106", "hts_kor_isnm": "Y0114", "bond_mnrt_prpr": "�� (1��)", "prdy_vrss_sign": "3.0300", "bond_mnrt_prdy_vrss": "2", "bstp_nmix_prdy_ctrt": "0.0500", "stck_bsop_date": "1.68"}
    · {"bcdt_code": "Y0107", "hts_kor_isnm": "Y0115", "bond_mnrt_prpr": "����ä������", "prdy_vrss_sign": "99.7500", "bond_mnrt_prdy_vrss": "2", "bstp_nmix_prdy_ctrt": "0.1800"}
    · {"bcdt_code": "Y0108", "hts_kor_isnm": "Y0116", "bond_mnrt_prpr": "����ä 20��", "prdy_vrss_sign": "4.1300", "bond_mnrt_prdy_vrss": "5", "bstp_nmix_prdy_ctrt": "-0.0410", "stck_bsop_date": "-0.98"}
    · {"bcdt_code": "Y0109", "hts_kor_isnm": "Y0117", "bond_mnrt_prpr": "����ä 30��", "prdy_vrss_sign": "4.1560", "bond_mnrt_prdy_vrss": "5", "bstp_nmix_prdy_ctrt": "-0.0560", "stck_bsop_date": "-1.33"}
    · {"bcdt_code": "Y0110", "hts_kor_isnm": "Y0198", "bond_mnrt_prpr": "Call ����", "prdy_vrss_sign": "204.9796", "bond_mnrt_prdy_vrss": "2", "bstp_nmix_prdy_ctrt": "0.0344"}
    · {"bcdt_code": "Y0111", "hts_kor_isnm": "Y0199", "bond_mnrt_prpr": "CD AAA 3����(13��)", "prdy_vrss_sign": "219.5401", "bond_mnrt_prdy_vrss": "2", "bstp_nmix_prdy_ctrt": "0.0399"}
    · {"bcdt_code": "Y0112", "hts_kor_isnm": "C D (91일)", "bond_mnrt_prpr": "3.3200", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.0300", "bstp_nmix_prdy_ctrt": "0.91", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0113", "hts_kor_isnm": "C P (91일)", "bond_mnrt_prpr": "3.8000", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.0100", "bstp_nmix_prdy_ctrt": "0.26", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0114", "hts_kor_isnm": "콜 (1일)", "bond_mnrt_prpr": "3.0300", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.0500", "bstp_nmix_prdy_ctrt": "1.68", "stck_bsop_date": "20261029"}
    · {"bcdt_code": "Y0115", "hts_kor_isnm": "종합채권지수", "bond_mnrt_prpr": "99.7500", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.1800", "bstp_nmix_prdy_ctrt": "0.18", "stck_bsop_date": "20261029"}
    · {"bcdt_code": "Y0116", "hts_kor_isnm": "국고채 20년", "bond_mnrt_prpr": "4.1300", "prdy_vrss_sign": "5", "bond_mnrt_prdy_vrss": "-0.0410", "bstp_nmix_prdy_ctrt": "-0.98", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0117", "hts_kor_isnm": "국고채 30년", "bond_mnrt_prpr": "4.1560", "prdy_vrss_sign": "5", "bond_mnrt_prdy_vrss": "-0.0560", "bstp_nmix_prdy_ctrt": "-1.33", "stck_bsop_date": "20261030"}
    · {"bcdt_code": "Y0198", "hts_kor_isnm": "Call 지수", "bond_mnrt_prpr": "204.9796", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.0344", "bstp_nmix_prdy_ctrt": "0.02", "stck_bsop_date": "20261101"}
    · {"bcdt_code": "Y0199", "hts_kor_isnm": "CD AAA 3개월(13주)", "bond_mnrt_prpr": "219.5401", "prdy_vrss_sign": "2", "bond_mnrt_prdy_vrss": "0.0399", "bstp_nmix_prdy_ctrt": "0.02", "stck_bsop_date": "20261101"}