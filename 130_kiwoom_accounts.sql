-- 130_kiwoom_accounts.sql — 키움증권 HTS 1331 "회원 보유 계좌수" 스냅샷 (매집 종목 페이지용, 2026-11-08)
-- 사용자가 엑셀(data/kiwoom_accounts.xlsx)을 가끔 수동으로 갱신 → 130_kiwoom_accounts_import.py 가 날짜별로 upsert.
create table if not exists kiwoom_accounts (
  code      text    not null,
  snap_date date    not null,
  accounts  integer not null,
  name      text,
  market    text,
  primary key (code, snap_date)
);
-- 화면용: 종목당 1행, 날짜별 계좌수를 jsonb({"2026-06-19":5020,...})로 묶음
create or replace view v_kiwoom_accounts as
select code, max(name) as name, max(market) as market,
       jsonb_object_agg(snap_date::text, accounts) as snaps
from kiwoom_accounts group by code;

alter table kiwoom_accounts enable row level security;
drop policy if exists "public read" on kiwoom_accounts;
create policy "public read" on kiwoom_accounts for select using (true);
do $$ begin
  revoke insert, update, delete, truncate, trigger, references on kiwoom_accounts from anon, authenticated;
  grant select on kiwoom_accounts to anon, authenticated;
  grant select on v_kiwoom_accounts to anon, authenticated;
exception when undefined_object then raise notice 'anon 롤 없음 — 건너뜀';
end $$;
