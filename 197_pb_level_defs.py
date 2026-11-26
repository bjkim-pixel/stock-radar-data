# -*- coding: utf-8 -*-
"""[197] 눌림목 1·2위일 정의 비교(읽기 전용) — 절대/상대(평균 대비 몇 배) 무게 하한 · 앱식 vs 최근 3개월 최대 2개.
(아래는 195 설명) 눌림목 새 규칙 과거 검증(읽기 전용, 2026-11-26) — "무게/주식수 1·2위일 가격 회복"
 시점 일치(point-in-time): t 일 15:10 에 아는 자료(t−1 일까지)만 써서 그때의 1위일(최대 무게일)·2위일(1위일 뒤 최대 무게일)을 다시 정한다. record_wt(오늘 기준 최종값) 는 쓰지 않음.
 규칙: 1·2위일이 [t−MAXAGE, t−2] 안 · 무게 ≥ WMIN · 시총(t−1) ≥ 1천억 · 기준가 = 그날 거래대금÷거래량
       눌림(무장) = 그 뒤 종가가 기준가×(1−DIP%) 아래로 내려간 적이 있고, 그 뒤 기준가×(1+1%) 위로 마감해 되찾은 적은 없음(DIP=0 이면 "얼마나 내려갔는지 상관없이 기준가 아래였던 적")
       수급 점검 = 종목상세 스마트머니(135_smx_state.py 와 같은 계산) 1개월·3개월 둘 다 CONT/STALL · 주도 세력 추세 DOWN/TURN 아님
       매수 = t 일 종가(15:10 근사)가 기준가 +1%~+6% → 종가 매수
 매도(전략 기본값): 매수가 −5% 아래 종가 마감 손절 · +8%(50%)/+12%(50%) 익절(장중 고가) · 1단계 뒤 손절 본전+0.35% · 10거래일째 종가 청산(인자 nolimit 이면 시간 청산 없음 — 손절 −5/−8/−10% 비교) · 왕복 비용 0.25%
 일봉 모의: 같은 날 익절(고가)을 먼저 보고, 종가 손절은 그날 마감 때 판정."""
import os, sys, time, collections, numpy as np, pandas as pd
T0 = time.time(); EOK = 1e8; COST = 0.25
_nl = 'nolimit' in sys.argv[1:]   # 시간 청산 없음: 손절·익절로만 나감(자료 끝까지 안 나가면 마지막 종가로 평가)
WMIN, MAXAGE, BRK, CHASE, CAPMIN, HOLD, STOP = 0.1, 63, 1.0, 6.0, 1000 * EOK, 10 ** 6, 5.0
TP15 = True; NOLIM = True; STOPS = (5.0,)
_unused = 'tp15' in sys.argv[1:]   # 익절 손익비 1:2·1:3 — +10%(50%) / +15%(50%, 최대 목표)
TP1, TP2 = (1.10, 1.15) if TP15 else (1.08, 1.12)
T_MIN = int(os.environ.get("TMIN", "100"))
out = []
def p(s=""): out.append(str(s)); print(s, flush=True)

def load():
    if os.environ.get("SYNTH"):   # 문법·논리 점검용 가짜 자료
        rng = np.random.default_rng(1); rows = []; dts = pd.bdate_range("2025-09-01", periods=330)
        for k in range(40):
            px = 10000 * np.cumprod(1 + rng.normal(0, .03, len(dts))); vol = rng.integers(1e5, 1e6, len(dts)).astype(float)
            for i, d in enumerate(dts):
                c = px[i]; rows.append((d, f"{k:06d}", c * .99, c * 1.02, c * .97, c, vol[i], vol[i] * c, 5e11, (c / px[i - 1] - 1) * 100 if i else 0, abs(rng.normal(0, .2)) * (3 if rng.random() < .03 else 1),
                                        *rng.normal(0, 3e8, 7)))
        P = pd.DataFrame(rows, columns="d code o h l c v a mc chg w fn inn fi it pn pe ins".split()); E = pd.DataFrame({"d": dts, "c": 100 * np.cumprod(1 + rng.normal(0, .01, len(dts)))})
        return P, E, {k: f"S{k}" for k in P.code.unique()}
    import psycopg2
    c = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); c.set_session(readonly=True, autocommit=True)
    Q = lambda s: pd.read_sql(s, c)
    S = Q("select code,name from stocks where security_type='STOCK'")
    P = Q("""select p.trade_date d,p.code,p.open o,p.high h,p.low l,p.close c,p.volume v,p.trade_amount a,p.market_cap mc,p.change_pct chg,p.weight_per_share w,
                    coalesce(f.foreign_net,0) fn,coalesce(f.inst_net,0) inn,coalesce(f.fin_inv_net,0) fi,coalesce(f.inv_trust_net,0) it,coalesce(f.pension_net,0) pn,coalesce(f.pe_net,0) pe,coalesce(f.inst_net,0) ins
             from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
             left join daily_flow f on f.trade_date=p.trade_date and f.code=p.code where p.close>0 order by p.code,p.trade_date""")
    E = Q("select trade_date d,close c from etf_daily where code='069500' order by 1")
    return P, E, dict(zip(S.code, S.name))

