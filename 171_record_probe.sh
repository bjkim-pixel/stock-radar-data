#!/bin/bash
set -e
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f 171_record_days.sql
{
echo "# 기록일 뷰 점검"
echo '```'
psql "$SUPABASE_DB_URL" -c "select count(*) rows, min(trade_date), max(trade_date), count(distinct code) codes from daily_flow"
psql "$SUPABASE_DB_URL" -c "select count(*) rows, min(trade_date), max(trade_date), count(distinct code) codes from daily_price"
for q in "select count(*), min(trade_date) from record_wt where trade_date >= current_date - 31" "select count(*) from record_flow where subj='combo' and trade_date >= current_date - 31"; do
  /usr/bin/time -f "  %es" psql "$SUPABASE_DB_URL" -c "\\timing on" -c "$q" 2>&1
done
echo '```'
} > record_probe.md
