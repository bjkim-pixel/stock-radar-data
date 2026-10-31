# 글로벌 시황 수집 리포트 (2026-10-31 10:54 KST)
- stocks 테이블 ETF 997개에서 이름 매핑
  - stocks에 없는 1개 → KIS 종목 마스터 2584개로 보완
- Yahoo: 성공 57/57 · upsert 2344행
- ⚠ Yahoo crumb 실패: HTTP 429
  - [대체소스 진단] XLK: HTTP 200 · 길이 98702 · 파싱 25행 · 앞 3행 [('NVDA', 'NVIDIA Corporation', 14.98), ('AAPL', 'Apple Inc.', 14.75), ('MSFT', 'Microsoft Corporation', 11.41)]
- 미국 ETF 보유종목: 성공 41/41 · 종목 등락률 164개
- 신용융자·반대매매: 조회 56행 → 저장 196값 · 최신일 2026-10-29
- 한국 ETF 시세: 성공 29/33 · upsert 983행
  - ⚠ 실패: 228800(rt_cd=9 SESSION FULL), 434730(rt_cd=9 SESSION FULL), 457990(rt_cd=9 SESSION FULL), 461950(rt_cd=9 SESSION FULL)
- 한국 ETF 시가총액: 성공 28/33
  - ⚠ 실패: 0090B0(rt_cd=9 SESSION FULL), 0168K0(rt_cd=9 SESSION FULL), 091220(rt_cd=9 SESSION FULL), 364990(rt_cd=9 SESSION FULL), 487240(rt_cd=9 SESSION FULL)
- 한국 ETF 보유종목: 성공 31/33
  - ⚠ 실패: 0239Z0(rt_cd=9 SESSION FULL), 466920(rt_cd=9 SESSION FULL)
- KOSPI 2026-10-30 상승 234 / 하락 656
- KOSDAQ 2026-10-30 상승 266 / 하락 1406
- pack US: 기준일 2026-10-30 · 항목 58개 · 122KB
- pack KR: 기준일 2026-10-30 · 항목 47개 · 108KB