P, E, NAME = load()
P["d"] = pd.to_datetime(P["d"]); E["d"] = pd.to_datetime(E["d"]); E = E.sort_values("d"); E["c"] = E.c.astype(float)
E["ma"] = E.c.rolling(60).mean(); REG = dict(zip(E.d, (E.c < E.ma).where(E.ma.notna())))   # 하락 국면(KODEX200 < 60일선)
p("# 눌림목 1·2위일 정의 비교 — 절대/상대(평균 대비 배수) 하한 · 앱식 vs 최근 3개월 최대 2개(시점 일치)\n")
p(f"데이터 {P.d.min().date()} ~ {P.d.max().date()} · 종목 {P.code.nunique():,} · 행 {len(P):,} · 신호는 종목별 {T_MIN}번째 거래일부터(앞 구간은 1·2위일 이력이 짧아 제외)\n")

def smx_model(rows):   # 135_smx_state.py model() 과 같은 계산 — rows: [(d, 외+기, 외국인, 금융투자, 투신, 연기금, 사모, 기관)]
    n = len(rows); L = n - 1; combo = [0.0] * n
    for i in range(1, n): combo[i] = combo[i - 1] + rows[i][1] / EOK
    pk = 0
    for i in range(n):
        if combo[i] > combo[pk]: pk = i
    tr = 0
    for i in range(pk + 1):
        if combo[i] < combo[tr]: tr = i
    build = combo[pk] - combo[tr]; dd = combo[pk] - combo[L]; since = L - pk
    r20 = combo[L] - combo[max(0, L - 20)]; ratio = dd / build if build > 0 else None
    if build <= 0: st = "OUT" if combo[L] < 0 else "NONE"
    elif since <= 5: st = "CONT"
    elif ratio < 0.1: st = "STALL"
    elif ratio < 0.5: st = "LEAVE" if r20 < 0 else "STALL"
    else: st = "HEAVY"
    def cum(col):
        v = [0.0] * n
        for i in range(1, n): v[i] = v[i - 1] + col(rows[i]) / EOK
        return v
    subs = [("외국인", cum(lambda r: r[2])), ("금융투자", cum(lambda r: r[3])), ("투신", cum(lambda r: r[4])), ("연기금", cum(lambda r: r[5])), ("사모", cum(lambda r: r[6])),
            ("기타기관", cum(lambda r: r[7] - r[3] - r[4] - r[5] - r[6]))]
    best = None
    for nm, v in subs:
        if all(abs(z) < 0.5 for z in v): continue
        sc = (v[pk] - v[tr]) if build > 0 else v[L]
        if best is None or sc > best[1]: best = (nm, sc, v[L] - v[max(0, L - 5)], v[L] - v[max(0, L - 20)])
    tr_ = None
    if best and best[1] > 0:
        nm, sc, a5, a20 = best; T = 0.5
        if a20 > T and a5 > T: tr_ = "UP"
        elif a20 > T: tr_ = "SLOW"
        elif a20 < -T and a5 < -T: tr_ = "DOWN"
        elif a20 < -T: tr_ = "REBUY"
        elif a5 > T: tr_ = "RESUME"
        elif a5 < -T: tr_ = "TURN"
        else: tr_ = "FLAT"
    return st, tr_

def gate(g, t):   # t 일 아침까지의(t−1 일 마감) 스마트머니 1개월·3개월
    for w in (21, 63):
        lo = max(0, t - w); n = t - lo
        if n < 10: return False
        rows = [(None, g["fn"][i] + g["inn"][i], g["fn"][i], g["fi"][i], g["it"][i], g["pn"][i], g["pe"][i], g["ins"][i]) for i in range(lo, t)]
        st, tr_ = smx_model(rows)
        if st not in ("CONT", "STALL") or tr_ in ("DOWN", "TURN"): return False
    return True

