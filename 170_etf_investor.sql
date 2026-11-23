-- ETF 투자자별 수급(KIS 종목별 투자자 일별, 과거 30거래일) + NAV 괴리율 이력
create table if not exists etf_investor_daily (
  d        date not null,
  etf_code text not null,
  prsn_qty bigint, frgn_qty bigint, orgn_qty bigint,           -- 순매수 수량(좌)
  prsn_amt bigint, frgn_amt bigint, orgn_amt bigint,           -- 순매수 금액(원)
  scrt_amt bigint, ivtr_amt bigint, pe_amt bigint, bank_amt bigint, insu_amt bigint, fund_amt bigint,  -- 기관 세부(금융투자·투신·사모·은행·보험·연기금)
  primary key (d, etf_code)
);
create index if not exists idx_etf_inv_code on etf_investor_daily (etf_code, d desc);
alter table etf_flow_daily add column if not exists dprt numeric(8,3);   -- 괴리율(%)
alter table etf_investor_daily enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='etf_investor_daily' and policyname='public read') then
    create policy "public read" on etf_investor_daily for select using (true); end if;
end $$;
grant select on etf_investor_daily to anon, authenticated;
