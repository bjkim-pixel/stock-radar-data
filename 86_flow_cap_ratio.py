"""종목별 외+기 누적 순매수 ÷ 그날 시총(3M/1M/1W) 사전 계산 — 86_flow_cap_ratio.sql 의 refresh_flow_cap_ratio() 호출.
사용: SUPABASE_DB_URL=... python 86_flow_cap_ratio.py [--report flowcap_report.md]"""
import os, sys, datetime, psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
REPORT = None
if "--report" in sys.argv:
    i = sys.argv.index("--report")
    REPORT = sys.argv[i + 1] if i + 1 < len(sys.argv) else "flowcap_report.md"
lines = []
def log(m=""):
    print(m, flush=True); lines.append(m)

def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    here = os.path.dirname(os.path.abspath(__file__))
    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute(open(os.path.join(here, "86_flow_cap_ratio.sql"), encoding="utf-8").read())
        conn.commit()
        cur.execute("select refresh_flow_cap_ratio()")
        n = cur.fetchone()[0]; conn.commit()
        log(f"# flow_cap_ratio 갱신 ({datetime.datetime.now():%Y-%m-%d %H:%M} UTC)")
        log(f"- 계산 종목 {n}개")
        cur.execute("select max(as_of), count(*) filter (where r_3m is null), count(*) filter (where r_1m is null), count(*) filter (where r_1w is null) from flow_cap_ratio")
        a, n3, n1, nw = cur.fetchone()
        log(f"- 기준일 {a} · 값 없음(시총·이력 부족): 3M {n3} / 1M {n1} / 1W {nw}")
        log("\n| code | name | 누적순매수 3M(억) | 3M % | 1M % | 1W % |\n|---|---|---|---|---|---|")
        cur.execute("""select f.code, s.name, f.a_3m/1e8, f.r_3m, f.r_1m, f.r_1w from flow_cap_ratio f join stocks s on s.code=f.code
                       where f.code in ('005930','000660','035420','005380','373220') order by f.code""")
        for c, nm, a3, r3, r1, rw in cur.fetchall():
            log(f"| {c} | {nm} | {a3:,.0f} | {r3} | {r1} | {rw} |")
        # ── 진단: 일별 시총/상장주식수 데이터 품질 + 방식 비교(누적금액÷그날시총 vs Σ일별 순매수÷시총) ──
        cur.execute("""select count(*) as codes,
                              count(*) filter (where n_sh > 1) as share_changed,
                              count(*) filter (where n_null > 0) as has_null_cap
                       from (select code, count(distinct listed_shares) as n_sh, count(*) filter (where market_cap is null or market_cap = 0) as n_null
                             from daily_price group by code) t""")
        c, ch, nn = cur.fetchone()
        log(f"\n## 일별 시총 데이터 점검\n- 종목 {c}개 · 기간 중 상장주식수가 바뀐 종목 {ch}개 · 시총 결측 행이 있는 종목 {nn}개")
        cur.execute("""select min(trade_date), max(trade_date), count(distinct trade_date) from daily_price""")
        log("- daily_price 기간/거래일: %s ~ %s / %s일" % cur.fetchone())
        cur.execute("""select count(*) filter (where abs(market_cap - close * listed_shares) > 0.02 * market_cap) , count(*)
                       from daily_price where market_cap > 0 and listed_shares > 0""")
        bad, tot = cur.fetchone()
        log(f"- 시총 ≠ 종가×상장주식수(오차 2%↑)인 행: {bad:,} / {tot:,}")
        log("\n## 방식 비교 (3개월 전=60거래일 전 시점, 순매수/시총 %)\n| 종목 | 현재 방식(누적금액÷그날시총) | 제안 방식(Σ 일별 순매수÷그날시총) | 시총 3M전(억) | 시총 오늘(억) | 주식수 최소~최대 |\n|---|---|---|---|---|---|")
        cur.execute("select trade_date from (select trade_date, row_number() over (order by trade_date desc)-1 as ago from (select distinct trade_date from daily_price) t) x where ago in (0,60) order by ago")
        d0, d60 = [r[0] for r in cur.fetchall()]
        cur.execute("""
            with fst as (select code, min(trade_date) f from daily_price where close>0 group by code),
            s as (select s.code, s.name from stocks s where s.name in ('오름테라퓨틱','달바글로벌','자이에스앤디','삼성전자','SK하이닉스','LG에너지솔루션')),
            agg as (select p.code,
                      sum((coalesce(fl.foreign_net,0)+coalesce(fl.inst_net,0))::numeric / nullif(p.market_cap,0)) filter (where p.trade_date > fst.f and p.trade_date <= %s) * 100 as new_r,
                      min(p.listed_shares) as sh_min, max(p.listed_shares) as sh_max,
                      max(p.market_cap) filter (where p.trade_date = %s) as cap60, max(p.market_cap) filter (where p.trade_date = %s) as cap0
                    from daily_price p join fst on fst.code = p.code
                    left join daily_flow fl on fl.code = p.code and fl.trade_date = p.trade_date
                    where p.code in (select code from s) group by p.code)
            select s.name, f.r_3m, agg.new_r, agg.cap60/1e8, agg.cap0/1e8, agg.sh_min, agg.sh_max
            from s join agg on agg.code = s.code left join flow_cap_ratio f on f.code = s.code order by s.name""", (d60, d60, d0))
        for nm, old_r, new_r, c60, c0, smin, smax in cur.fetchall():
            fm = lambda v, d=2: "–" if v is None else f"{float(v):,.{d}f}"
            log(f"| {nm} | {fm(old_r)} | {fm(new_r)} | {fm(c60,0)} | {fm(c0,0)} | {smin:,}~{smax:,} |")
    conn.close()
    if REPORT:
        open(REPORT, "w", encoding="utf-8").write("\n".join(lines))

if __name__ == "__main__":
    main()
