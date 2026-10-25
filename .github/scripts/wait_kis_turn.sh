#!/usr/bin/env bash
# KIS REST 앱키 한도(초당 20건)를 지키기 위한 "순서 기다리기".
# GitHub concurrency group은 대기 중인 실행을 1개만 남기고 나머지를 취소하므로,
# 하루 한 번뿐인 NXT 수집이 다른 실행에 밀려 취소되지 않도록 NXT는 group 밖에서 이 스크립트로 차례를 기다린다.
# 사용: bash .github/scripts/wait_kis_turn.sh "daily_collect.yml global_collect.yml ..." [최대대기분=60]
# 나보다 먼저 시작해서 지금 실행 중인 해당 워크플로 실행이 있으면 끝날 때까지 30초 간격으로 기다린다(먼저 온 순서).
# GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID 필요. 조회 실패 시엔 기다리지 않고 진행.
set -u
WFS="$1"; MAX_MIN="${2:-60}"
ME_START=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq '.run_started_at' 2>/dev/null || echo "")
[ -z "$ME_START" ] && { echo "내 실행 시각 조회 실패 — 기다리지 않고 진행"; exit 0; }
DEADLINE=$(( $(date +%s) + MAX_MIN*60 ))
while :; do
  BUSY=""
  for wf in $WFS; do
    R=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$wf/runs?status=in_progress&per_page=20" \
        --jq ".workflow_runs[] | select(.id != $GITHUB_RUN_ID and .run_started_at < \"$ME_START\") | \"\(.name) #\(.id)\"" 2>/dev/null || true)
    [ -n "$R" ] && BUSY="$BUSY $R"
  done
  [ -z "$BUSY" ] && { echo "✅ 앞선 KIS 작업 없음 — 시작"; exit 0; }
  [ "$(date +%s)" -ge "$DEADLINE" ] && { echo "::warning::${MAX_MIN}분 기다려도 끝나지 않아 그대로 진행:$BUSY"; exit 0; }
  echo "⏳ 앞선 KIS 작업 실행 중 —$BUSY · 30초 후 다시 확인"; sleep 30
done
