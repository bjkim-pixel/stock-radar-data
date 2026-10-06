-- ============================================================================
-- STOCK RADAR · 업종 클러스터 감지 (v_sector_cluster)
-- ============================================================================
-- 2026-09-30: 짝꿍매매 백테스트(8/10 기계·장비 테스·주성엔지니어링·브이엠 동반
-- 급등 사례로 검증)에서 확인된 패턴 — "같은 업종에서 여러 종목이 같은 날 동시에
-- +5%↑ 급등하면서 같은 수급주체(외국인 또는 기관)가 순매수"하는 현상을 매일
-- 자동으로 감지하는 뷰입니다.
--
-- 짝꿍(2종목) 단위로 자동 매칭하려던 시도는 백테스트에서 매번 다른 종류의
-- 착시(원래 변동성 큰 종목이 상위 독식 / 한 번의 섹터 랠리를 여러 쌍으로
-- 중복 집계)가 나와서, 대신 "업종 전체 클러스터"를 감지해서 보여주고 실제
-- 짝꿍 판단은 사용자가 하는 방식으로 전환했습니다.
--
-- 기준: 같은 업종에서 4종목 이상이 당일 +5%↑ 이면서 외국인 또는 기관(또는
-- 둘 다) 순매수. 날짜 필터 없이 전 기간 계산 — 화면에서 최신 날짜만 걸러서
-- 씁니다.
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

drop view if exists v_sector_cluster;
create view v_sector_cluster
with (security_invoker = true) as
with flagged as (
  select p.trade_date, s.sector_krx, p.code, s.name, p.change_pct,
         (f.foreign_net > 0) as foreign_buy,
         (f.inst_net    > 0) as inst_buy
  from daily_price p
  join stocks s on s.code = p.code and s.security_type = 'STOCK'
  left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
  where p.change_pct >= 5
    and s.sector_krx is not null
)
select trade_date, sector_krx,
  count(*) filter (where foreign_buy)                              as foreign_cnt,
  array_agg(name order by change_pct desc) filter (where foreign_buy) as foreign_names,
  array_agg(code order by change_pct desc) filter (where foreign_buy) as foreign_codes,
  count(*) filter (where inst_buy)                                 as inst_cnt,
  array_agg(name order by change_pct desc) filter (where inst_buy)  as inst_names,
  array_agg(code order by change_pct desc) filter (where inst_buy)  as inst_codes
from flagged
group by trade_date, sector_krx
having count(*) filter (where foreign_buy) >= 4 or count(*) filter (where inst_buy) >= 4
order by trade_date desc,
  greatest(count(*) filter (where foreign_buy), count(*) filter (where inst_buy)) desc;

comment on view v_sector_cluster is
  '업종 내 동반 급등 클러스터 감지 — 같은 업종 4종목 이상이 당일 +5%↑ & 같은 수급주체(외국인/기관) 순매수. 날짜 필터 없이 전 기간, 화면에서 최신일만 조회.';

do $$
begin
  grant select on v_sector_cluster to anon, authenticated;
exception when undefined_object then
  raise notice 'anon/authenticated 롤 없음 — 로컬 테스트 환경으로 보고 건너뜁니다';
end $$;

-- ── 확인 ──────────────────────────────────────────────────────────────────
select trade_date, sector_krx, foreign_cnt, inst_cnt, foreign_names, inst_names
from v_sector_cluster
order by trade_date desc
limit 20;
