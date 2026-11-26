'use strict';
/* 자동매매 컨트롤 타워 A단계(2026-11-15) — 전략 = 엔진 유형(intraday 장중매매 | closing 종가베팅) + 조건값(params)
   · SCHEMA 하나가 기본값·조정 범위·검증·화면 표시(라벨·묶음·설명)의 기준. 서버 검증과 사이트 편집 화면이 같은 정의를 쓴다
   · 기본값 = 1~3단계에서 확정해 코드에 박혀 있던 값 그대로 → 기본 전략으로 돌리면 지금과 같은 동작
   · 저장할 때마다 버전을 올리고(auto_strategy_versions) 바뀐 항목을 남긴다
   · 테이블이 아직 없으면(165 SQL 실행 전) 기본 전략 2개를 메모리에서 써서 기존처럼 동작한다 */

const tmin = s => { const m = /^(\d{2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : NaN; };
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const ENUM = {
  flow: { req: '필수', bonus: '가점만', ignore: '무시' },
  smx: { cont_stall: '매집 지속·정체', cont: '매집 지속만', off: '보지 않음' },
  smxWin: { '21': '1개월', '63': '3개월', '126': '6개월', all: '전체' },   // 2026-11-19: 매집 진단을 보는 기간(smx_state.win) — 기본 6개월
  buyType: { limit: '지정가(호가에 걸고 기다림)', market: '시장가(바로 체결)' },
  buyPick: { q1: '잔량 최다 매수 호가', bid1: '최우선 매수 호가', low: '가장 낮은 매수 호가' },
  eodWeak: { ask: '알림 후 승인 시에만 정리', keep: '묻지 않고 유지' },
  approval: { manual: '텔레그램 승인 필수', auto: '알림 후 자동 매수' },
  cbApproval: { auto: '알림 직후 자동 매수', manual: '텔레그램·사이트 승인 필수' },
  holdMode: { both: '시가·현재가 모두 매수가보다 낮을 때', price: '현재가만 매수가보다 낮을 때' },
  carryFlow: { any: '외국인·기관 중 하나', both: '외국인·기관 둘 다', ignore: '보지 않음' },
  regimeMode: { info: '표시만', scale: '종목당 금액 조절' },
  repriceTo: { bid1: '최우선 매수 호가', ask1: '최우선 매도 호가(바로 체결)', none: '정정하지 않음' },
  tpStyle: { r: '새 방식(+1R·중간·목표 25/25/50 + 러너)',
  fixed: '고정 % 단계(예: +6%·+9%에서 나눠 팔기)', even: '예전 방식(목표까지 균등 분할)' },
  unfilledEnd: { cancel: '취소', keep: '장 마감까지 유지' },
  execMode: { paper: '가상(가상 엔진으로 주문)', dryrun: '드라이런(실제 계좌로 금액·점검만, 주문은 가상)', live: '실전(실제 계좌로 주문)' },
  selector: { flow: '수급 돌파(외국인·기관·프로그램 + 체결강도)', ignite: '장초 상승 포착(거래 붙으며 오르기 시작하는 종목)', pullback: '눌림목(3개월 내 무게 1·2위일 평균가 아래로 빠진 뒤 스마트머니 유지 확인 → 평균가 돌파 매수)', inverse: '인버스·사이드카(지수 ETF 매매: 하락 국면 보유 · 외국인 동반 순매도 · 매도 사이드카 반등)' },
  invMode: { regime: 'A 하락 국면 보유(코스피200 < 60일선이면 보유)', flow: 'B 외국인 현물·선물 동반 순매도 다음날 장중 매수', sidecar: 'C 매도 사이드카 반등 매수(이틀째 정리)' },
  invCode: { '114800': 'KODEX 인버스(1X)', '252670': 'KODEX 200선물인버스2X', '251340': 'KODEX 코스닥150선물인버스', '0197X0': 'SOL SK하이닉스단일종목인버스2X', '069500': 'KODEX 200(1X)', '122630': 'KODEX 레버리지(2X)', '494310': 'KODEX 반도체레버리지(2X)' },
  sizeMode: { fixed: '고정(종목당 금액)', balance: '계좌 잔고 기준 자동' },
};

/* type: num | time | times | bool | enum | weights. group 순서 = 화면 순서 */
const F = (key, group, label, type, def, more = {}) => ({ key, group, label, type, def, ...more });
const SCHEMA = {
  intraday: [
    F('selectAt', '적용 시간', '후보 선정 시각(눌림목은 종가 매수라 15:10)', 'time', '10:05', { min: '09:10', max: '15:10' }),
    F('noticeAfter', '적용 시간', '선정 후 알림까지', 'num', 10, { min: 0, max: 30, step: 1, unit: '분' }),
    F('approveWindow', '적용 시간', '알림 후 승인 마감까지', 'num', 15, { min: 5, max: 60, step: 1, unit: '분' }),
    F('roundMin', '적용 시간', '장중 반복 검토 간격(0=반복 안 함)', 'num', 30, { min: 0, max: 120, step: 5, unit: '분' }),
    F('roundEnd', '적용 시간', '마지막 검토 시각', 'time', '14:30', { min: '10:30', max: '15:00' }),
    F('selector', '선정 방식', '후보를 고르는 방식(아래 \'장초 상승 포착\'·\'눌림목\' 묶음은 이 방식을 고른 전략에서만 적용)', 'enum', 'flow', { opts: ENUM.selector }),
    F('capMaxEok', '대상', '시가총액 상한(0=상한 없음 · 장초 상승 포착에서 큰 대형주 제외용)', 'num', 0, { min: 0, max: 1000000, step: 1000, unit: '억원' }),
    F('capMinEok', '대상', '시가총액 하한', 'num', 10000, { min: 1000, max: 100000, step: 1000, unit: '억원' }),
    F('amtMinEok', '대상', '거래대금 하한(실시간 종목의 거래대금 조건 · 0=끔)', 'num', 100, { min: 0, max: 5000, step: 10, unit: '억원' }),
    F('maTrend', '대상', '종가 > 60일선 > 120일선', 'bool', true),
    F('smx', '대상', '스마트머니 상태', 'enum', 'cont_stall', { opts: ENUM.smx }),
    F('smxWin', '대상', '스마트머니 진단 기간(위 상태를 볼 기간)', 'enum', '126', { opts: ENUM.smxWin }),
    F('flowForeign', '매수 조건', '외국인 순매수', 'enum', 'req', { opts: ENUM.flow }),
    F('flowInst', '매수 조건', '기관 순매수', 'enum', 'req', { opts: ENUM.flow }),
    F('flowProgram', '매수 조건', '프로그램 순매수', 'enum', 'req', { opts: ENUM.flow }),
    F('altFlowOn', '대체 후보(수급 보충)', '통과 종목이 없을 때 외국인+기관 합계로 보충', 'bool', true),
    F('altFlowMinEok', '대체 후보(수급 보충)', '외국인+기관 순매수 합계 하한', 'num', 1, { min: 0.1, max: 50, step: 0.1, unit: '억원' }),
    F('altAutoBuy', '대체 후보(수급 보충)', '승인이 없어도 다음 검토에도 후보면 자동 매수', 'bool', true),
    F('kwOn', '매수 조건', '개인 계좌수(8월 기준) 확인', 'bool', true),
    F('kwMax', '매수 조건', '개인 계좌수 비율 상한(8월=100%, 넘으면 승인 후에만 매수)', 'num', 100, { min: 50, max: 300, step: 5, unit: '%' }),
    F('cttrMin', '매수 조건', '체결강도 하한', 'num', 100, { min: 80, max: 200, step: 1, unit: '%' }),
    F('openRiseMax', '매수 조건', '시가 대비 상승률 상한', 'num', 8, { min: 2, max: 15, step: 0.5, unit: '%' }),
    F('poolTop', '후보 수', '점수 상위 후보 수', 'num', 10, { min: 1, max: 20, step: 1, unit: '개' }),
    F('notifyTop', '후보 수', '알림에 싣는 수', 'num', 5, { min: 1, max: 10, step: 1, unit: '개' }),
    F('sectorMax', '후보 수', '같은 업종 최대', 'num', 2, { min: 1, max: 5, step: 1, unit: '개' }),
    F('gapMaxPct', '장초 상승 포착', '갭 상한(시가 ÷ 전일 종가 − 1)', 'num', 3, { min: 0, max: 10, step: 0.5, unit: '%' }),
    F('chgMaxPct', '장초 상승 포착', '등락률 상한(이 이상은 이미 과열이라 제외)', 'num', 12, { min: 3, max: 25, step: 0.5, unit: '%' }),
    F('openRiseMin', '장초 상승 포착', '시가 대비 상승 하한', 'num', 2, { min: 0, max: 8, step: 0.5, unit: '%' }),
    F('riseWinMin', '장초 상승 포착', '"오르기 시작" 판단 구간', 'num', 10, { min: 5, max: 30, step: 5, unit: '분' }),
    F('riseMinPct', '장초 상승 포착', '그 구간 최소 상승', 'num', 0.8, { min: 0.2, max: 5, step: 0.1, unit: '%' }),
    F('amtSurge', '장초 상승 포착', '분당 거래대금: 그 전(09:00~) 평균 대비 배수', 'num', 2, { min: 1, max: 10, step: 0.5, unit: '배' }),
    F('minMinAmtKrw', '장초 상승 포착', '최근 분당 거래대금 하한', 'num', 30000000, { min: 5000000, max: 1000000000, step: 5000000, unit: '원' }),
    F('pullbackMaxPct', '장초 상승 포착', '보조: 당일 고가 대비 눌림 허용', 'num', 1.5, { min: 0.5, max: 5, step: 0.5, unit: '%' }),
    F('optMin', '장초 상승 포착', '보조 조건(VWAP 위·고가 근처·체결강도·프로그램) 최소 충족 수', 'num', 2, { min: 0, max: 4, step: 1, unit: '개' }),
    F('flatOn', '장초 상승 포착', '당일 청산(지정 시각에 남은 보유분 전량 시장가 매도)', 'bool', false),
    F('flatAt', '장초 상승 포착', '당일 청산 시각', 'time', '15:14', { min: '14:30', max: '15:19' }),
    F('pbWMin', '눌림목', '관찰 대상: 무게/주식수 1·2위일의 무게 하한(0.1 = 10%) — 이보다 약한 날은 제외', 'num', 0.1, { min: 0.05, max: 1, step: 0.05, unit: '' }),
    F('pbMaxAge', '눌림목', '1·2위일 이후 기다리는 최대 거래일(63 ≈ 3개월, 넘으면 관찰 종료)', 'num', 63, { min: 10, max: 90, step: 1, unit: '일' }),
    F('pbDipPct', '눌림목', '눌림 인정: 종가가 1·2위일 평균가 아래로 이 % 이상 내려간 적이 있어야 함', 'num', 2, { min: 0, max: 10, step: 0.5, unit: '%' }),
    F('pbBreakPct', '눌림목', '매수: 현재가가 평균가를 이 % 이상 완전히 돌파했을 때(15:10)', 'num', 1, { min: 0, max: 5, step: 0.5, unit: '%' }),
    F('pbChasePct', '눌림목', '쫓지 않기: 평균가 위로 이 % 넘게 이미 올랐으면 제외', 'num', 6, { min: 2, max: 15, step: 0.5, unit: '%' }),
    F('pbSmGate', '눌림목', '스마트머니 점검: 1개월·3개월 모두 매집 지속/정체이고 주도 세력이 팔고 있지 않을 때만(끄면 상관없음)', 'bool', true),
    F('pbStopBelowPct', '눌림목', '손절: 매수가 아래 이 % 밑에서 종가 마감(15:15 이후 판단)', 'num', 5, { min: 2, max: 10, step: 0.5, unit: '%' }),
    F('pbHoldDays', '눌림목', '시간 청산: 매수 후 이 거래일째 15:05 에 남은 수량 전량 매도', 'num', 10, { min: 2, max: 30, step: 1, unit: '일' }),
    F('invMode', '인버스·사이드카', '전략 종류(A·B·C)', 'enum', 'regime', { opts: ENUM.invMode }),
    F('invCode', '인버스·사이드카', '매매할 ETF', 'enum', '114800', { opts: ENUM.invCode }),
    F('invMaDays', '인버스·사이드카', '하락 국면 기준: 코스피200이 이 일수 이동평균선 아래(A·C)', 'num', 60, { min: 20, max: 120, step: 5, unit: '일' }),
    F('invDropPct', '인버스·사이드카', 'C 사이드카 대리 신호: KODEX 200 이 이만큼 이상 하락(발동 기록이 없을 때)', 'num', 4, { min: 2, max: 8, step: 0.5, unit: '%' }),
    F('invHoldDays', '인버스·사이드카', 'C 보유 거래일(하락 국면이면 1일로 줄임) — 이 일수째 15:15 에 정리', 'num', 2, { min: 1, max: 5, step: 1, unit: '일' }),
    F('weights', '점수', '배점(합계 100)', 'weights', { flow: 35, cttr: 15, rise: 15, amt: 15, trend: 10, kw: 10 }, { parts: { flow: '수급', cttr: '체결강도', rise: '상승률', amt: '거래대금', trend: '추세', kw: '개인 물량 감소' } }),
    F('maxBuys', '매수 주문', '하루 최대 매수 종목 수', 'num', 5, { min: 1, max: 20, step: 1, unit: '종목' }),
    F('retryUnfilled', '매수 주문', '다음 검토 때 못 산 종목 다시 시도', 'bool', true),
    F('maxTries', '매수 주문', '종목당 하루 최대 주문 시도', 'num', 3, { min: 1, max: 6, step: 1, unit: '번' }),
    F('perStockKrw', '매수 주문', '종목당 금액', 'num', 1000000, { min: 100000, max: 50000000, step: 10000, unit: '원' }),
    F('totalCapKrw', '매수 주문', '총액 상한(0=없음)', 'num', 0, { min: 0, max: 500000000, step: 1000000, unit: '원' }),
    F('buyType', '매수 주문', '주문 방식(시장가는 기다리지 않고 바로 삼 — 아래 매수가·미체결 설정은 지정가일 때만)', 'enum', 'limit', { opts: ENUM.buyType }),
    F('buyPick', '매수 주문', '매수가', 'enum', 'q1', { opts: ENUM.buyPick }),
    F('smartBuy', '매수 주문', '강세 종목은 최우선 매수 호가부터(끄면 항상 위 매수가 기준) — 체결강도·시가 대비 상승이 크거나 잔량 최다 호가가 현재가보다 멀 때', 'bool', true),
    F('smartCttr', '매수 주문', '강세 기준: 체결강도 이상', 'num', 120, { min: 100, max: 300, step: 5, unit: '%' }),
    F('smartRise', '매수 주문', '강세 기준: 시가 대비 상승 이상', 'num', 2, { min: 0.5, max: 8, step: 0.5, unit: '%' }),
    F('q1GapPct', '매수 주문', '잔량 최다 호가가 현재가보다 이만큼 낮으면 최우선 매수 호가로', 'num', 0.8, { min: 0.3, max: 3, step: 0.1, unit: '%' }),
    F('chaseAsk', '매수 주문', '정정 후에도 못 사면 한 번 더 최우선 매도 호가로(추격 상한 안에서만, 손익비 재확인)', 'bool', true),
    F('chasePct', '매수 주문', '추격 상한(알림 시점 가격 대비)', 'num', 1, { min: 0.3, max: 3, step: 0.1, unit: '%' }),
    F('chaseWaitMin', '매수 주문', '추격 뒤 체결 대기(못 사면 취소)', 'num', 3, { min: 1, max: 30, step: 1, unit: '분' }),
    F('rrSlack', '매수 주문', '정정·추격 때 손익비 허용 오차(호가 단위 내림 감안)', 'num', 10, { min: 0, max: 30, step: 1, unit: '%' }),
    F('intentLostSec', '매수 주문', '주문 결과를 모를 때 확인 불가로 처리하기까지(서버 재시작 등 — 중복 주문 방지용, 너무 짧으면 중복 위험)', 'num', 60, { min: 30, max: 600, step: 10, unit: '초' }),
    F('recheckPct', '매수 주문', '승인 후 재확인 허용 변동', 'num', 1.5, { min: 0.5, max: 5, step: 0.1, unit: '%' }),
    F('fillWaitMin', '매수 주문', '미체결 → 정정까지 대기', 'num', 3, { min: 1, max: 30, step: 1, unit: '분' }),
    F('repriceTo', '매수 주문', '정정 가격', 'enum', 'bid1', { opts: ENUM.repriceTo }),
    F('cancelWaitMin', '매수 주문', '정정 후 → 끝낼 때까지 대기', 'num', 3, { min: 1, max: 60, step: 1, unit: '분' }),
    F('unfilledEnd', '매수 주문', '그래도 미체결이면', 'enum', 'cancel', { opts: ENUM.unfilledEnd }),
    F('approval', '매수 주문', '승인 방식', 'enum', 'manual', { opts: ENUM.approval }),
    F('regimeMode', '시장 상태', '시장 상태 점수 반영', 'enum', 'info', { opts: ENUM.regimeMode }),
    F('regimeCaution', '시장 상태', '보수 단계(30~49점) 금액', 'num', 50, { min: 10, max: 100, step: 5, unit: '%' }),
    F('regimeDefense', '시장 상태', '방어 단계(30점 미만) 금액', 'num', 25, { min: 10, max: 100, step: 5, unit: '%' }),
    F('stopPct', '매도', '손절', 'num', 5, { min: 2, max: 10, step: 0.5, unit: '%' }),
    F('rr', '매도', '손익비(매물대 없을 때 목표)', 'num', 3, { min: 1, max: 5, step: 0.5, unit: '배' }),
    F('minRr', '매도', '손익비 하한(목표가 이익 ÷ 손절 손실, 미달이면 매수 안 함 · 0=끔)', 'num', 3, { min: 0, max: 5, step: 0.5, unit: '배' }),
    F('tpStyle', '매도', '익절 방식', 'enum', 'r', { opts: ENUM.tpStyle }),
    F('tp1Pct', '매도', '1단계 익절(고정 % 방식)', 'num', 6, { min: 1, max: 30, step: 0.5, unit: '%' }),
    F('tp2Pct', '매도', '2단계 익절(고정 % 방식, 1단계보다 높게)', 'num', 9, { min: 2, max: 50, step: 0.5, unit: '%' }),
    F('tp1Share', '매도', '1단계 매도 비중(나머지는 2단계)', 'num', 50, { min: 10, max: 90, step: 10, unit: '%' }),
    F('runnerPct', '매도', '러너 비중(목표 없이 트레일링만 · 새 방식에서만)', 'num', 20, { min: 0, max: 50, step: 5, unit: '%' }),
    F('ratchet', '매도', '손절 올리기(항상 적용 — 이 설정과 상관없이 1단계 체결 시 본전, 이후 단계마다 상승)', 'bool', true),
    F('split', '매도', '익절 분할 수', 'num', 5, { min: 1, max: 5, step: 1, unit: '회' }),
    F('minPct', '매도', '1단계 익절 최소', 'num', 3, { min: 1, max: 10, step: 0.5, unit: '%' }),
    F('trail', '매도', '트레일링', 'num', 2, { min: 0.5, max: 5, step: 0.1, unit: '%' }),
    F('eodWeak', '매도', '약한 종목 처리(정리는 승인 후에만, 무응답이면 유지)', 'enum', 'ask', { opts: ENUM.eodWeak }),
    /* 실거래 전환 2단계(2026-11-18): 실행 모드·금액 자동 조정·이상 동작 차단. 기본값 = 가상·고정 금액 → 지금과 같은 동작 */
    F('execMode', '실행 모드', '실행 모드(실전으로 바꿀 때 PIN 다시 확인 · 진행 중 주문·보유·이월이 없을 때만)', 'enum', 'paper', { opts: ENUM.execMode }),
    F('liveAutoOk', '실행 모드', '실전 자동 승인 허용(끄면 실전은 직접 승인해야 매수 — 드라이런 점검 기간은 끔)', 'bool', false),
    F('dryDays', '실행 모드', '드라이런 점검 기간(지나면 "실전 전환 가능" 알림만 — 드라이런은 그대로 계속)', 'num', 3, { min: 1, max: 10, step: 1, unit: '거래일' }),
    F('sizeMode', '매수 금액', '종목당 금액 정하는 방식', 'enum', 'fixed', { opts: ENUM.sizeMode }),
    F('sizePct', '매수 금액', '잔고 기준 비중(0=1÷하루 최대 매수 종목 수)', 'num', 0, { min: 0, max: 100, step: 1, unit: '%' }),
    F('paperCapitalKrw', '매수 금액', '가상 운용 자금(가상 전략이 잔고 기준일 때)', 'num', 10000000, { min: 1000000, max: 1000000000, step: 1000000, unit: '원' }),
    F('minOrderKrw', '매수 금액', '최소 주문 금액(이보다 작으면 사지 않음)', 'num', 100000, { min: 10000, max: 5000000, step: 10000, unit: '원' }),
    F('maxOrdersDay', '실전 안전장치', '하루 주문 횟수 상한(정정 포함)', 'num', 20, { min: 1, max: 100, step: 1, unit: '번' }),
    F('rejectStop', '실전 안전장치', '주문 거부가 이만큼이면 그날 전략 정지', 'num', 3, { min: 1, max: 10, step: 1, unit: '번' }),
    F('unsureStop', '실전 안전장치', '접수 확인 실패(KIS 응답 없음)가 이만큼이면 그날 전략 정지', 'num', 2, { min: 1, max: 10, step: 1, unit: '번' }),
  ],
  closing: [
    F('judgeAt', '적용 시간', '종가 판정·알림 시각(정규장 종목)', 'time', '14:45', { min: '14:30', max: '15:10' }),
    F('replyMin', '적용 시간', '정리 답 마감까지(정규장 종목)', 'num', 15, { min: 5, max: 25, step: 1, unit: '분' }),
    F('nxtJudgeAt', '적용 시간', '종가 판정·알림 시각(NXT 거래 종목)', 'time', '18:30', { min: '16:00', max: '19:30' }),
    F('nxtReplyMin', '적용 시간', '정리 답 마감까지(NXT 거래 종목)', 'num', 30, { min: 5, max: 55, step: 1, unit: '분' }),
    F('convertAt', '적용 시간', '오버나잇 전환 시각', 'time', '20:00', { min: '15:30', max: '20:00' }),
    F('needAboveAvg', '넘길 자격', '현재가 > 매수 평균가', 'bool', true),
    F('highNearPct', '넘길 자격', '당일 고가 대비 이내', 'num', 2, { min: 0.5, max: 5, step: 0.5, unit: '%' }),
    F('carryFlow', '넘길 자격', '수급', 'enum', 'any', { opts: ENUM.carryFlow }),
    F('holdOn', '아침 보류(장중 전환)', '매수가보다 낮게 시작하면 매도 보류 → 장중 전략으로 전환', 'bool', true),
    F('holdMode', '아침 보류(장중 전환)', '보류 조건', 'enum', 'price', { opts: ENUM.holdMode }),
    F('holdGraceMin', '아침 보류(장중 전환)', '전환 종목 손절 유예(09:00부터)', 'num', 0, { min: 0, max: 180, step: 5, unit: '분' }),
    F('idxFloor', '넘길 자격', '지수 하한(코스피·코스닥)', 'num', -1, { min: -3, max: 0, step: 0.1, unit: '%' }),
    F('closeBuyOn', '종가베팅 저녁 매수(NXT)', '저녁에 새 후보를 골라 매수', 'bool', true),
    F('closeBuyWatchFrom', '종가베팅 저녁 매수(NXT)', '관찰 시작 시각', 'time', '18:00', { min: '16:00', max: '19:00' }),
    F('closeBuyWatchMin', '종가베팅 저녁 매수(NXT)', '관찰 간격(0=관찰 없이 바로 선정)', 'num', 30, { min: 0, max: 60, step: 5, unit: '분' }),
    F('closeBuyBonus', '종가베팅 저녁 매수(NXT)', '관찰 통과 가점(최대)', 'num', 10, { min: 0, max: 20, step: 1, unit: '점' }),
    F('closeBuyAt', '종가베팅 저녁 매수(NXT)', '최종 선정·알림 시각', 'time', '19:30', { min: '16:00', max: '19:30' }),
    F('closeBuyEnd', '종가베팅 저녁 매수(NXT)', '승인·주문 마감 시각', 'time', '19:50', { min: '16:10', max: '19:55' }),
    F('closeBuyMax', '종가베팅 저녁 매수(NXT)', '하루 최대 매수 종목 수', 'num', 3, { min: 1, max: 10, step: 1, unit: '종목' }),
    F('closeBuyHighPct', '종가베팅 저녁 매수(NXT)', '당일 고가 대비 종가 낙폭 한도', 'num', 5, { min: 1, max: 10, step: 0.5, unit: '%' }),
    F('closeBuyPenaltyFrom', '종가베팅 저녁 매수(NXT)', '이 낙폭부터 점수 감점', 'num', 2, { min: 0.5, max: 5, step: 0.5, unit: '%' }),
    F('closeBuyPenaltyMax', '종가베팅 저녁 매수(NXT)', '낙폭 한도에서의 최대 감점', 'num', 30, { min: 0, max: 60, step: 5, unit: '점' }),
    F('closeBuyApproval', '종가베팅 저녁 매수(NXT)', '매수 승인 방식', 'enum', 'auto', { opts: ENUM.cbApproval }),
    F('overnightStopPct', '오버나잇', '밤새 유지할 손절', 'num', 5, { min: 2, max: 10, step: 0.5, unit: '%' }),
    F('gapCut', '다음 날 매도', '갭 하락 즉시 전량', 'num', -3, { min: -10, max: -1, step: 0.5, unit: '%' }),
    F('slices', '다음 날 매도', '분할 매도 시각', 'times', ['09:05', '09:10', '09:15'], { min: '09:01', max: '10:00', maxLen: 5 }),
  ],
};
/* 2026-11-19 종가베팅 독립: 종가베팅 전략이 장중 전략에 기대지 않고 스스로 고르고·사고·파는 데 쓰는 조건을 자기 값으로 가진다.
   처음엔 장중 기본 전략(intraday-default)의 값을 복사해 시작(실행 모드·실전 자동 승인·안전장치는 복사하지 않고 가상·끔에서 시작) */
const CLOSE_COPY = ['capMinEok', 'maTrend', 'smx', 'smxWin', 'flowForeign', 'flowInst', 'flowProgram', 'poolTop', 'sectorMax', 'weights',
  'perStockKrw', 'totalCapKrw', 'buyPick', 'fillWaitMin', 'repriceTo', 'cancelWaitMin', 'unfilledEnd', 'regimeMode', 'regimeCaution', 'regimeDefense',
  'stopPct', 'rr', 'tpStyle', 'runnerPct', 'tp1Pct', 'tp2Pct', 'tp1Share', 'ratchet', 'trail', 'split', 'minPct', 'eodWeak',
  'execMode', 'liveAutoOk', 'dryDays', 'amtMinEok', 'sizeMode', 'sizePct', 'paperCapitalKrw', 'minOrderKrw', 'maxOrdersDay', 'rejectStop', 'unsureStop'];
const CLOSE_NOCOPY = new Set(['execMode', 'liveAutoOk', 'dryDays', 'maxOrdersDay', 'rejectStop', 'unsureStop']);   // 처음 복사할 때도 장중 값을 가져오지 않음(가상·끔·기본 안전장치에서 시작)
const CLOSE_GROUP = { '대상': '후보 조건(장중 전략과 따로)', '매수 조건': '후보 조건(장중 전략과 따로)', '후보 수': '후보 조건(장중 전략과 따로)', '점수': '후보 조건(장중 전략과 따로)',
  '매수 주문': '매수 주문', '시장 상태': '시장 상태', '매도': '아침 보류(장중 전환) 뒤 매도 계획', '실행 모드': '실행 모드', '매수 금액': '매수 금액', '실전 안전장치': '실전 안전장치' };
const CLOSE_LABEL = { eodWeak: '약한 종목 처리(아침 보류로 장중 전환된 종목의 14:45·18:30 판정)', perStockKrw: '종목당 금액', totalCapKrw: '총액 상한(0=없음)' };
SCHEMA.closing = SCHEMA.closing.concat(SCHEMA.intraday.filter(f => CLOSE_COPY.includes(f.key)).map(f => ({ ...f, group: CLOSE_GROUP[f.group] || f.group, label: CLOSE_LABEL[f.key] || f.label,
  ...(f.key === 'execMode' ? { label: '실행 모드(어느 장부로 살지 · 실전으로 바꿀 때 PIN · 진행 중 주문·보유·이월이 없을 때만)' } : {}) })));
const OLD_W = [['flow', 40], ['cttr', 15], ['rise', 15], ['amt', 15], ['trend', 15]];   // 개인 계좌수 항목이 생기기 전 기본 배점
const KINDS = { intraday: '장중매매', closing: '종가베팅' };
const MAX_ACTIVE = { intraday: 12, closing: 1 };   // 동시에 켤 수 있는 수(종가베팅은 장중 보유분을 넘겨받는 방식이라 하나만). 장중은 쪽(가상매매·실전매매)마다 3개
const LETTERS = 'ABCDEFGHIJKLMOPQRSTUVWXYZ'.split('');   // N 은 종가베팅 글자라 건너뜀   // 켜진 장중 전략 글자(텔레그램 답장 A1·D2). 가상·실전 합쳐 최대 6
/* 쪽: 가상매매(실행 모드 가상) · 실전매매(드라이런·실전) — 2026-11-19 */
/* 드라이런 점검 진행(2026-11-19): 드라이런으로 돈 거래일 수. dates = 시작일 이후 이 전략의 기록이 있는 거래일들.
   끝난 날 수(n) = 오늘 이전 기록일 + (오늘 기록이 있고 15:30 이후면 1). 진행 중인 오늘은 day 에 +1 로 보여줌 */
function dryProgress(dates, today, min, total) {
  const set = new Set((dates || []).map(String)), past = [...set].filter(d => d < today).length, hasToday = set.has(today), closed = hasToday && min >= 15 * 60 + 30;
  const n = past + (closed ? 1 : 0), t = Math.max(1, +total || 3);
  return { n, day: Math.min(t, n + (hasToday && !closed ? 1 : 0)), total: t, done: n >= t, running: hasToday && !closed };
}
const sideOfParams = p => (p && p.execMode && p.execMode !== 'paper' ? 'real' : 'paper');

const defaults = kind => Object.fromEntries((SCHEMA[kind] || []).map(f => [f.key, JSON.parse(JSON.stringify(f.def))]));
/* 장중 조건 → 종가 전략 조건(복사 대상만, 실행 모드·안전장치 제외). 결과는 검증을 거친 값 */
function closingFromIntraday(cp, ip) {
  const pick = {}; for (const k of CLOSE_COPY) if (!CLOSE_NOCOPY.has(k) && ip && ip[k] !== undefined) pick[k] = JSON.parse(JSON.stringify(ip[k]));
  const v = validate('closing', { ...(cp || {}), ...pick, execMode: 'paper', liveAutoOk: false });
  return v.val || { ...(cp || {}) };
}

/* 검증: 모르는 키는 버리고, 빠진 키는 base(없으면 기본값)로 채움 → { val } | { errs:[{key,msg}] } */
function validate(kind, input, base) {
  const S = SCHEMA[kind];
  if (!S) return { errs: [{ key: 'kind', msg: '전략 유형이 올바르지 않습니다' }] };
  const src = input && typeof input === 'object' ? input : {}, b = { ...defaults(kind), ...(base || {}) }, val = {}, errs = [];
  const bad = (f, msg) => errs.push({ key: f.key, msg: `${f.label}: ${msg}` });
  for (const f of S) {
    let v = src[f.key] === undefined ? b[f.key] : src[f.key];
    if (f.key === 'eodWeak' && v === 'auto_sell') v = 'ask';   // 예전 '자동 정리' 값 — 이제 정리는 항상 승인 후에만
    if (f.type === 'num') {
      const n = typeof v === 'string' && v.trim() !== '' ? +v : v;
      if (typeof n !== 'number' || !isFinite(n)) { bad(f, '숫자가 아닙니다'); continue; }
      if (n < f.min || n > f.max) { bad(f, `${f.min}~${f.max}${f.unit || ''} 사이여야 합니다`); continue; }
      const k = Math.round(n / f.step);
      if (Math.abs(k * f.step - n) > 1e-9) { bad(f, `${f.step}${f.unit || ''} 단위여야 합니다`); continue; }
      val[f.key] = Math.round(k * f.step * 1e6) / 1e6;
    } else if (f.type === 'time') {
      const m = tmin(v);
      if (isNaN(m) || m < tmin(f.min) || m > tmin(f.max)) { bad(f, `${f.min}~${f.max} 사이 HH:MM`); continue; }
      val[f.key] = hhmm(m);
    } else if (f.type === 'times') {
      const a = Array.isArray(v) ? v.map(tmin) : [];
      if (!a.length || a.length > f.maxLen || a.some(m => isNaN(m) || m < tmin(f.min) || m > tmin(f.max))) { bad(f, `1~${f.maxLen}개, ${f.min}~${f.max} 사이`); continue; }
      if (a.some((m, i) => i && m <= a[i - 1])) { bad(f, '시각이 앞에서부터 늘어나야 합니다'); continue; }
      val[f.key] = a.map(hhmm);
    } else if (f.type === 'bool') {
      if (typeof v !== 'boolean') { bad(f, '켜기/끄기 값이 아닙니다'); continue; }
      val[f.key] = v;
    } else if (f.type === 'enum') {
      if (!Object.prototype.hasOwnProperty.call(f.opts, v)) { bad(f, '선택지에 없는 값입니다'); continue; }
      val[f.key] = v;
    } else if (f.type === 'weights') {
      let o = v && typeof v === 'object' ? v : {};
      const out = {};
      if (o.kw === undefined && OLD_W.every(([k, x]) => o[k] === x)) o = f.def;   // 손대지 않은 예전 기본 배점(개인 물량 항목 없음)은 새 기본 배점으로 올림
      let ok = true;
      for (const p of Object.keys(f.parts)) { const n = o[p] === undefined && p === 'kw' ? 0 : +o[p];   // 예전에 저장한 배점에는 개인 물량 항목이 없음 → 0점으로 간주
         if (!Number.isInteger(n) || n < 0 || n > 100) ok = false; out[p] = n; }
      if (!ok) { bad(f, '각 배점은 0~100 정수'); continue; }
      const sum = Object.values(out).reduce((a, x) => a + x, 0);
      if (sum !== 100) { bad(f, `합계가 ${sum}입니다(100이어야 함)`); continue; }
      val[f.key] = out;
    }
  }
  if (!errs.length && kind === 'closing' && val.regimeDefense > val.regimeCaution) errs.push({ key: 'regimeDefense', msg: '방어 단계 금액은 보수 단계 금액보다 클 수 없습니다' });
  if (!errs.length && kind === 'intraday') {
    if (val.regimeDefense > val.regimeCaution) errs.push({ key: 'regimeDefense', msg: '방어 단계 금액은 보수 단계 금액보다 클 수 없습니다' });
    if (val.tpStyle === 'fixed' && !(val.tp2Pct > val.tp1Pct)) errs.push({ key: 'tp2Pct', msg: '2단계 익절은 1단계보다 높아야 합니다' });
    if (val.notifyTop > val.poolTop) errs.push({ key: 'notifyTop', msg: '알림에 싣는 수는 점수 상위 후보 수보다 클 수 없습니다' });
    const dl = tmin(val.selectAt) + val.noticeAfter + val.approveWindow;
    const dlMax = (val.selector === 'pullback' || val.selector === 'inverse') ? 15 * 60 + 15 : 14 * 60 + 30;
    if (dl > dlMax) errs.push({ key: 'approveWindow', msg: `승인 마감이 ${hhmm(dl)}입니다(${hhmm(dlMax)} 이전이어야 함)` });
  }
  if (!errs.length && kind === 'intraday' && val.roundMin > 0) {
    if (tmin(val.roundEnd) <= tmin(val.selectAt)) errs.push({ key: 'roundEnd', msg: '마지막 검토 시각은 첫 선정 시각보다 늦어야 합니다' });
    else if (tmin(val.roundEnd) + val.approveWindow > 15 * 60 + 15) errs.push({ key: 'roundEnd', msg: `마지막 검토의 승인 마감이 ${hhmm(tmin(val.roundEnd) + val.approveWindow)}입니다(15:15 이전이어야 함)` });
  }
  if (!errs.length && kind === 'closing' && tmin(val.slices[val.slices.length - 1]) >= 15 * 60 + 20) errs.push({ key: 'slices', msg: '분할 매도 시각이 너무 늦습니다' });
  if (!errs.length && kind === 'closing') {
    const reply = tmin(val.judgeAt) + val.replyMin, nreply = tmin(val.nxtJudgeAt) + val.nxtReplyMin;
    if (reply > 15 * 60 + 25) errs.push({ key: 'replyMin', msg: `정규장 종목 답 마감이 ${hhmm(reply)}입니다(15:25 이전이어야 함)` });
    else if (tmin(val.nxtJudgeAt) <= reply) errs.push({ key: 'nxtJudgeAt', msg: 'NXT 종목 판정 시각은 정규장 종목 답 마감보다 늦어야 합니다' });
    else if (nreply > tmin(val.convertAt)) errs.push({ key: 'nxtReplyMin', msg: `NXT 종목 답 마감이 ${hhmm(nreply)}입니다(오버나잇 전환 ${val.convertAt} 이전이어야 함)` });
    else if (tmin(val.closeBuyEnd) <= tmin(val.closeBuyAt)) errs.push({ key: 'closeBuyEnd', msg: '종가베팅 매수 마감은 선정 시각보다 늦어야 합니다' });
    else if (tmin(val.closeBuyEnd) > tmin(val.convertAt) - 5) errs.push({ key: 'closeBuyEnd', msg: `종가베팅 매수 마감은 오버나잇 전환(${val.convertAt}) 5분 전까지여야 합니다` });
    else if (val.closeBuyWatchMin > 0 && tmin(val.closeBuyWatchFrom) >= tmin(val.closeBuyAt)) errs.push({ key: 'closeBuyWatchFrom', msg: '관찰 시작 시각은 최종 선정 시각보다 빨라야 합니다' });
    else if (val.closeBuyPenaltyFrom >= val.closeBuyHighPct) errs.push({ key: 'closeBuyPenaltyFrom', msg: '감점 시작 낙폭은 낙폭 한도보다 작아야 합니다' });
  }
  return errs.length ? { errs } : { val };
}

const show = (f, v) => {
  if (v == null) return '–';
  if (f.type === 'bool') return v ? '켜기' : '끄기';
  if (f.type === 'enum') return f.opts[v] || String(v);
  if (f.type === 'times') return v.join('·');
  if (f.type === 'weights') return Object.keys(f.parts).map(p => `${f.parts[p]} ${v[p]}`).join(' · ');
  if (f.type === 'num') return `${f.key === 'perStockKrw' ? v.toLocaleString('ko-KR') : v}${f.unit || ''}`;
  return String(v);
};
/* 변경점: [{key,label,from,to}] (표시용 문자열) */
function diff(kind, a, b) {
  const out = [];
  for (const f of SCHEMA[kind] || []) if (JSON.stringify(a && a[f.key]) !== JSON.stringify(b && b[f.key])) out.push({ key: f.key, label: f.label, from: show(f, a && a[f.key]), to: show(f, b && b[f.key]) });
  return out;
}

/* 엔진이 쓰는 형태로 풀어 줌(시각 → 분) */
/* 종가베팅 저녁 관찰 회차 시각(분): 시작 시각부터 간격마다, 최종 선정 시각 전까지 */
function cbWatchTimes(C) {
  const out = [], step = +C.closeBuyWatchMin || 0;
  if (!C.closeBuyOn || step <= 0) return out;
  for (let t = tmin(C.closeBuyWatchFrom); t < tmin(C.closeBuyAt) && out.length < 12; t += step) out.push(t);
  return out;
}
function timesOf(I, C) {
  const sel = tmin(I.selectAt), notice = sel + I.noticeAfter, deadline = notice + I.approveWindow;
  const judge = tmin(C.judgeAt), reply = judge + C.replyMin, njudge = tmin(C.nxtJudgeAt), nreply = njudge + C.nxtReplyMin;
  return { sel, notice, deadline, selEnd: deadline + 30, judge, reply, njudge, nreply, cbWatch: cbWatchTimes(C), cbAt: tmin(C.closeBuyAt), cbEnd: tmin(C.closeBuyEnd), convert: tmin(C.convertAt), slices: C.slices.map(tmin) };
}

const CLOSE_DESC_OLD = /약한 종목을 (알려 )?승인 후 정리/;   // 장중 보유분을 넘겨받던 때의 설명(독립 전환 때 새 설명으로 바꿈)
const CLOSE_DESC = '장중 전략과 따로 움직임 — 18:00부터 30분마다 종가 강한 NXT 종목을 관찰해 19:30에 골라 NXT 지정가로 사서, 20:00에 이월해 다음 날 아침 분할 매도(매수가보다 낮으면 보류하고 장중 계획으로 전환)';
const BUILTIN0 = [
  { id: 'intraday-default', name: '수급 돌파 장중', kind: 'intraday', builtin: true, desc: '오전 외국인·기관·프로그램 동시 순매수 + 체결강도 강세 종목을 사서 당일 손절·5분할 익절' },
  { id: 'closing-default', name: '장중 강세 이월', kind: 'closing', builtin: true, desc: CLOSE_DESC },
];
/* 장초 상승 포착("시동", 2026-11-25) 기본값: 중소형(시총 3천억~4조 미만)을 09:15부터 10분 간격으로 훑어 종목당 100만원·하루 5종목, 15:14 전량 청산(가상) */
const IGNITE_PRESET = { selector: 'ignite', capMinEok: 3000, capMaxEok: 40000, amtMinEok: 30, maTrend: false, smx: 'off', flowForeign: 'ignore', flowInst: 'ignore', flowProgram: 'ignore', altFlowOn: false, kwOn: false,
  selectAt: '09:15', noticeAfter: 0, approveWindow: 5, roundMin: 10, roundEnd: '14:30', openRiseMax: 6, cttrMin: 120, poolTop: 5, notifyTop: 5, sectorMax: 2, maxBuys: 5, maxTries: 1, retryUnfilled: false, perStockKrw: 1000000, approval: 'auto',
  buyType: 'market', stopPct: 3, rr: 2, minRr: 0, tpStyle: 'fixed', tp1Pct: 6, tp2Pct: 9, tp1Share: 50, runnerPct: 30, ratchet: true, trail: 2, flatOn: true, flatAt: '15:14', execMode: 'paper' };
const BUILTIN = BUILTIN0.concat([{ id: 'ignite-default', name: '장초 상승 포착(시동)', kind: 'intraday', builtin: true, off: true, preset: IGNITE_PRESET, desc: '시총 3천억~4조 미만 중소형주 중 처음부터 많이 뜬 종목은 빼고, 09시 이후 거래가 붙으며 오르기 시작하는 종목을 09:15부터 10분마다 포착해 가상 매수(종목당 100만원·하루 5종목) · 15:14 전량 청산' }]);
/* 눌림목("무게 1·2위일 가격 회복", 2026-11-26 규칙 교체) 기본값: 15:10 에 후보를 골라 시장가로 매수(가상), 매수가 −5% 아래 종가 마감 손절 · +10/+15% 2분할(손절 5% 기준 손익비 1:2·1:3, 최대 목표 15%) · 10거래일 시간 청산.
   하루 최대 3종목(종목당 100만원). 시총 상한 같은 조건은 처음엔 모두 끄고 신호를 모은다(스마트머니 점검만 켜짐) */
const PULLBACK_PRESET = { selector: 'pullback', capMinEok: 1000, capMaxEok: 0, amtMinEok: 0, maTrend: false, smx: 'off', flowForeign: 'ignore', flowInst: 'ignore', flowProgram: 'ignore', altFlowOn: false, kwOn: false,
  selectAt: '15:10', noticeAfter: 0, approveWindow: 5, roundMin: 0, poolTop: 5, notifyTop: 5, sectorMax: 2, maxBuys: 3, maxTries: 1, retryUnfilled: false, perStockKrw: 1000000, approval: 'auto',
  buyType: 'market', stopPct: 5, rr: 3, minRr: 0, tpStyle: 'fixed', tp1Pct: 10, tp2Pct: 15, tp1Share: 50, runnerPct: 30, ratchet: true, trail: 2, flatOn: false, execMode: 'paper',
  pbWMin: 0.1, pbMaxAge: 63, pbDipPct: 2, pbBreakPct: 1, pbChasePct: 6, pbStopBelowPct: 5, pbHoldDays: 10, pbSmGate: true };
BUILTIN.push({ id: 'pullback-default', name: '눌림목(무게 1·2위일 가격 회복)', kind: 'intraday', builtin: true, off: true, preset: PULLBACK_PRESET, desc: '3개월 안에 무게/주식수 1·2위일이 있던 종목 중, 주가가 그날 평균가 아래로 빠졌고 스마트머니 1개월·3개월 수급에서 주도 세력이 아직 안 빠졌으면, 현재가가 그 평균가를 완전히 돌파(+1%)하는 15:10 에 가상 매수(종목당 100만원·하루 3종목) · 매수가 −5% 아래 종가 마감 시 손절, +10%(손익비 1:2)·+15%(1:3, 최대 목표) 2분할 익절, 10거래일 시간 청산(새 규칙 — 과거 검증상 손익비 1 미만이라 가상으로만 관찰)' });
/* 인버스·사이드카(2026-11-26): 191·192·193 연구. 지수 ETF 를 시장가로(승인 자동·종목 1개 100만원). 익절 없이 정리 규칙으로만 나온다(A 60일선 회복 · B 15:15 · C 보유일) — 모두 꺼진 가상 전략 */
const INV_BASE = { selector: 'inverse', capMinEok: 1000, capMaxEok: 0, amtMinEok: 0, maTrend: false, smx: 'off', flowForeign: 'ignore', flowInst: 'ignore', flowProgram: 'ignore', altFlowOn: false, kwOn: false,
  selectAt: '15:10', noticeAfter: 0, approveWindow: 5, roundMin: 0, poolTop: 1, notifyTop: 1, sectorMax: 1, maxBuys: 1, maxTries: 1, retryUnfilled: false, perStockKrw: 1000000, approval: 'auto',
  buyType: 'market', stopPct: 5, rr: 2, minRr: 0, tpStyle: 'fixed', tp1Pct: 8, tp2Pct: 12, tp1Share: 50, runnerPct: 30, ratchet: false, trail: 2, flatOn: false, execMode: 'paper', invMaDays: 60, invDropPct: 4, invHoldDays: 2 };
BUILTIN.push(
  { id: 'inverse-regime', name: '인버스 A(하락 국면 보유)', kind: 'intraday', builtin: true, off: true, preset: { ...INV_BASE, invMode: 'regime', invCode: '114800', stopPct: 7 }, desc: '코스피200(KODEX 200)이 60일선 아래인 하락 국면에서 15:10 에 KODEX 인버스(1X)를 가상 매수(100만원), 60일선 위로 올라오면 15:15 에 정리 · 손절 −7%(종가 마감) · 검증: 하락장 1X +28%, 상승장 −13%(국면 필터 필수)' },
  { id: 'inverse-flow', name: '인버스 B(외국인 동반 순매도)', kind: 'intraday', builtin: true, off: true, preset: { ...INV_BASE, invMode: 'flow', invCode: '252670', selectAt: '09:10', stopPct: 4, flatOn: true, flatAt: '15:15' }, desc: '어제 외국인이 코스피 현물과 코스피200 선물을 둘 다 순매도하면 09:10 에 KODEX 200선물인버스2X 를 가상 매수, 15:15 에 청산 · 손절 −4% · 검증: 상승장 24건 승률 62% 평균 +3.3%, 하락장 19건 본전(검증 중)' },
  { id: 'sidecar-rebound', name: '사이드카 C(매도 사이드카 반등)', kind: 'intraday', builtin: true, off: true, preset: { ...INV_BASE, invMode: 'sidecar', invCode: '122630', stopPct: 10 }, desc: '매도 사이드카(발동 기록 또는 KODEX 200 −4% 이하)가 난 날 15:10 에 KODEX 레버리지를 가상 매수, 이틀째 15:15 정리(하락 국면이면 다음날) · 손절 −10%(1X는 −5%) · 검증: 38건 이틀째 종가 레버리지 +4.3%, 하락장 9건은 약함' }
);
const builtinRow = b => ({ ...b, enabled: !b.off, archived: false, version: 1, params: b.preset ? (validate(b.kind, b.preset).val || defaults(b.kind)) : defaults(b.kind), updated_at: null });

/* 저장소: auto_strategies · auto_strategy_versions. 30초 캐시, 테이블이 없으면 기본 전략으로 동작 */
function createStore({ sbGet, sbWrite, now = Date.now, cacheMs = 30000 }) {
  let cache = null, at = 0, missing = false;
  /* 원본 연결 컬럼(source)은 DB 설정(dryrun_ledger) 전에는 없을 수 있음 → 빼고 저장(원본 연결만 기록되지 않음) */
  const SRC = require('./opt-col').createOptCol('source', { onMissing: () => console.warn('[전략] auto_strategies.source 컬럼 없음 — 원본 연결 없이 저장([수시] DB 테이블·뷰 생성 → dryrun_ledger)') });
  let chain = Promise.resolve();
  const lock = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const norm = r => {
    let pr = r.params || {};
    // 2026-11-16: 예전 기본 시각(19:05 선정·19:45 마감)을 그대로 쓰던 종가 전략은 새 흐름(18:00 관찰 → 19:30 최종 선정·19:50 마감)으로 옮김
    if (r.kind === 'closing' && pr.closeBuyWatchMin === undefined && pr.closeBuyAt === '19:05' && pr.closeBuyEnd === '19:45') pr = { ...pr, closeBuyAt: '19:30', closeBuyEnd: '19:50' };
    // 2026-11-16: 예전 기본 판정 시각(15:00/답 20분 · 19:00/답 40분)을 쓰던 종가 전략은 새 기본(14:45→15:00 · 18:30→19:00)으로 옮김
    if (r.kind === 'closing') {
      if (pr.judgeAt === '15:00' && +pr.replyMin === 20) pr = { ...pr, judgeAt: '14:45', replyMin: 15 };
      if (pr.nxtJudgeAt === '19:00' && +pr.nxtReplyMin === 40) pr = { ...pr, nxtJudgeAt: '18:30', nxtReplyMin: 30 };
    }
    const v = validate(r.kind, pr);
    const needCopy = r.kind === 'closing' && (r.params || {}).capMinEok === undefined;   // 독립 전 종가 전략(장중 조건을 아직 복사하지 않음)
    return { id: r.id, name: r.name, kind: r.kind, desc: r.desc || '', enabled: !!r.enabled, archived: !!r.archived, builtin: !!r.builtin, version: +r.version || 1,
      params: v.val || defaults(r.kind), invalid: v.errs ? v.errs.map(e => e.msg) : null, updatedAt: r.updated_at || null, source: r.source || null, ...(needCopy ? { needCopy: true } : {}) };
  };
  async function list(fresh) {
    if (!fresh && cache && now() - at < cacheMs) return cache;
    let rows;
    try { rows = await sbGet('auto_strategies?select=*&order=created_at.asc&limit=100'); missing = false; }
    catch (e) {
      if (/404|PGRST205|does not exist/.test(String(e && e.message))) { missing = true; rows = []; }
      else if (cache) return cache; else throw e;
    }
    const out = rows.map(norm);
    for (const b of BUILTIN) if (!out.some(r => r.id === b.id)) out.push(norm(builtinRow(b)));   // 기본 전략은 항상 있음
    const src = out.find(r => r.id === 'intraday-default');
    for (const r of out) if (r.needCopy) r.params = closingFromIntraday(r.params, src && src.params);   // 저장 전에도 독립 조건으로 동작(저장은 migrate 가 한 번)
    cache = out; at = now();
    return out;
  }
  /* 유형별로 지금 쓰는 전략(A단계: 켜진 것 중 첫 번째, 없으면 기본 전략을 '꺼짐'으로) */
  async function active(kind) {
    const L = (await list()).filter(r => r.kind === kind && !r.archived);
    return L.find(r => r.enabled) || { ...(L.find(r => r.builtin) || norm(builtinRow(BUILTIN.find(b => b.kind === kind)))), enabled: false };
  }
  async function pair() { const [I, C] = await Promise.all([active('intraday'), active('closing')]); return { I, C, T: timesOf(I.params, C.params) }; }
  /* 켜진 장중 전략 전부(쪽마다 최대 3, 만든 순서) + 종가 전략 하나. 각 장중 전략의 시각 T 와 글자(A~F, 만든 순서) */
  async function actives() {
    const L = await list(), C = await active('closing'), n = { paper: 0, real: 0 };
    const Is = L.filter(r => r.kind === 'intraday' && r.enabled && !r.archived).filter(r => ++n[sideOfParams(r.params)] <= MAX_ACTIVE.intraday)
      .map((I, i) => ({ ...I, letter: LETTERS[i], T: timesOf(I.params, C.params) }));
    return { Is, C };
  }
  async function byId(id) {
    const L = await list(), r = L.find(x => x.id === id);
    return r || null;
  }
  /* 저장: patch = { params?(일부만 와도 됨), enabled?, name?, desc? } → 버전 +1 */
  function save(id, patch, who, opts = {}) {
    return lock(async () => {
      if (missing) await list(true);
      if (missing) return { ok: false, status: 503, error: '전략 테이블이 아직 없습니다. DB 설정에서 auto_strategy 를 실행하세요' };
      const cur = (await list(true)).find(r => r.id === id);
      if (!cur) return { ok: false, status: 404, error: '전략을 찾을 수 없습니다' };
      if (opts.onlyIfNeedCopy && !cur.needCopy) return { ok: true, strategy: cur, changed: [], unchanged: true };   // 다른 쪽에서 이미 독립 저장함
      const p = patch || {}, next = { ...cur };
      delete next.needCopy;
      if (p.params !== undefined) {
        const v = validate(cur.kind, p.params, cur.params);
        if (v.errs) return { ok: false, status: 400, error: v.errs.map(e => e.msg).join(' / '), errs: v.errs };
        next.params = v.val;
      }
      /* 섞임 방지(2026-11-19): 장중 전략은 쪽(가상 ↔ 실전매매)을 옮기지 않음. 가상 → 실전은 「실전에 적용」(새 복제본, allowSide)으로만,
         실전매매 안에서는 드라이런 ↔ 실전만. 보유·이월·일지가 장부별이라 쪽을 옮기면 기록이 다른 장부와 섞임 */
      if (cur.kind === 'intraday' && !opts.allowSide && sideOfParams(next.params) !== sideOfParams(cur.params)) {
        return { ok: false, status: 409, error: sideOfParams(cur.params) === 'paper' ? '가상매매 전략은 드라이런·실전으로 바꿀 수 없어요. 「실전에 적용」으로 실전매매에 복제하세요' : '실전매매 전략은 가상으로 바꿀 수 없어요(드라이런 ↔ 실전만). 가상으로 시험하려면 가상매매의 원본을 쓰세요' };
      }
      if (p.enabled !== undefined) { if (typeof p.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled 값이 올바르지 않습니다' }; next.enabled = p.enabled; }
      if (next.archived) return { ok: false, status: 400, error: '보관된 전략은 고칠 수 없습니다' };
      let others = [];
      const sideChange = cur.kind === 'intraday' && next.enabled && cur.enabled && sideOfParams(next.params) !== sideOfParams(cur.params);   // 켜진 채 쪽을 옮김(가상 → 드라이런 등)
      if ((next.enabled && !cur.enabled) || sideChange) {
        const on = (await list()).filter(r => r.kind === cur.kind && r.enabled && !r.archived && r.id !== cur.id && (cur.kind !== 'intraday' || sideOfParams(r.params) === sideOfParams(next.params)));
        if (cur.kind === 'intraday' && on.length >= MAX_ACTIVE.intraday) return { ok: false, status: 400, error: `${sideOfParams(next.params) === 'real' ? '실전매매' : '가상매매'} 장중 전략은 최대 ${MAX_ACTIVE.intraday}개까지 켤 수 있습니다. 다른 전략을 먼저 끄세요` };
        if (cur.kind === 'closing') others = on;   // 종가베팅은 하나만: 다른 종가 전략은 끔
      }
      if (p.name !== undefined) { const n = String(p.name).trim(); if (!n || n.length > 30) return { ok: false, status: 400, error: '이름은 1~30자' }; next.name = n; }
      if (p.desc !== undefined) next.desc = String(p.desc).slice(0, 200);
      const changed = diff(cur.kind, cur.params, next.params);
      const meta = ['enabled', 'name', 'desc'].filter(k => next[k] !== cur[k]).map(k => ({ key: k, label: { enabled: '켜기/끄기', name: '이름', desc: '설명' }[k], from: String(cur[k]), to: String(next[k]) }));
      if (!changed.length && !meta.length && !opts.force) return { ok: true, strategy: cur, changed: [], unchanged: true };
      next.version = cur.version + 1;
      const ts = new Date(now()).toISOString();
      await SRC.write(sbWrite, 'auto_strategies?on_conflict=id', 'POST', [{ id: next.id, name: next.name, kind: next.kind, desc: next.desc, enabled: next.enabled, archived: next.archived, builtin: next.builtin, version: next.version, params: next.params, updated_at: ts, ...(next.source ? { source: next.source } : {}) }]);
      await sbWrite('auto_strategy_versions', 'POST', [{ strategy_id: next.id, version: next.version, params: next.params, changed: [...changed, ...meta, ...(opts.note ? [opts.note] : [])], who: who || null, at: ts }]);
      for (const o of others) await writeRow({ ...o, enabled: false, version: o.version + 1 }, [{ key: 'enabled', label: '켜기/끄기', from: 'true', to: 'false' }, { key: 'auto', label: '사유', from: '', to: `${next.name} 켜짐(종가베팅은 하나만)` }], who, ts);
      cache = null;
      return { ok: true, strategy: { ...next, updatedAt: ts }, changed: [...changed, ...meta], turnedOff: others.map(o => o.name) };
    });
  }
  async function writeRow(r, changed, who, ts) {
    await SRC.write(sbWrite, 'auto_strategies?on_conflict=id', 'POST', [{ id: r.id, name: r.name, kind: r.kind, desc: r.desc || '', enabled: !!r.enabled, archived: !!r.archived, builtin: !!r.builtin, version: r.version, params: r.params, updated_at: ts, ...(r.source ? { source: r.source } : {}) }]);
    await sbWrite('auto_strategy_versions', 'POST', [{ strategy_id: r.id, version: r.version, params: r.params, changed, who: who || null, at: ts }]);
  }
  /* 새 전략: 기본값 또는 기존 전략 복제. 꺼진 상태로 만든다. linkSource = 복제 원본을 source 로 기억("실전에 적용") */
  function create({ kind, name, desc, from, linkSource } = {}, who) {
    return lock(async () => {
      await list(true);
      if (missing) return { ok: false, status: 503, error: '전략 테이블이 아직 없습니다' };
      const L = await list(true), src = from ? L.find(r => r.id === from) : null;
      if (from && !src) return { ok: false, status: 404, error: '복제할 전략을 찾을 수 없습니다' };
      const k = src ? src.kind : kind;
      if (!SCHEMA[k]) return { ok: false, status: 400, error: '전략 유형이 올바르지 않습니다' };
      const n = String(name || (src ? src.name + ' 복사본' : KINDS[k] + ' 새 전략')).trim().slice(0, 30);
      if (!n) return { ok: false, status: 400, error: '이름을 입력하세요' };
      if (L.filter(r => !r.archived).length >= 20) return { ok: false, status: 400, error: '전략은 최대 20개까지 만들 수 있습니다(보관 제외)' };
      const id = `${k}-${now().toString(36)}`, ts = new Date(now()).toISOString();
      const row = { id, name: n, kind: k, desc: String(desc != null ? desc : (src ? src.desc : '')).slice(0, 200), enabled: false, archived: false, builtin: false, version: 1, params: src ? JSON.parse(JSON.stringify(src.params)) : defaults(k), ...(src && linkSource ? { source: src.id } : {}) };
      await writeRow(row, [{ key: 'init', label: '처음 만듦', from: '', to: src ? `${linkSource ? '실전에 적용' : '복제'}: ${src.name} v${src.version}` : '기본값' }], who, ts);
      cache = null;
      return { ok: true, strategy: { ...row, updatedAt: ts } };
    });
  }
  /* 보관(삭제): 기본 전략·켜진 전략은 안 됨. 기록은 남는다 */
  function archive(id, who) {
    return lock(async () => {
      const cur = (await list(true)).find(r => r.id === id);
      if (!cur) return { ok: false, status: 404, error: '전략을 찾을 수 없습니다' };
      if (cur.builtin) return { ok: false, status: 400, error: '기본 전략은 삭제할 수 없습니다. 끄기만 할 수 있어요' };
      if (cur.enabled) return { ok: false, status: 400, error: '켜진 전략은 삭제할 수 없습니다. 먼저 끄세요' };
      if (cur.archived) return { ok: true, unchanged: true };
      const ts = new Date(now()).toISOString();
      await writeRow({ ...cur, archived: true, version: cur.version + 1 }, [{ key: 'archived', label: '삭제(보관)', from: '', to: '보관함' }], who, ts);
      cache = null;
      return { ok: true };
    });
  }
  /* 종가 전략 독립(2026-11-19): 장중 조건을 아직 복사하지 않은 종가 전략을 한 번 저장(복사한 값·새 설명). 같은 입력이면 두 번 쓰지 않음 */
  async function migrateClosing(who = 'system') {
    if (missing) return { ok: true, n: 0 };
    const L = await list(true), out = [];
    for (const r of L.filter(x => x.kind === 'closing' && x.needCopy && !x.archived)) {
      const patch = { params: r.params, ...(CLOSE_DESC_OLD.test(r.desc || '') ? { desc: CLOSE_DESC } : {}) };
      const s = await save(r.id, patch, who, { force: true, onlyIfNeedCopy: true, note: { key: 'split', label: '종가베팅 독립', from: '장중 전략 조건을 함께 씀', to: '장중 기본 전략 조건을 복사해 따로 가짐(실행 모드 가상)' } });
      out.push({ id: r.id, ok: !!(s && s.ok), error: s && s.error });
    }
    return { ok: out.every(x => x.ok), n: out.length, out };
  }
  async function versions(id) {
    if (missing) return [];
    return sbGet(`auto_strategy_versions?select=version,changed,who,at&strategy_id=eq.${encodeURIComponent(id)}&order=version.desc&limit=50`).catch(() => []);
  }
  return { list, active, pair, actives, byId, save, create, archive, versions, migrateClosing, isMissing: () => missing, invalidate: () => { cache = null; }, sourceOk: () => SRC.has };
}

/* 화면용 스키마(JSON 그대로 보냄) */
const publicSchema = () => ({ kinds: KINDS, fields: SCHEMA, maxActive: MAX_ACTIVE });

const CLOSE_LETTER = 'N';   // 종가베팅 전략 글자(텔레그램 /매수 N1 · /정리 N1) — 장중 A~F 와 겹치지 않게
module.exports = { dryProgress, SCHEMA, KINDS, ENUM, BUILTIN, MAX_ACTIVE, LETTERS, CLOSE_LETTER, CLOSE_COPY, closingFromIntraday, sideOfParams, defaults, validate, diff, timesOf, tmin, hhmm, createStore, publicSchema };
