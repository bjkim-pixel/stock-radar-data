-- ============================================================================
-- STOCK RADAR · positions 테이블 컬럼 보정 (quantity 등 누락 컬럼 추가)
-- ============================================================================
-- compute 워크플로 오류: 06_portfolio.py가
--   SELECT code, entry_date, entry_price, quantity, invested, tranches,
--          pyramid_blocked FROM positions ...
-- 를 실행하다가 psycopg2.errors.UndefinedColumn: column "quantity" does not
-- exist 로 실패했습니다.
--
-- 원인: 01_schema.sql / 17_migrate_v4.py는 둘 다
--   create table if not exists positions (...)
-- 로 되어 있어서, positions 테이블이 (어떤 이유로든) 이미 존재하면 그 안의
-- 컬럼 구성을 절대 바꾸지 못합니다 — CREATE TABLE IF NOT EXISTS는 테이블이
-- 있으면 완전히 무시되는 문 입니다. 즉 지금 DB의 positions 테이블은 05_metrics/
-- 06_signals와 무관하게, quantity 컬럼이 없는 상태로 이미 만들어져 있었던
-- 것으로 보입니다(오늘 sector_override 작업과는 무관한 기존 문제입니다).
--
-- 이 파일은 누락된 컬럼을 전부 ALTER ... ADD COLUMN IF NOT EXISTS로 보충합니다.
-- 이미 데이터가 있을 수 있으므로 NOT NULL은 강제하지 않습니다(앱은 항상 값을
-- 채워서 넣으므로 실사용에는 문제없습니다). 여러 번 실행해도 안전합니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기
-- ============================================================================

create table if not exists positions (
  id  bigserial primary key
);

alter table positions add column if not exists portfolio       text not null default 'VIRTUAL';
alter table positions add column if not exists code            text references stocks(code) on delete cascade;
alter table positions add column if not exists status          text not null default 'OPEN';
alter table positions add column if not exists entry_date      date;
alter table positions add column if not exists entry_price     bigint;
alter table positions add column if not exists avg_price       numeric(14,2);
alter table positions add column if not exists quantity        bigint;
alter table positions add column if not exists invested        bigint;
alter table positions add column if not exists tranches        integer not null default 1;
alter table positions add column if not exists peak_price      bigint;
alter table positions add column if not exists peak_date       date;
alter table positions add column if not exists pyramid_blocked boolean default false;
alter table positions add column if not exists exit_date       date;
alter table positions add column if not exists exit_price      bigint;
alter table positions add column if not exists exit_reason     text;
alter table positions add column if not exists realized_pnl    bigint;
alter table positions add column if not exists return_pct      numeric(10,4);
alter table positions add column if not exists created_at      timestamptz default now();
alter table positions add column if not exists updated_at      timestamptz default now();

comment on table  positions                 is 'v4 트레일링 손절 판정을 위한 포지션 상태. VIRTUAL은 엔진이 자동 운용(매 실행 시 재생성), REAL은 사용자 기록';
comment on column positions.entry_price     is '최초 매수가. 불타기 트리거(+14%/+28%/+42%)는 평균단가가 아니라 이 값 기준';
comment on column positions.peak_price      is '매수 이후 갱신되는 보유 중 최고 종가. 당일종가/peak-1 <= -7%면 전량 매도';
comment on column positions.pyramid_blocked is 'v4 스펙: 과거에 -7% 손절이 발동된 적 있는 종목은 재진입 후 불타기 안 함';

create index if not exists idx_positions_open on positions (portfolio, status, code);
create index if not exists idx_positions_code on positions (code, entry_date desc);

drop trigger if exists trg_positions_updated on positions;
create trigger trg_positions_updated before update on positions
  for each row execute function set_updated_at();

alter table positions enable row level security;
drop policy if exists "public read" on positions;
create policy "public read" on positions for select using (true);

do $$
begin
  grant select on positions to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
-- 실행 후 아래로 컬럼이 전부 있는지 확인하세요.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'positions'
order by ordinal_position;