def armed_state(c, i, t, vw, dip):   # 1·2위일 i 뒤 ~ t−1 종가로 눌림(무장) 여부 + 가장 깊었던 종가
    lo, brk, armed, mn = vw * (1 - dip / 100), vw * (1 + BRK / 100), False, 1e18
    for j in range(i + 1, t):
        x = c[j]
        if x < mn: mn = x
        if x < lo: armed = True
        elif armed and x >= brk: armed = False
    return armed, (mn / vw - 1) * 100 if mn < 1e17 else None


TP15 = True; TP1, TP2 = 1.10, 1.15; STOPS = (5.0,)
def simulate(t, n, o, h, l, c, v, sp=STOP):
    ent = c[t]; stop = ent * (1 - sp / 100); left, pnl, k, why = 1.0, 0.0, t + 1, ""
    while True:
        if left == 1.0 and h[k] >= ent * TP1: pnl += 0.5 * (TP1 - 1); left = 0.5; stop = max(stop, ent * 1.0035)
        if left == 0.5 and h[k] >= ent * TP2: pnl += 0.5 * (TP2 - 1); left = 0; why = "익절2"; break
        if c[k] < stop: pnl += left * (c[k] / ent - 1); why = "손절" if stop < ent else "본전손절"; break
        if k - t >= HOLD or k + 1 >= n: pnl += left * (c[k] / ent - 1); why = "시간청산" if k - t >= HOLD else "자료끝"; break
        k += 1
    return pnl * 100 - COST, why, k - t, k


# 설정: (이름, 방식, 절대 하한, 상대 배수) — 방식 app = 앱 정의(1위일·그 뒤 최대 2위일), top2 = 최근 63거래일 안 무게 큰 날 2개(순서 무관)
CFG = [("현재(앱식·0.1)", "app", 0.1, 0), ("최근3개월 최대2개·0.1", "top2", 0.1, 0), ("최근3개월 최대2개·0.5", "top2", 0.5, 0), ("최근3개월 최대2개·1.0", "top2", 1.0, 0),
       ("최근3개월 최대2개·평균의 10배", "top2", 0.1, 10), ("최근3개월 최대2개·평균의 20배", "top2", 0.1, 20), ("최근3개월 최대2개·평균의 40배", "top2", 0.1, 40),
       ("최근3개월 최대2개·0.5 + 평균의 20배", "top2", 0.5, 20)]
base_y, sigs, trades = [], [], []
CODES = [cd for cd, nm in NAME.items() if nm in ('안랩', '코스맥스', '에스엠', 'SM')]
for code, g0 in P.groupby("code", sort=False):
    g0 = g0.drop_duplicates("d", keep="last").sort_values("d").reset_index(drop=True); n = len(g0)
    if n < T_MIN + 15: continue
    arr = {k: g0[k].astype(float).fillna(0).values for k in ("o", "h", "l", "c", "v", "a", "mc", "fn", "inn", "fi", "it", "pn", "pe", "ins")}
    w = np.nan_to_num(g0.w.astype(float).values); dates = g0.d.values
    o, h, l, c, v, a, mc = (arr[k] for k in ("o", "h", "l", "c", "v", "a", "mc"))
    fwd10 = np.r_[c[10:] / c[:-10] - 1, [np.nan] * 10] * 100
    base = pd.Series(np.abs(w)).shift(1).rolling(60, min_periods=20).mean().values   # 그날 직전 60거래일 평균 무게(절댓값)
    thr = [np.maximum(np.full(n, wa), k * np.nan_to_num(base, nan=1e9)) if k else np.full(n, wa) for _, _, wa, k in CFG]
    d1 = d2 = -1; w1 = w2 = 0.0; last_exit = {}
    for t in range(n):
        if t >= T_MIN and t + 1 < n and mc[t - 1] >= CAPMIN:
            base_y.append((dates[t], fwd10[t]))
            lo_i = max(0, t - MAXAGE); win = w[lo_i:t]
            order = np.argsort(-win)[:12] + lo_i if len(win) else []
            for ci, (cn, mode, wa, kk) in enumerate(CFG):
                if mode == "app":
                    idxs = [(d1, 1), (d2, 2)]
                else:
                    q = [i for i in order if w[i] >= thr[ci][i] and w[i] > 0][:2]
                    idxs = [(i, r + 1) for r, i in enumerate(q)]
                cands = []
                for idx, rk in idxs:
                    if idx < 0 or w[idx] < thr[ci][idx]: continue
                    age = t - idx
                    if 2 <= age <= MAXAGE and v[idx] > 0 and a[idx] > 0: cands.append((idx, rk, age, a[idx] / v[idx]))
                if not cands or not any(BRK <= (c[t] / x[3] - 1) * 100 <= CHASE for x in cands): continue
                arm = []
                for idx, rk, age, vw in cands:
                    ok, dep = armed_state(c, idx, t, vw, 0.0)
                    if ok: arm.append((vw, idx, rk, age, dep))
                if not arm: continue
                vw, idx, rk, age, dep = min(arm); gp = (c[t] / vw - 1) * 100
                if not (BRK <= gp <= CHASE): continue
                gk = gate(arr, t); reg = REG.get(dates[t - 1]); reg = None if reg is None or reg != reg else bool(reg)
                for gv, use in (("수급 점검", True), ("점검 없음", False)):
                    if use and not gk: continue
                    sigs.append((cn, gv, code, dates[t], rk, age, gp, reg))
                    if t <= last_exit.get((ci, gv), -1): continue
                    r, why, hold, k = simulate(t, n, o, h, l, c, v)
                    last_exit[(ci, gv)] = k
                    trades.append((cn, gv, code, dates[t], c[t], r, why, hold, rk, age, gp, reg))
        if w[t] > w1: d1, w1, d2, w2 = t, w[t], -1, 0.0
        elif d1 >= 0 and t > d1 and w[t] > w2: d2, w2 = t, w[t]

