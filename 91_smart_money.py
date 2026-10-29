# -*- coding: utf-8 -*-
"""스마트머니 매집·분산 국면/신호 계산 → smart_money_state / smart_money_signal 저장.

사용:
  SUPABASE_DB_URL=... python 91_smart_money.py [--report sm_report.md] [--backtest] [--dry-run]
    --backtest : 신호별 이후 5·20·60거래일 성과(전 종목 평균 대비 초과수익)와 SM 구성·구간 비교를 리포트에 추가
    --dry-run  : DB에 쓰지 않음(리포트만)
계산 로직은 sm_core.py (화면 smSeries()와 동일).
"""
import os, sys, math, datetime, statistics
from collections import defaultdict
import psycopg2
from psycopg2.extras import execute_values
import sm_core as smc

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
REPORT = None
if "--report" in sys.argv:
    i = sys.argv.index("--report")
    REPORT = sys.argv[i + 1] if i + 1 < len(sys.argv) else "sm_report.md"
BACKTEST = "--backtest" in sys.argv
DRY = "--dry-run" in sys.argv
lines = []
def log(m=""):
    print(m, flush=True); lines.append(m)

SUBJ_COLS = ("foreign", "inst", "fin_inv", "inv_trust", "pension", "pe", "individual", "corp_other")
PH_KR = {"NEUTRAL": "중립", "ACC": "①매집", "MARKUP": "②상승", "DIST": "③분산", "DOWN": "④이탈"}


def load(cur):
    cur.execute("""
      select p.code, p.trade_date, p.open, p.close, p.high, p.low, p.volume, p.trade_amount, p.market_cap,
             coalesce(f.foreign_net,0), coalesce(f.inst_net,0), coalesce(f.fin_inv_net,0), coalesce(f.inv_trust_net,0),
             coalesce(f.pension_net,0), coalesce(f.pe_net,0), coalesce(f.individual_net,0), coalesce(f.corp_other_net,0)
      from daily_price p
      join stocks s on s.code = p.code and s.security_type = 'STOCK'
      left join daily_flow f on f.trade_date = p.trade_date and f.code = p.code
      where p.close > 0
      order by p.code, p.trade_date""")
    by = defaultdict(list)
    for t in cur:
        code = t[0]
        d = dict(date=t[1], open=t[2], close=t[3], high=t[4], low=t[5], volume=t[6], trade_amount=t[7], market_cap=t[8])
        for k, v in zip(SUBJ_COLS, t[9:]):
            d[k] = float(v)
        by[code].append(d)
    return by


def with_sm(rows, subj):
    for r in rows:
        r["sm"] = sum(r[k] for k in subj)
        r["ind"] = r["individual"]
    return rows


def pctile(vals):
    """값 → 0..1 백분위 (작은 값 0, 큰 값 1)."""
    s = sorted(vals)
    n = len(s)
    if n <= 1:
        return lambda v: 0.5
    import bisect
    return lambda v: bisect.bisect_left(s, v) / (n - 1) if n > 1 else 0.5


def compute_all(by, subj, W):
    res = {}
    for code, rows in by.items():
        if len(rows) < 20:
            continue
        res[code] = smc.sm_series(with_sm(rows, subj), W)
    return res


def build_state(by, series, meta, sector, last_day):
    cand = {c: s for c, s in series.items() if s[-1]["date"] == last_day}
    p_d = pctile([s[-1]["dW"] for s in cand.values()])
    p_s = pctile([-s[-1]["d20"] for s in cand.values()])
    out = []
    for code, s in cand.items():
        z = s[-1]; prev = s[-2] if len(s) >= 2 else z
        bs, ba, bd = smc.last_signal(s, smc.VALID_BUY)
        ss, sa, sd = smc.last_signal(s, smc.VALID_SELL)
        buy = (smc.recency_pts(ba) + 30 * p_d(z["dW"]) + 15 * z["buy20"] / 20 + smc.gap_pts(z["gap"])) if (ba is not None and ba <= 4) else None
        sell = (smc.recency_pts(sa) + 30 * p_s(-z["d20"]) + 15 * (z["transfer"] or 0)
                + 15 * min(max(z["gap"] or 0, 0) / 0.5, 1)) if (sa is not None and sa <= 4) else None
        r0 = by[code][-1]
        nm, mk = meta.get(code, (code, None))
        rnd = lambda v, d: None if v is None or (isinstance(v, float) and math.isnan(v)) else round(v, d)
        out.append((code, nm, mk, sector.get(code), z["date"], int(r0["close"]), r0["trade_amount"],
                    z["phase"], z["phase_days"], prev["phase"], z["phase"] != prev["phase"], z["quiet"],
                    rnd(z["dW"], 3), rnd(z["d20"], 3), rnd(z["indW"], 3), rnd(z["hold_pct"], 3), rnd(z["peak_pct"], 3),
                    rnd(z["cost"], 2), rnd(z["gap"], 4), z["buy20"], rnd(z["transfer"], 4), rnd(z["retW"], 4),
                    bs, ba, bd, ss, sa, sd, rnd(buy, 1), rnd(sell, 1)))
    return out


