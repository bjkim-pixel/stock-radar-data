
# 코스맥스 192820
사내이사(등기): ['이경수', '최경', '이병만']
elestock status 000 정상 행 15
키: ['rcept_no', 'rcept_dt', 'corp_code', 'corp_name', 'repror', 'isu_exctv_rgist_at', 'isu_exctv_ofcps', 'isu_main_shrholdr', 'sp_stock_lmp_cnt', 'sp_stock_lmp_irds_cnt', 'sp_stock_lmp_rate', 'sp_stock_lmp_irds_rate']
   이경수 → None
   최경 → None
   이병만 → None
  (소유보고서에 있는 전체 보고자 수: 7 )
   hyslr 코스맥스비티아이 최대주주 3,090,301 27.23
   hyslr 이경수 임원 118 0.00
   hyslr 이병만 임원 69 0.00
   hyslr 최경 임원 22,000 0.19
   hyslr 이영하 계열회사임원 1,661 0.01
   hyslr 정민경 계열회사임원 1,283 0.01
   hyslr 이상인 계열회사임원 6,340 0.06
   hyslr 양치연 계열회사임원 1 0.00
Traceback (most recent call last):
  File "/home/runner/work/stock-radar-data/stock-radar-data/136_board_probe.py", line 28, in <module>
    if h.get("stock_knd")=="보통주": print("   hyslr",h["nm"],h["relate"],h["trmend_posesn_stock_co"],h["trmend_posesn_stock_qota_rt"])
                                                              ~^^^^^^^^^^
KeyError: 'relate'
