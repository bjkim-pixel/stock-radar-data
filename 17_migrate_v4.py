# -*- coding: utf-8 -*-
"""
STOCK RADAR · v4 신호엔진 스키마 마이그레이션 (1회성)
==========================================================
01_schema.sql은 `create table if not exists`라 이미 존재하는 테이블에 컬럼을
추가하지 못합니다. v4 엔진이 필요로 하는 컬럼·테이블만 따로 적용합니다.
전부 IF NOT EXISTS라 여러 번 실행해도 안전합니다.

추가되는 것
  sector_daily   rs20, rs_rank                     (업종 RS 상위 5위 조건)
  daily_metrics  vol_avg20_prev, vol_ratio20_prev  (전일까지 20일 평균 거래량)
                 high_all_prev, is_new_high_all    (상장 이후 누적 신고가)
                 nonpersonal_net                   (비개인 순매수)
                 weight_rank, cap_rank, pick_score (후보 우선순위)
  positions      (신규 테이블)                      트레일링 손절 판정용 포지션 상태

실행 후 05_compute.py를 전체 기간으로 다시 돌리면 v4 신호가 생성됩니다.

사용법
  python 17_migrate_v4.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

DDL = """
-- ── sector_daily: 업종 RS ────────────────────────────────────────────────────
alter table sector_daily add column if not exists rs20    numeric(14,6);
alter table sector_daily add column if not exists rs_rank integer;

-- ── daily_metrics: v4 지표 ───────────────────────────────────────────────────
alter table daily_metrics add column if not exists vol_avg20_prev   bigint;
alter table daily_metrics add column if not exists vol_ratio20_prev numeric(12,2);
alter table daily_metrics add column if not exists high_all_prev    bigint;
alter table daily_metrics add column if not exists is_new_high_all  boolean;
alter table daily_metrics add column if not exists nonpersonal_net  bigint;
alter table daily_metrics add column if not exists weight_rank      integer;
alter table daily_metrics add column if not exists cap_rank         integer;
alter table daily_metrics add column if not exists pick_score       numeric(10,2);

-- ── positions: 포지션 상태 ───────────────────────────────────────────────────
create table if not exists positions (
  id              bigserial primary key,
  portfolio       text not null default 'VIRTUAL',
  code            text not null references stocks(code) on delete cascade,
  status          text not null default 'OPEN',
  entry_date      date   not null,
  entry_price     bigint not null,
  avg_price       numeric(14,2) not null,
  quantity        bigint not null,
  invested        bigint not null,
  tranches        integer not null default 1,
  peak_price      bigint not null,
  peak_date       date,
  pyramid_blocked boolean default false,
  exit_date       date,
  exit_price      bigint,
  exit_reason     text,
  realized_pnl    bigint,
  return_pct      numeric(10,4),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_positions_open on positions (portfolio, status, code);
create index if not exists idx_positions_code on positions (code, entry_date desc);

drop trigger if exists trg_positions_updated on positions;
create trigger trg_positions_updated before update on positions
  for each row execute function set_updated_at();

alter table positions enable row level security;
drop policy if exists "public read" on positions;
create policy "public read" on positions for select using (true);
"""


def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")
        print("▶ v4 스키마 적용 중...")
        cur.execute(DDL)
        print("  ✅ DDL 적용 완료")

        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='daily_metrics' AND column_name IN
              ('vol_avg20_prev','vol_ratio20_prev','high_all_prev','is_new_high_all',
               'nonpersonal_net','weight_rank','cap_rank','pick_score')
            ORDER BY column_name
        """)
        cols = [r[0] for r in cur.fetchall()]
        print(f"\n  daily_metrics 신규 컬럼 {len(cols)}/8: {', '.join(cols)}")

        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='sector_daily' AND column_name IN ('rs20','rs_rank')
            ORDER BY column_name
        """)
        print(f"  sector_daily 신규 컬럼: {', '.join(r[0] for r in cur.fetchall())}")

        cur.execute("SELECT count(*) FROM positions")
        print(f"  positions 테이블 준비됨 (현재 {cur.fetchone()[0]}건)")

    conn.close()
    print(f"\n✅ 완료 ({time.time()-t0:.0f}초)")
    print("   다음 단계: Compute Metrics & Signals를 전체 기간으로 실행하세요.")


if __name__ == "__main__":
    main()