SG = pd.DataFrame(sigs, columns=["cfg", "gate", "code", "d", "rk", "age", "gap", "reg"])
TR = pd.DataFrame(trades, columns=["cfg", "gate", "code", "d", "ent", "ret", "why", "hold", "rk", "age", "gap", "reg"])
mid = TR.d.sort_values().iloc[len(TR) // 2] if len(TR) else None
p("## 모의매매(종가 매수 · 매수가 −5% 종가 손절 · +10/+15% 익절 · 시간 청산 없음 · 비용 0.25% · 눌림 깊이 무관)\n")
p("| 1·2위일 정의 | 수급 | 거래 | 종목 | 승률 | 평균% | 중앙값% | PF | 전반 평균(거래) | 후반 평균(거래) | 하락국면 평균(거래) |\n|---|---|---:|---:|---:|---:|---:|---:|---|---|---|")
for cn, *_ in CFG:
    for gv in ("수급 점검", "점검 없음"):
        x = TR[(TR.cfg == cn) & (TR.gate == gv)]
        if len(x) < 5: p(f"| {cn} | {gv} | {len(x)} | | | | | | | | |"); continue
        wn, ls = x[x.ret > 0].ret.sum(), -x[x.ret <= 0].ret.sum(); f, b_ = x[x.d < mid], x[x.d >= mid]; dn = x[x.reg == True]
        p(f"| {cn} | {gv} | {len(x)} | {x.code.nunique()} | {(x.ret>0).mean()*100:.0f}% | {x.ret.mean():+.2f} | {x.ret.median():+.2f} | {wn/ls if ls>0 else float('inf'):.2f} | {f.ret.mean():+.2f} ({len(f)}) | {b_.ret.mean():+.2f} ({len(b_)}) | {dn.ret.mean() if len(dn) else float('nan'):+.2f} ({len(dn)}) |")
p("\n## 안랩 · 코스맥스 · 에스엠 신호일(수급 점검 있는 안 / 없는 안)\n")
for cd in CODES:
    p(f"**{NAME.get(cd, cd)}({cd})**")
    for cn, *_ in CFG:
        row = []
        for gv in ("수급 점검", "점검 없음"):
            sg = SG[(SG.cfg == cn) & (SG.gate == gv) & (SG.code == cd)]
            row.append(f"{gv} {len(sg)}건" + (": " + ", ".join(pd.Timestamp(d).strftime('%m/%d') for d in sg.d) if 0 < len(sg) <= 8 else ""))
        p(f"- {cn} → " + " / ".join(row))
p(f"\n총 {time.time()-T0:.0f}초 · 일봉(종가 매수 근사) · 데이터 약 14개월 · 설정을 여러 개 비교하므로 우연히 좋아 보이는 결과 주의(전반/후반 열 확인).")
open("pullback_study.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
