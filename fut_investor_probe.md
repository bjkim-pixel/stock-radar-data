# KIS 선물 투자자 점검 (기준 20261125)
## 시장별 투자자매매동향 일별(FHPTJ04040000) — 선물 코드 후보
- ISCD=K2I ISCD_1=K2I: rt_cd=0 msg=정상처리 되었습니다. · 0행
- ISCD=K2I ISCD_1=KSP: rt_cd=0 msg=정상처리 되었습니다. · 0행
- ISCD=2001 ISCD_1=KSP: rt_cd=0 msg=정상처리 되었습니다. · 300행 · 20250902~20261125
  {"stck_bsop_date": "20261125", "bstp_nmix_prpr": "729.81", "frgn_ntby_qty": "-5096", "frgn_ntby_tr_pbmn": "-1460463", "prsn_ntby_tr_pbmn": "1217199", "orgn_ntby_tr_pbmn": "-77923"}
- ISCD=2001 ISCD_1=K2I: rt_cd=0 msg=정상처리 되었습니다. · 300행 · 20250902~20261125
  {"stck_bsop_date": "20261125", "bstp_nmix_prpr": "729.82", "frgn_ntby_qty": "0", "frgn_ntby_tr_pbmn": "0", "prsn_ntby_tr_pbmn": "0", "orgn_ntby_tr_pbmn": "0"}
- ISCD=FUT ISCD_1=FUT: rt_cd=0 msg=정상처리 되었습니다. · 0행
- ISCD=0001 ISCD_1=K2I: rt_cd=0 msg=정상처리 되었습니다. · 300행 · 20250902~20261125
  {"stck_bsop_date": "20261125", "bstp_nmix_prpr": "4728.16", "frgn_ntby_qty": "0", "frgn_ntby_tr_pbmn": "0", "prsn_ntby_tr_pbmn": "0", "orgn_ntby_tr_pbmn": "0"}
- ISCD=0001 ISCD_1=FUT: rt_cd=0 msg=정상처리 되었습니다. · 300행 · 20250902~20261125
  {"stck_bsop_date": "20261125", "bstp_nmix_prpr": "4728.16", "frgn_ntby_qty": "0", "frgn_ntby_tr_pbmn": "0", "prsn_ntby_tr_pbmn": "0", "orgn_ntby_tr_pbmn": "0"}
- ISCD=K200 ISCD_1=K200: rt_cd=0 msg=정상처리 되었습니다. · 0행
- ISCD=101 ISCD_1=FUT: rt_cd=0 msg=정상처리 되었습니다. · 0행

## 시장별 투자자매매동향 당일(FHPTJ04030000)
- ISCD=K2I: rt_cd=0 msg=정상처리 되었습니다. · 1행
  {"frgn_ntby_qty": "0", "frgn_ntby_tr_pbmn": "0", "prsn_ntby_tr_pbmn": "0", "orgn_ntby_tr_pbmn": "0"}
- ISCD=0001: rt_cd=0 msg=정상처리 되었습니다. · 1행
  {"frgn_ntby_qty": "0", "frgn_ntby_tr_pbmn": "0", "prsn_ntby_tr_pbmn": "0", "orgn_ntby_tr_pbmn": "0"}
- ISCD=2001: rt_cd=0 msg=정상처리 되었습니다. · 1행
  {"frgn_ntby_qty": "0", "frgn_ntby_tr_pbmn": "0", "prsn_ntby_tr_pbmn": "0", "orgn_ntby_tr_pbmn": "0"}

## 국내선물옵션 경로 후보(투자자·시세)
- inquire-price(FHMIF10000000): rt_cd=0 msg=정상처리 되었습니다. · 블록 ['output2', 'output3']
  [output2] 1행 키: bstp_cls_code, hts_kor_isnm, bstp_nmix_prpr, prdy_vrss_sign, bstp_nmix_prdy_vrss, bstp_nmix_prdy_ctrt
  [output3] 1행 키: bstp_cls_code, hts_kor_isnm, bstp_nmix_prpr, prdy_vrss_sign, bstp_nmix_prdy_vrss, bstp_nmix_prdy_ctrt
- inquire-daily-fuopchartprice(FHKIF03020100): rt_cd=0 msg=정상처리 되었습니다. · 블록 ['output2']
  [output2] 69행 키: stck_bsop_date, futs_prpr, futs_oprc, futs_hgpr, futs_lwpr, acml_vol, acml_tr_pbmn, mod_yn
- investor-trend(FHKIF10010000): rt_cd=None msg=Expecting value: line 1 column 1 (char 0) · 블록 []
- inquire-investor(FHPTJ04030000): rt_cd=None msg=Expecting value: line 1 column 1 (char 0) · 블록 []