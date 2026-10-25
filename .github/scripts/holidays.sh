#!/usr/bin/env bash
# .github/holidays.txt 의 휴장일을 공백으로 구분해 한 줄로 출력합니다. (워크플로: HOLIDAYS="$(bash .github/scripts/holidays.sh)")
# 올해 날짜가 목록에 하나도 없으면 목록을 깜빡한 것이므로 경고를 남깁니다(휴장일을 거래일로 착각하고 돌게 되므로).
F="$(dirname "$0")/../holidays.txt"
LIST=$(sed 's/#.*//' "$F" | tr -s ' \t\r\n' ' ')
YEAR=$(TZ=Asia/Seoul date +%Y)
case " $LIST " in
  *" $YEAR-"*) ;;
  *) echo "::warning::.github/holidays.txt 에 ${YEAR}년 휴장일이 없습니다 — 공휴일에도 수집이 돌 수 있으니 목록을 추가하세요" >&2 ;;
esac
echo "$LIST"