## 티커별 저장 현황
| symbol | rows | first | last | yahoo name |
|---|---|---|---|---|
| CR:CREDIT_KOSDAQ | 283 | 2025-09-01 | 2026-10-29 |  |
| CR:CREDIT_KOSPI | 283 | 2025-09-01 | 2026-10-29 |  |
| CR:CREDIT_TOTAL | 283 | 2025-09-01 | 2026-10-29 |  |
| CR:FORCED_AMT | 283 | 2025-09-01 | 2026-10-29 |  |
| CR:FORCED_PCT | 283 | 2025-09-01 | 2026-10-29 |  |
| CR:SHORT_LOAN | 283 | 2025-09-01 | 2026-10-29 |  |
| CR:UNPAID | 283 | 2025-09-01 | 2026-10-29 |  |
| FX:KRW | 311 | 2025-08-20 | 2026-10-30 |  |
| KR:0090B0 | 287 | 2025-08-26 | 2026-10-30 |  |
| KR:011150 | 284 | 2025-08-22 | 2026-10-23 |  |
| KR:0148J0 | 200 | 2026-01-06 | 2026-10-30 |  |
| KR:0168K0 | 154 | 2026-03-17 | 2026-10-30 |  |
| KR:0207G0 | 93 | 2026-06-16 | 2026-10-30 |  |
| KR:0209D0 | 88 | 2026-06-23 | 2026-10-30 |  |
| KR:0219B0 | 73 | 2026-07-14 | 2026-10-30 |  |
| KR:0239Z0 | 30 | 2026-09-15 | 2026-10-30 |  |
| KR:091160 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:091220 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:117700 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:139270 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:157500 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:228790 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:228800 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:228810 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:229200 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:364970 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:364990 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:367760 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:395150 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:404120 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:421320 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:434730 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:438900 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:445290 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:449450 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:457990 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:461950 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:466920 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:475050 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:475300 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:475310 | 289 | 2025-08-22 | 2026-10-30 |  |
| KR:487240 | 289 | 2025-08-22 | 2026-10-30 |  |
| KRB:KOSDAQ_ADV | 6 | 2026-10-23 | 2026-10-30 |  |
| KRB:KOSDAQ_DEC | 6 | 2026-10-23 | 2026-10-30 |  |
| KRB:KOSPI_ADV | 6 | 2026-10-23 | 2026-10-30 |  |
| KRB:KOSPI_DEC | 6 | 2026-10-23 | 2026-10-30 |  |
| KRM:0090B0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:0148J0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:0168K0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:0207G0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:0209D0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:0219B0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:0239Z0 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:091160 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:091220 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:117700 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:139270 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:157500 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:228790 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:228800 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:228810 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:229200 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:364970 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:364990 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:367760 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:395150 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:404120 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:421320 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:434730 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:438900 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:445290 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:449450 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:457990 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:461950 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:466920 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:475050 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:475300 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:475310 | 7 | 2026-10-25 | 2026-10-31 |  |
| KRM:487240 | 7 | 2026-10-25 | 2026-10-31 |  |
| US:AIS | 302 | 2025-08-20 | 2026-10-30 | VistaShares Artificial Intelligence Supercycle ETF |
| US:ARKG | 302 | 2025-08-20 | 2026-10-30 | ARK Genomic Revolution ETF |
| US:BIZD | 302 | 2025-08-20 | 2026-10-30 | VanEck BDC Income ETF |
| US:BOAT | 302 | 2025-08-20 | 2026-10-30 | SonicShares Global Shipping ETF |
| US:BUG | 302 | 2025-08-20 | 2026-10-30 | Global X Cybersecurity ETF |
| US:CAPA | 47 | 2026-08-26 | 2026-10-30 | Defiance AI Capacitors & MLCC ETF |
| US:CPER | 302 | 2025-08-20 | 2026-10-30 | United States Copper Index Fund, LP |
| US:DRAM | 147 | 2026-04-02 | 2026-10-30 | Roundhill Memory ETF |
| US:DRNZ | 253 | 2025-10-29 | 2026-10-30 | REX Drone ETF |
| US:FXY | 302 | 2025-08-20 | 2026-10-30 | Invesco CurrencyShares Japanese Yen Trust |
| US:GASZ | 124 | 2026-05-06 | 2026-10-30 | Corgi Natural Gas Power & Turbines ETF |
| US:GLD | 302 | 2025-08-20 | 2026-10-30 | SPDR Gold Shares |
| US:HUMN | 302 | 2025-08-20 | 2026-10-30 | Roundhill Humanoid Robotics ETF |
| US:HYDR | 302 | 2025-08-20 | 2026-10-30 | Global X Hydrogen ETF |
| US:IBIT | 302 | 2025-08-20 | 2026-10-30 | iShares Bitcoin Trust ETF |
| US:IGV | 302 | 2025-08-20 | 2026-10-30 | iShares Expanded Tech-Software Sector ETF |
| US:IWC | 302 | 2025-08-20 | 2026-10-30 | iShares Micro-Cap ETF |
| US:IWM | 302 | 2025-08-20 | 2026-10-30 | iShares Russell 2000 ETF |
| US:KWEB | 302 | 2025-08-20 | 2026-10-30 | KraneShares CSI China Internet ETF |
| US:LIT | 302 | 2025-08-20 | 2026-10-30 | Global X Lithium & Battery Tech ETF |
| US:LYTE | 61 | 2026-08-06 | 2026-10-30 | Roundhill Photonics & Optics ETF |
| US:MAGS | 302 | 2025-08-20 | 2026-10-30 | Roundhill Magnificent Seven ETF |
| US:NASA | 149 | 2026-03-31 | 2026-10-30 | Tema Space Innovators ETF |
| US:NCLD | 61 | 2026-08-06 | 2026-10-30 | Roundhill Neocloud ETF |
| US:NUKZ | 302 | 2025-08-20 | 2026-10-30 | Range Nuclear Renaissance ETF |
| US:OZEM | 302 | 2025-08-20 | 2026-10-30 | Roundhill Glp-1 & Weight Loss ETF |
| US:PHO | 302 | 2025-08-20 | 2026-10-30 | Invesco Water Resources ETF |
| US:QQQ | 302 | 2025-08-20 | 2026-10-30 | Invesco QQQ Trust |
| US:QTUP | 101 | 2026-06-09 | 2026-10-30 | Defiance Pure Quantum ETF |
| US:RACK | 106 | 2026-06-02 | 2026-10-30 | Vaneck Data Center Supply Chain ETF |
| US:SHLD | 302 | 2025-08-20 | 2026-10-30 | Global X Defense Tech ETF |
| US:SKYY | 302 | 2025-08-20 | 2026-10-30 | First Trust Cloud Computing ETF |
| US:SOXX | 302 | 2025-08-20 | 2026-10-30 | iShares Semiconductor ETF |
| US:SPY | 302 | 2025-08-20 | 2026-10-30 | State Street SPDR S&P 500 ETF Trust |
| US:STBQ | 215 | 2025-12-23 | 2026-10-30 | Amplify Stablecoin Technology Leaders ETF |
| US:TAN | 302 | 2025-08-20 | 2026-10-30 | Invesco Solar ETF |
| US:TBX | 302 | 2025-08-20 | 2026-10-30 | ProShares Short 7-10 Year Treasury |
| US:USO | 302 | 2025-08-20 | 2026-10-30 | United States Oil Fund, LP |
| US:UUP | 302 | 2025-08-20 | 2026-10-30 | Invesco DB US Dollar Index Bullish Fund |
| US:VOLT | 302 | 2025-08-20 | 2026-10-30 | Tema Electrification ETF |
| US:XLB | 302 | 2025-08-20 | 2026-10-30 | State Street Materials Select Sector SPDR ETF |
| US:XLC | 302 | 2025-08-20 | 2026-10-30 | State Street Communication Services Select Sector SPDR ETF |
| US:XLE | 302 | 2025-08-20 | 2026-10-30 | State Street Energy Select Sector SPDR ETF |
| US:XLF | 302 | 2025-08-20 | 2026-10-30 | State Street Financial Select Sector SPDR ETF |
| US:XLI | 302 | 2025-08-20 | 2026-10-30 | State Street Industrial Select Sector SPDR ETF |
| US:XLK | 302 | 2025-08-20 | 2026-10-30 | State Street Technology Select Sector SPDR ETF |
| US:XLP | 302 | 2025-08-20 | 2026-10-30 | State Street Consumer Staples Select Sector SPDR ETF |
| US:XLRE | 302 | 2025-08-20 | 2026-10-30 | State Street Real Estate Select Sector SPDR ETF |
| US:XLU | 302 | 2025-08-20 | 2026-10-30 | State Street Utilities Select Sector SPDR ETF |
| US:XLV | 302 | 2025-08-20 | 2026-10-30 | State Street Health Care Select Sector SPDR ETF |
| US:XLY | 302 | 2025-08-20 | 2026-10-30 | State Street Consumer Discretionary Select Sector SPDR ETF |
| US:ZAP | 302 | 2025-08-20 | 2026-10-30 | Global X U.S. Electrification ETF |
| US:^GSPC | 302 | 2025-08-20 | 2026-10-30 | S&P 500 |
| US:^IXIC | 302 | 2025-08-20 | 2026-10-30 | NASDAQ Composite |
| US:^TNX | 302 | 2025-08-20 | 2026-10-30 | CBOE Interest Rate 10 Year T Note |
| US:^VIX | 304 | 2025-08-20 | 2026-10-30 | CBOE Volatility Index |

