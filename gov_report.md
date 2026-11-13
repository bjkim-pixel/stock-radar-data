# 지배구조 수집 결과
- 종목 417 · 신규/갱신 130 · 동일 보고서 건너뜀 281 · 정기보고서 없음 4 · corp_code 없음 2 · API 1471회 · 1800초
- gov_board: (1239, 402)
- gov_owner: (4850, 411)
- gov_major: (810, 401)
- gov_summary: (411, 411)

## 코스맥스 이사회
```
('이경수', '회장', '사내이사', '상근', 118, Decimal('0.0'))
('이병만', '대표이사 부회장', '사내이사', '상근', 69, Decimal('0.0'))
('최 경', '대표이사 부회장', '사내이사', '상근', 22000, Decimal('0.19'))
```

## 코스맥스 주주
```
('계', None, '보통주', 3121773, Decimal('27.51'), False)
('코스맥스비티아이', '최대주주', '보통주', 3090301, Decimal('27.23'), True)
('최경', '임원', '보통주', 22000, Decimal('0.19'), False)
('이상인', '계열회사임원', '보통주', 6340, Decimal('0.06'), False)
('이영하', '계열회사임원', '보통주', 1661, Decimal('0.01'), False)
('정민경', '계열회사임원', '보통주', 1283, Decimal('0.01'), False)
('이경수', '임원', '보통주', 118, Decimal('0.0'), False)
('이병만', '임원', '보통주', 69, Decimal('0.0'), False)
('양치연', '계열회사임원', '보통주', 1, Decimal('0.0'), False)
('계', None, '우선주', None, None, False)
('계', None, '기  타', None, None, False)
```

## 요약
```
('005930', '20260814003699', datetime.date(2026, 6, 30), '20260814003699', 7971242, Decimal('99.99'), Decimal('66.24'), 5846278608, 82086705, Decimal('1.4040847264390244'), datetime.datetime(2026, 11, 9, 3, 19, 49, 832708, tzinfo=datetime.timezone.utc))
('192820', '20261113001208', datetime.date(2026, 9, 30), '20261113001208', 44078, Decimal('99.98'), Decimal('53.7'), 11345662, None, None, datetime.datetime(2026, 11, 13, 19, 58, 35, 780275, tzinfo=datetime.timezone.utc))
```

## 5% 보유자
```
('005930', '삼성물산', Decimal('19.69'), datetime.date(2026, 10, 30))
('192820', '코스맥스비티아이', Decimal('27.51'), datetime.date(2025, 7, 3))
('192820', '국민연금공단', Decimal('12.85'), datetime.date(2026, 7, 1))
('192820', 'NorgesBank', Decimal('5.06'), datetime.date(2026, 11, 5))
```

## 원본 샘플
```
{
 "192820": {
  "hyslr": [
   {
    "rcept_no": "20261113001208",
    "corp_cls": "Y",
    "corp_code": "01009789",
    "corp_name": "코스맥스",
    "stock_knd": "보통주",
    "nm": "코스맥스비티아이",
    "relate": "최대주주",
    "bsis_posesn_stock_co": "3,090,301",
    "bsis_posesn_stock_qota_rt": "27.23",
    "trmend_posesn_stock_co": "3,090,301",
    "trmend_posesn_stock_qota_rt": "27.23",
    "rm": "-",
    "stlm_dt": "2026-09-30"
   },
   {
    "rcept_no": "20261113001208",
    "corp_cls": "Y",
    "corp_code": "01009789",
    "corp_name": "코스맥스",
    "stock_knd": "보통주",
    "nm": "이경수",
    "relate": "임원",
    "bsis_posesn_stock_co": "118",
    "bsis_posesn_stock_qota_rt": "0.00",
    "trmend_posesn_stock_co": "118",
    "trmend_posesn_stock_qota_rt": "0.00",
    "rm": "-",
    "stlm_dt": "2026-09-30"
   },
   {
    "rcept_no": "20261113001208",
    "corp_cls": "Y",
    "corp_code": "01009789",
    "corp_name": "코스맥스",
    "stock_knd": "보통주",
    "nm": "이병만",
    "relate": "임원",
    "bsis_posesn_stock_co": "69",
    "bsis_posesn_stock_qota_rt": "0.00",
    "trmend_posesn_stock_co": "69",
    "trmend_posesn_stock_qota_rt": "0.00",
    "rm": "-",
    "stlm_dt": "2026-09-30"
   }
  ],
  "mrhl": [
   {
    "rcept_no": "20261113001208",
    "corp_cls": "Y",
    "corp_code": "01009789",
    "corp_name": "코스맥스",
    "se": "소액주주",
    "shrholdr_co": "44,078",
    "shrholdr_tot_co": "44,092",
    "shrholdr_rate": "99.98%",
    "hold_stock_co": "6,092,180",
    "stock_tot_co": "11,345,662",
    "hold_stock_rate": "53.70%",
    "stlm_dt": "2026-09-30"
   }
  ],
  "tesstk": [
   {
    "rcept_no": "20261113001208",
    "corp_cls": "Y",
    "corp_code": "01009789",
    "corp_name": "코스맥스",
    "stock_knd": "-",
    "acqs_mth1": "-",
    "acqs_mth2": "-",
    "acqs_mth3": "-",
    "bsis_qy": "-",
    "change_qy_acqs": "-",
    "change_qy_dsps": "-",
    "change_qy_incnr": "-",
    "trmend_qy": "-",
    "rm": "-",
    "stlm_dt": "2026-09-30"
   }
  ]
 }
}
```