def backtest(by, series, regime, label):
    """신호 다음 날 시가 진입 → 5·20·60거래일 후 종가. 같은 진입일 전 종목 평균 대비 초과수익."""
    H = (5, 20, 60)
    base = defaultdict(lambda: defaultdict(list))   # date → h → [ret]
    fwd = {}
    for code, rows in by.items():
        n = len(rows)
        fr = []
        for k in range(n):
            e = None
            if k + 1 < n:
                e = float(rows[k + 1]["open"] or 0) or float(rows[k + 1]["close"])
            rr = {}
            for h in H:
                if e and k + h < n:
                    rr[h] = float(rows[k + h]["close"]) / e - 1
                    base[rows[k]["date"]][h].append(rr[h])
            fr.append(rr)
        fwd[code] = fr
    bmean = {d: {h: statistics.fmean(v) for h, v in hs.items() if v} for d, hs in base.items()}
    ev = defaultdict(lambda: defaultdict(list))   # (signal, period) → h → [(ret, exc)]
    ph = defaultdict(list)                          # phase → [exc20]
    for code, s in series.items():
        fr = fwd[code]
        for k, z in enumerate(s):
            d = z["date"]
            per = "검증(2026-06~)" if d >= datetime.date(2026, 6, 1) else "학습(~2026-05)"
            if 20 in fr[k] and 20 in bmean.get(d, {}):
                ph[z["phase"]].append(fr[k][20] - bmean[d][20])
            for sg in z["signals"]:
                for h in H:
                    if h in fr[k] and h in bmean.get(d, {}):
                        x = (fr[k][h], fr[k][h] - bmean[d][h])
                        ev[(sg, "전체")][h].append(x); ev[(sg, per)][h].append(x)
                        ev[(sg, "레짐 " + regime.get(d, "?"))][h].append(x)
    pc = lambda v: f"{v * 100:+.2f}%"
    log(f"\n## 백테스트 · {label}")
    log("다음 날 시가 진입, h거래일 후 종가. 초과 = 같은 날 전 종목 평균 대비. 매수 신호는 초과가 클수록, 매도 신호는 초과가 작을수록(음수) 좋음.\n")
    log("| 신호 | 구간 | n(20일) | 5일 평균 | 20일 평균 | 20일 초과 | 20일 초과 승률 | 60일 초과 |\n|---|---|---|---|---|---|---|---|")
    order = ["B1", "B2", "S1", "S2", "S3", "S4"]
    for sg in order:
        keys = sorted([k for k in ev if k[0] == sg], key=lambda k: (k[1] != "전체", k[1]))
        for k in keys:
            hs = ev[k]
            if not hs.get(20):
                continue
            m5 = statistics.fmean(x[0] for x in hs[5]) if hs.get(5) else float("nan")
            m20 = statistics.fmean(x[0] for x in hs[20]); e20 = statistics.fmean(x[1] for x in hs[20])
            w20 = sum(1 for x in hs[20] if x[1] > 0) / len(hs[20])
            e60 = statistics.fmean(x[1] for x in hs[60]) if hs.get(60) else float("nan")
            log(f"| {sg} | {k[1]} | {len(hs[20])} | {pc(m5)} | {pc(m20)} | {pc(e20)} | {w20 * 100:.0f}% | {pc(e60) if not math.isnan(e60) else '–'} |")
    log("\n**국면별 이후 20일 초과수익 (매일 기준)**\n\n| 국면 | 표본(종목·일) | 20일 초과 평균 |\n|---|---|---|")
    for p in ("ACC", "MARKUP", "DIST", "DOWN", "NEUTRAL"):
        v = ph.get(p) or []
        if v:
            log(f"| {PH_KR[p]} | {len(v):,} | {pc(statistics.fmean(v))} |")
    return ev


