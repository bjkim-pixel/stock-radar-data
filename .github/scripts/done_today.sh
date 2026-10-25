#!/usr/bin/env bash
# 오늘(KST) 이 워크플로가 '실제로' 끝까지 한 번 이상 성공했는지 센다 — 건너뛴(skip) 실행은 제외.
# 판단 기준: 지정한 이름의 단계(step)가 success로 끝난 실행 수(현재 실행 제외). 결과 숫자를 출력.
# 사용: bash .github/scripts/done_today.sh <workflow파일> "<단계 이름>"
set -u
WF="$1"; STEP="$2"
TODAY=$(TZ=Asia/Seoul date +%F)
SINCE=$(date -u -d "TZ=\"Asia/Seoul\" $TODAY 00:00" +%Y-%m-%dT%H:%M:%SZ)
IDS=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$WF/runs?created=>=$SINCE&per_page=30" \
      --jq ".workflow_runs[] | select(.id != ${GITHUB_RUN_ID:-0} and .conclusion == \"success\") | .id" 2>/dev/null || true)
N=0
for id in $IDS; do
  OK=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs" \
       --jq "[.jobs[].steps[]? | select(.name == \"$STEP\" and .conclusion == \"success\")] | length" 2>/dev/null || echo 0)
  [ "${OK:-0}" -gt 0 ] && N=$((N+1))
done
echo "$N"
