# -*- coding: utf-8 -*-
"""
STOCK RADAR · DB 용량 절감 (1회성)
======================================
Supabase 무료 플랜 500MB 한도(710MB로 이미 초과) 대응. 09_size_audit.py
결과와 사용자 확인을 바탕으로 다음을 실행합니다.

  1) v_daily 뷰를 amt_cap_ratio/corp_other_net 없이 재정의
     (컬럼 삭제 전에 먼저 해야 뷰가 깨지지 않음)
  2) daily_price.amt_cap_ratio 컬럼 삭제 (미사용 GENERATED 컬럼)
  3) daily_flow.bank_net·insurance_net 삭제 (수집된 적 없는 완전 빈 컬럼)
  4) daily_flow.corp_other_net·foreign_net_vol·inst_net_vol 삭제
     (실제 값은 있으나 신호 엔진 미사용 — 이후 복구 불가, 사용자 확인됨)
  5) idx_price_date·idx_metrics_date·idx_flow_date 삭제
     (PK가 이미 trade_date로 시작해 중복)
  6) daily_metrics/signals에서 2026-01-01 이전 행 삭제 (방어적 — 현재는
     디스크풀로 실패한 실행이 롤백되어 2025년치가 애초에 없을 가능성이 높음)

⚠ 컬럼 삭제는 카탈로그만 바꿀 뿐 즉시 디스크 공간을 돌려주지 않습니다
  (다음 VACUUM FULL 또는 자연스러운 행 재작성 때 회수됨). 그래서 이
  스크립트만으로 당장 500MB 밑으로 내려가진 않을 수 있습니다 — 정확한
  전후 크기를 찍어서 확인합니다.

이 스크립트를 실행한 뒤에는 03_daily_collect.py / 04_backfill.py도 같은
커밋으로 함께 올라간 새 버전이어야 합니다(컬럼이 없어진 daily_flow에
옛 버전 스크립트가 INSERT하면 에러납니다).

사용법
  python 10_reduce_size.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

TABLES = ["daily_price", "daily_flow", "daily_metrics", "market_daily", "sector_daily", "signals"]

V_DAILY_SQL = """
create or replace view v_daily as
select
  p.trade_date, p.code, s.name, s.market,
  s.sector_krx, s.sector_kis, s.security_type,
  p.close, p.change_pct, p.volume, p.trade_amount,
  p.market_cap, p.listed_shares,
  p.weight_per_share,
  f.foreign_net, f.inst_net, f.smart_net,
  f.fin_inv_net, f.inv_trust_net, f.pension_net, f.pe_net,
  f.individual_net,
  m.ma5, m.ma20, m.ma60, m.ma_aligned,
  m.amt_ratio20, m.vol_ratio20,
  m.is_new_high, m.near_high, m.high_label, m.pct_from_high, m.data_span_days,
  m.foreign_cum5, m.inst_cum5, m.smart_cum5, m.smart_cum5_cap_pct,
  m.flow_lead, m.consec_both_buy, m.inst_lead_field,
  k.accounts, k.avg_buy_price, k.return_pct as kiwoom_return_pct
from daily_price p
join      stocks              s on s.code = p.code
left join daily_flow          f on f.trade_date = p.trade_date and f.code = p.code
left join daily_metrics       m on m.trade_date = p.trade_date and m.code = p.code
left join kiwoom_holder_stats k on k.trade_date = p.trade_date and k.code = p.code;
"""


def sizes(cur, label):
    cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
    print(f"\n{label} — DB 전체: {cur.fetchone()[0]}")
    cur.execute("""
        SELECT relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup
        FROM pg_stat_user_tables
        WHERE relname = ANY(%s)
        ORDER BY pg_total_relation_size(relid) DESC
    """, (TABLES,))
    for row in cur.fetchall():
        print(f"  {row[0]:<16} {row[1]:>10}   rows={row[2]:,}")


def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")
        sizes(cur, "▶ 정리 전")

        print("\n[1/6] v_daily 뷰 재정의 (amt_cap_ratio·corp_other_net 제외)...")
        cur.execute(V_DAILY_SQL)
        print("  ✅ 완료")

        print("\n[2/6] daily_price.amt_cap_ratio 컬럼 삭제...")
        cur.execute("ALTER TABLE daily_price DROP COLUMN IF EXISTS amt_cap_ratio")
        print("  ✅ 완료")

        print("\n[3/6] daily_flow.bank_net·insurance_net 삭제 (빈 컬럼)...")
        cur.execute("ALTER TABLE daily_flow DROP COLUMN IF EXISTS bank_net")
        cur.execute("ALTER TABLE daily_flow DROP COLUMN IF EXISTS insurance_net")
        print("  ✅ 완료")

        print("\n[4/6] daily_flow.corp_other_net·foreign_net_vol·inst_net_vol 삭제...")
        cur.execute("ALTER TABLE daily_flow DROP COLUMN IF EXISTS corp_other_net")
        cur.execute("ALTER TABLE daily_flow DROP COLUMN IF EXISTS foreign_net_vol")
        cur.execute("ALTER TABLE daily_flow DROP COLUMN IF EXISTS inst_net_vol")
        print("  ✅ 완료")

        print("\n[5/6] 중복 단일컬럼 인덱스 삭제 (idx_price_date/idx_metrics_date/idx_flow_date)...")
        cur.execute("DROP INDEX IF EXISTS idx_price_date")
        cur.execute("DROP INDEX IF EXISTS idx_metrics_date")
        cur.execute("DROP INDEX IF EXISTS idx_flow_date")
        print("  ✅ 완료")

        print("\n[6/6] daily_metrics/signals에서 2026년 이전 행 삭제 (방어적)...")
        cur.execute("DELETE FROM daily_metrics WHERE trade_date < '2026-01-01'")
        print(f"  daily_metrics: {cur.rowcount:,}행 삭제")
        cur.execute("DELETE FROM signals WHERE trade_date < '2026-01-01'")
        print(f"  signals: {cur.rowcount:,}행 삭제")

        print("\n▶ VACUUM (죽은 행 공간 회수 — 컬럼 삭제분은 다음 VACUUM FULL 전까지 못 돌려받음)")
        for t in ("daily_price", "daily_flow", "daily_metrics", "signals"):
            cur.execute(f"VACUUM (ANALYZE) {t}")
        print("  ✅ 완료")

        sizes(cur, "▶ 정리 후")

    conn.close()
    print(f"\n✅ 전체 완료 ({time.time()-t0:.0f}초)")
    print("   ⚠ 컬럼 삭제로 인한 heap 공간은 VACUUM FULL 전까진 완전히 반영 안 될 수 있습니다.")


if __name__ == "__main__":
    main()
