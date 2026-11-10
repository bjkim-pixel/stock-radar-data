# A. DB market_investor_daily 일수
('FUT', 3, datetime.date(2026, 11, 5), datetime.date(2026, 11, 9))
('KOSDAQ', 3, datetime.date(2026, 11, 5), datetime.date(2026, 11, 9))
('KOSPI', 3, datetime.date(2026, 11, 5), datetime.date(2026, 11, 9))

# B. 네이버 m.stock trend 원본/파라미터
200 /api/index/FUT/trend {"bizdate":"20261110","personalValue":"+723","foreignValue":"+1,604","institutionalValue":"-2,072"}
200 /api/index/FUT/trend?bizdate=20261102 {"bizdate":"20261102","personalValue":"-1,194","foreignValue":"+3,408","institutionalValue":"-1,878"}
200 /api/index/FUT/trend?page=2&pageSize=20 {"bizdate":"20261110","personalValue":"+723","foreignValue":"+1,604","institutionalValue":"-2,072"}
200 /api/index/KOSPI/trend?bizdate=20261102 {"bizdate":"20261102","personalValue":"-13,303","foreignValue":"-3,845","institutionalValue":"+12,257"}
404 /api/index/FUT/investor 
404 /api/index/FUT/investorTrend 
200 /api/index/KOSPI200/trend 
404 /api/index/FUT/trend/daily 

# C. 네이버 금융 PC 페이지(일자별)
410 /sise/investorDealTrendDay.naver?bizdate=20261109&sosok=01 1499  Npay 증권 일자별 순매수 (단위:억원) 일자별 순매수 날짜 개인 외국인 기관계 기관 기타법인 금융투자 보험 투신 (사모) 은행 기타금융기관 연기금등 이 페이지는 더 이상 제공되지 않습니다. Npay 증권 바로가기 
410 /sise/investorDealTrendDay.naver?bizdate=20261109&sosok=03 1499  Npay 증권 일자별 순매수 (단위:계약) 일자별 순매수 날짜 개인 외국인 기관계 기관 기타법인 금융투자 보험 투신 (사모) 은행 기타금융기관 연기금등 이 페이지는 더 이상 제공되지 않습니다. Npay 증권 바로가기 
410 /sise/investorDealTrendDay.naver?bizdate=20261109&sosok=04 1499  Npay 증권 일자별 순매수 (단위:억원) 일자별 순매수 날짜 개인 외국인 기관계 기관 기타법인 금융투자 보험 투신 (사모) 은행 기타금융기관 연기금등 이 페이지는 더 이상 제공되지 않습니다. Npay 증권 바로가기 
404 /sise/sise_investor_futures.naver 2590  네이버 :: 세상의 모든 지식, 네이버 .error_content * {margin:0;padding:0;} .error_content img{border:none;} .error_content em {font-style:normal;} .error_content {width:410px; margin:80px auto 0; padding:57px 0 0 0; font-size:12px; font-family:"나눔고딕", "NanumGothic", "돋움", Dotum, AppleGothic, Sans-serif; text-align:left; line-height:14px; background:url(https://ssl.pstatic.net/static/common/error/090610/bg_thumb.gif) no-repeat center top; white-space:nowrap;} .error_content p{margin:0;} .error_content .error_
410 /sise/investorDealTrendTime.naver?bizdate=20261109&sosok=03 1496  Npay 증권 시간별 순매수 (단위:계약) 시간별 순매수 시간 개인 외국인 기관계 기관 기타법인 금융투자 보험 투신 (사모) 은행 기타금융기관 연기금등 이 페이지는 더 이상 제공되지 않습니다. Npay 증권 바로가기 