def summary_compare(rows_by_label):
    log("\n## SM 구성·판정 구간 비교 (전체 기간, 20일 초과수익)\n\n| 구성 | B1 n | B1 초과 | B2 n | B2 초과 | S1 n | S1 초과 | S2 초과 |\n|---|---|---|---|---|---|---|---|")
    for label, ev in rows_by_label:
        cells = []
        for sg in ("B1", "B2", "S1", "S2"):
            hs = ev.get((sg, "전체"), {}).get(20) or []
            m = f"{statistics.fmean(x[1] for x in hs) * 100:+.2f}%" if hs else "–"
            cells += ([str(len(hs)), m] if sg != "S2" else [m])
        log(f"| {label} | " + " | ".join(cells) + " |")


def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    here = os.path.dirname(os.path.abspath(__file__))
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    if not DRY:
        cur.execute(open(os.path.join(here, "91_smart_money.sql"), encoding="utf-8").read())
        conn.commit()
    t0 = datetime.datetime.now()
    by = load(cur)
    cur.execute("select code, name, market from stocks")
    meta = {c: (n, m) for c, n, m in cur.fetchall()}
    cur.execute("select code, sector from v_stock_sector")
    sector = dict(cur.fetchall())
    cur.execute("select trade_date, regime from market_daily where market = 'KOSPI'")
    regime = {d: (g or "?") for d, g in cur.fetchall()}
    last_day = max(r[-1]["date"] for r in by.values())
    series = compute_all(by, smc.DEFAULT_SUBJ, 120)
    state = build_state(by, series, meta, sector, last_day)
    sigs = [(code, z["date"], sg, int(z["close"]), z["phase"]) for code, s in series.items() for z in s for sg in z["signals"]]
    log(f"# 스마트머니 국면 계산 · 기준일 {last_day}")
    log(f"- 종목 {len(state):,}개 · 신호 이력 {len(sigs):,}건 · 계산 {(datetime.datetime.now() - t0).seconds}초 · SM = 외국인+투신+사모+연기금, 120일")
    cnt = defaultdict(int); chg = defaultdict(int)
    for r in state:
        cnt[r[7]] += 1
        if r[10]:
            chg[r[7]] += 1
    log("- 국면 분포: " + " · ".join(f"{PH_KR[p]} {cnt[p]}(오늘 +{chg[p]})" for p in ("ACC", "MARKUP", "DIST", "DOWN", "NEUTRAL")))
    today = defaultdict(int)
    for s in sigs:
        if s[1] == last_day:
            today[s[2]] += 1
    log("- 오늘 신호: " + (" · ".join(f"{k} {v}" for k, v in sorted(today.items())) or "없음"))
    top = sorted([r for r in state if r[28] is not None], key=lambda r: -r[28])[:10]
    log("\n**매수 후보 Top 10**: " + ", ".join(f"{r[1]}({r[22]}·{r[28]})" for r in top))
    top = sorted([r for r in state if r[29] is not None], key=lambda r: -r[29])[:10]
    log("\n**매도 경고 Top 10**: " + ", ".join(f"{r[1]}({r[25]}·{r[29]})" for r in top))

    if not DRY:
        cur.execute("truncate smart_money_state; truncate smart_money_signal;")
        execute_values(cur, """insert into smart_money_state (code,name,market,sector,as_of,close,trade_amount,phase,phase_days,phase_prev,
            changed_today,quiet,d_w,d_20,ind_w,hold_pct,peak_pct,cost,gap,buy_days20,transfer20,ret_w,
            buy_sig,buy_sig_ago,buy_sig_date,sell_sig,sell_sig_ago,sell_sig_date,buy_score,sell_score) values %s""", state, page_size=1000)
        execute_values(cur, "insert into smart_money_signal (code,trade_date,signal,close,phase) values %s on conflict do nothing", sigs, page_size=2000)
        conn.commit()
        log("- 저장 완료 (smart_money_state, smart_money_signal)")

    if BACKTEST:
        evs = [("A 외국인+투신+사모+연기금 · 120일 (기본)", backtest(by, series, regime, "A 외국인+투신+사모+연기금 · 120일 (기본)"))]
        for label, subj, W in (("A 같은 구성 · 60일", smc.DEFAULT_SUBJ, 60),
                               ("B 외국인+기관합계 · 120일", ("foreign", "inst"), 120),
                               ("C 외국인만 · 120일", ("foreign",), 120),
                               ("D 투신+사모 · 120일", ("inv_trust", "pe"), 120)):
            s2 = compute_all(by, subj, W)
            lines_before = len(lines)
            ev = backtest(by, s2, regime, label)
            del lines[lines_before:]          # 상세표는 기본 구성만 — 비교표로 요약
            evs.append((label, ev))
        summary_compare(evs)
    conn.close()
    if REPORT:
        open(REPORT, "w", encoding="utf-8").write("\n".join(lines))


if __name__ == "__main__":
    main()
