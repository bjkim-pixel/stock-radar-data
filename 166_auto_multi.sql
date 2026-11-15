-- 자동매매 컨트롤 타워 C단계(2026-11-16): 여러 전략 동시 실행 — auto_runs 를 (날짜, 전략) 한 행으로
update public.auto_runs set strategy_id = 'intraday-default' where strategy_id is null;
alter table public.auto_runs alter column strategy_id set default 'intraday-default';
alter table public.auto_runs alter column strategy_id set not null;
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.auto_runs'::regclass and contype = 'p'
             and array_length(conkey, 1) = 1) then
    execute (select 'alter table public.auto_runs drop constraint ' || quote_ident(conname) from pg_constraint where conrelid = 'public.auto_runs'::regclass and contype = 'p');
    alter table public.auto_runs add primary key (trade_date, strategy_id);
  end if;
end $$;
notify pgrst, 'reload schema';