## 한국 매핑 (테마 · ETF → 코드 · 시총 억원)
- [반도체] KODEX 반도체 → 091160 · 시총 46038.0
- [반도체] SOL 반도체전공정 → 475300 · 시총 3063.0
- [반도체] SOL 반도체후공정 → 475310 · 시총 1556.0
- [반도체] PLUS AI반도체소부장액티브 → 0239Z0 · 시총 493.0
- [AI전력·네트워크] KODEX AI전력핵심설비 → 487240 · 시총 22331.0
- [AI전력·네트워크] RISE 네트워크인프라 → 367760 · 시총 5261.0
- [우주항공·위성] PLUS 우주항공 → 421320 · 시총 1247.0
- [우주항공·위성] SOL 우주항공밸류체인 → 0207G0 · 시총 443.0
- [우주항공·위성] KoAct 광통신&위성네트워크액티브 → 0219B0 · 시총 93.0
- [K방산] PLUS K방산 → 449450 · 시총 6649.0
- [K방산] PLUS K방산소부장 → 0090B0 · 시총 108.0
- [조선] SOL 조선TOP3플러스 → 466920 · 시총 9385.0
- [원자력] HANARO 원자력iSelect → 434730 · 시총 4545.0
- [신재생에너지] TIME K신재생에너지액티브 → 404120 · 시총 160.0
- [신재생에너지] PLUS 태양광&ESS → 457990 · 시총 1690.0
- [2차전지] KODEX 2차전지핵심소재10 → 461950 · 시총 1541.0
- [2차전지] KODEX 전고체배터리ESS TOP2플러스 → 0209D0 · 시총 3370.0
- [로봇] KODEX 로봇액티브 → 445290 · 시총 8955.0
- [로봇] TIGER 코리아휴머노이드로봇산업 → 0148J0 · 시총 5404.0
- [바이오] TIGER 바이오TOP10 → 364970 · 시총 2485.0
- [바이오] TIGER 기술이전바이오액티브 → 0168K0 · 시총 1006.0
- [금융] TIGER 증권 → 157500 · 시총 1623.0
- [금융] TIGER 은행 → 091220 · 시총 165.0
- [금융] TIGER 200 금융 → 139270 · 시총 266.0
- [건설] KODEX 건설 → 117700 · 시총 1852.0
- [K-컬처·콘텐츠] ACE KPOP포커스 → 475050 · 시총 1023.0
- [K-컬처·콘텐츠] KODEX 웹툰&드라마 → 395150 · 시총 84.0
- [K-컬처·콘텐츠] TIGER 미디어컨텐츠 → 228810 · 시총 718.0
- [K-컬처·콘텐츠] TIGER 게임TOP10 → 364990 · 시총 191.0
- [K-소비] TIGER 화장품 → 228790 · 시총 1949.0
- [K-소비] HANARO Fn K-푸드 → 438900 · 시총 136.0
- [K-소비] TIGER 여행레저 → 228800 · 시총 610.0
- [코스닥150] KODEX 코스닥150 → 229200 · 시총 41101.0

완료 (299초)
