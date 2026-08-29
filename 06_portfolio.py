# -*- coding: utf-8 -*-
"""
STOCK RADAR · 전략별 가상 포지션 엔진 (추세추종 / 종가베팅)
==========================================================================
06_signals.sql이 만든 V4_CAND_{TREND|CLOSEBET}_3(3단계 통과 종목)를 받아,
포지션 상태가 있어야만 판정할 수 있는 매수·불타기·매도를 처리합니다.

두 전략은 완전히 독립적으로 운용됩니다 — 추세추종이 산 종목은 추세추종
규칙으로만 팔고, 종가베팅이 산 종목은 종가베팅 규칙으로만 팝니다. 같은
종목을 두 전략이 동시에 보유할 수도 있습니다(서로 다른 포지션으로 취급).

  06_signals.sql  → V4_CAND_TREND_3 / V4_CAND_CLOSEBET_3  (3단계 통과 종목)
  06_portfolio.py → V4_BUY_TREND    / V4_BUY_CLOSEBET      (실제 가상매수)
                    V4_PYRAMID_TREND                       (+20%마다 불타기, 무제한)
                    V4_SELL_TREND / V4_CRASH_SELL_TREND    (고점 대비 -7% 트레일링 손절)
                    V4_SELL_CLOSEBET                       (매수 익일 시가 전량 매도)

전략별 규칙
  추세추종 (TREND)
    · 매수: 3단계 통과 종목 전부(한도 없음), 1회 1천만원
    · 불타기: 최초 매수가 대비 +20%마다 1천만원씩 추가매수 (횟수 제한 없음)
    · 매도: 매수 다음날부터 보유 중 최고종가(peak) 대비 -7% 트레일링 손절
            (peak는 매수일 종가로 시작 → 사실상 첫 판정일도 매수가 기준 -7%)

  종가베팅 (CLOSEBET)
    · 매수: 3단계 통과 종목 전부(한도 없음), 1회 1천만원
    · 불타기: 없음
    · 매도: 매수 익일 정규장 시가에 무조건 전량 매도 (보유기간 1거래일 고정)

포트폴리오 두 종류
  VIRTUAL : 엔진이 자동 운용. 매 실행 시 전 기간을 처음부터 재생성하므로
            (결정론적) 직접 수정하지 마세요. strategy 컬럼으로 TREND/CLOSEBET 구분.
  REAL    : 사용자가 positions에 직접 넣은 실제 보유분(전략 구분 없음, 기존
            추세추종형 트레일링 손절 규칙 그대로 적용). 엔진은 peak_price
            갱신과 신호 생성만 합니다. ⚠ 손절 조건이 걸리면 REAL 포지션도
            CLOSED로 바꿉니다 — 실제로 팔지 않으셨다면 포지션을 다시 넣어주세요.

사용법
  python 06_portfolio.py                    # DB에 있는 전체 기간
  python 06_portfolio.py 20260101 20260818  # 날짜 범위 지정 (신호 생성 구간)

⚠ VIRTUAL 포트폴리오는 항상 가장 이른 후보 발생일부터 전 기간을 재생성합니다.
   포지션이 과거 상태에 의존하기 때문에 부분 재계산이 불가능하기 때문입니다.
   날짜 인자는 "신호를 어느 구간에 기록할지"만 제한합니다.

환경변수
  SUPABASE_DB_URL
"""
import os, sys, time, datetime, json
import psycopg2
from psycopg2.extras import execute_values, Json

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")

# ── 파라미터 ──────────────────────────────────────────────────────────────────
ENTRY_AMOUNT     = 10_000_000    # 종목당 1회 매수/불타기 금액 (원)
STOP_PCT         = -0.07         # 추세추종: 보유 중 최고종가 대비 트레일링 손절
CRASH_PCT        = -0.10         # 추세추종: 급락 안전장치 (라벨만 다름, 결과 동일)
PYRAMID_STEP     = 0.20          # 추세추종 불타기 트리거 간격 (최초 매수가 대비, 반복 무제한)
COST_ONE_WAY     = 0.0012        # 편도 거래비용 (왕복 0.24%)

CAND_SIGNAL = {"TREND": "V4_CAND_TREND_3", "CLOSEBET": "V4_CAND_CLOSEBET_3"}

# VIRTUAL 신호는 매 실행 시 전 기간을 재생성하므로 "지우고 다시 넣기"가 안전합니다.
VIRTUAL_SIGNAL_TYPES = [
    "V4_BUY_TREND", "V4_PYRAMID_TREND", "V4_SELL_TREND", "V4_CRASH_SELL_TREND",
    "V4_BUY_CLOSEBET", "V4_SELL_CLOSEBET",
]

# REAL 신호는 다릅니다. 한 번 청산된 REAL 포지션은 다음 실행 때 OPEN이 아니라서
# 다시 계산되지 않는데, VIRTUAL과 똑같이 "이번에 안 나왔으니 stale"로 지워버리면
# 실제 매도 이력이 재실행 한 번에 사라집니다. 그래서 REAL은 UPSERT만 하고
# 절대 일괄 삭제하지 않습니다.
REAL_SIGNAL_TYPES = ["V4_BUY_REAL", "V4_PYRAMID_REAL",
                     "V4_SELL_REAL", "V4_CRASH_SELL_REAL"]


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


args = [a for a in sys.argv[1:] if not a.startswith("--")]

# VIRTUAL 포트폴리오 시뮬레이션 하한선. 2026-08-10 이전 백테스트 이력은 의미가
# 없다고 판단해 이 날짜부터만 가상매매를 재구성합니다(과거 이력은 자동 삭제).
# 날짜를 더 당기고 싶으면 이 상수만 바꾸면 됩니다.
SIM_START = datetime.date(2026, 8, 10)

SIM_FROM = None
for _a in sys.argv[1:]:
    if _a.startswith("--sim-from="):
        SIM_FROM = datetime.date.fromisoformat(iso(_a.split("=", 1)[1]))
DRY_RUN = "--dry-run" in sys.argv


# ── 데이터 로드 ───────────────────────────────────────────────────────────────
def load_all(cur):
    """전략별 3단계 후보·종가·시가·종목명을 한 번에 읽어 메모리에 올립니다."""
    candidates = {"TREND": {}, "CLOSEBET": {}}
    for strat, sigtype in CAND_SIGNAL.items():
        cur.execute("""
            SELECT sg.trade_date, sg.code, sg.reason, s.name
            FROM signals sg
            JOIN stocks s ON s.code = sg.code
            WHERE sg.signal_type = %s
            ORDER BY sg.trade_date, (sg.reason->>'pick_score')::numeric
        """, (sigtype,))
        for d, code, reason, name in cur.fetchall():
            candidates[strat].setdefault(d, []).append({
                "code": code,
                "name": name,
                "pick_score": float(reason.get("pick_score") or 1e9),
                "close": int(reason.get("close") or 0),
                "reason": reason,
            })

    cur.execute("""
        SELECT p.trade_date, p.code, p.close, p.open
        FROM daily_price p
        JOIN stocks s ON s.code = p.code
        WHERE s.security_type = 'STOCK' AND p.close > 0
    """)
    closes, opens = {}, {}
    for d, code, close, open_ in cur.fetchall():
        closes.setdefault(d, {})[code] = int(close)
        if open_:
            opens.setdefault(d, {})[code] = int(open_)

    cur.execute("SELECT code, name FROM stocks")
    names = dict(cur.fetchall())

    return candidates, closes, opens, names


# ── 신호 누적기 ───────────────────────────────────────────────────────────────
class SignalBuffer:
    def __init__(self):
        self.rows = []
        self.keys = set()

    def add(self, trade_date, code, signal_type, grade, score, reason, text):
        key = (trade_date, code, signal_type)
        if key in self.keys:
            return          # 같은 날 같은 종목 같은 타입은 1건 (unique 제약)
        self.keys.add(key)
        self.rows.append((trade_date, code, signal_type, grade,
                          round(score, 2), Json(reason), text))


# ── 포지션 ────────────────────────────────────────────────────────────────────
class Position:
    __slots__ = ("portfolio", "strategy", "code", "name", "entry_date", "entry_price",
                 "avg_price", "quantity", "invested", "tranches", "peak_price",
                 "peak_date", "pyramid_blocked", "status", "exit_date",
                 "exit_price", "exit_reason", "realized_pnl", "return_pct")

    def __init__(self, portfolio, strategy, code, name, entry_date, entry_price,
                 quantity, invested, pyramid_blocked=False, tranches=1,
                 avg_price=None, peak_price=None, peak_date=None):
        self.portfolio = portfolio
        self.strategy = strategy
        self.code = code
        self.name = name
        self.entry_date = entry_date
        self.entry_price = entry_price
        self.avg_price = avg_price if avg_price is not None else float(entry_price)
        self.quantity = quantity
        self.invested = invested
        self.tranches = tranches
        self.peak_price = peak_price if peak_price is not None else entry_price
        self.peak_date = peak_date or entry_date
        self.pyramid_blocked = pyramid_blocked
        self.status = "OPEN"
        self.exit_date = self.exit_price = self.exit_reason = None
        self.realized_pnl = self.return_pct = None

    def close_out(self, date, price, reason):
        proceeds = self.quantity * price
        cost = (self.invested + proceeds) * COST_ONE_WAY
        self.status = "CLOSED"
        self.exit_date = date
        self.exit_price = price
        self.exit_reason = reason
        self.realized_pnl = int(round(proceeds - self.invested - cost))
        self.return_pct = round(self.realized_pnl / self.invested * 100, 4) if self.invested else None

    def as_row(self):
        return (self.portfolio, self.strategy, self.code, self.status, self.entry_date,
                self.entry_price, round(self.avg_price, 2), self.quantity,
                self.invested, self.tranches, self.peak_price, self.peak_date,
                self.pyramid_blocked, self.exit_date, self.exit_price,
                self.exit_reason, self.realized_pnl, self.return_pct)


# ── 추세추종: 하루 처리 (트레일링 손절 + 무제한 불타기 + 신규매수) ────────────
def process_day_trend(day, open_pos, day_closes, day_candidates, stopped_codes,
                      sig, suffix, allow_buy):
    closed = []

    # 1) 매도 판정 — peak 갱신 후 낙폭 확인 (매수 당일은 제외)
    for code, pos in list(open_pos.items()):
        if pos.entry_date >= day:
            continue
        close = day_closes.get(code)
        if close is None:
            continue                       # 거래정지 등 — 판정 보류
        if close > pos.peak_price:
            pos.peak_price = close
            pos.peak_date = day
        dd = close / pos.peak_price - 1
        if dd <= STOP_PCT:
            crash = dd <= CRASH_PCT
            reason_code = "CRASH_STOP_10" if crash else "TRAIL_STOP_7"
            pos.close_out(day, close, reason_code)
            closed.append(pos)
            del open_pos[code]
            stopped_codes.add(code)        # 이후 재진입 시 불타기 중단
            sig.add(day, code,
                    ("V4_CRASH_SELL_TREND" if crash else "V4_SELL_TREND") + suffix,
                    "SELL",
                    min(100.0, abs(dd) * 1000),
                    {
                        "portfolio":    pos.portfolio,
                        "strategy":     "TREND",
                        "entry_date":   pos.entry_date.isoformat(),
                        "entry_price":  pos.entry_price,
                        "avg_price":    round(pos.avg_price, 2),
                        "peak_price":   pos.peak_price,
                        "peak_date":    pos.peak_date.isoformat(),
                        "close":        close,
                        "drawdown_pct": round(dd * 100, 2),
                        "tranches":     pos.tranches,
                        "quantity":     pos.quantity,
                        "invested":     pos.invested,
                        "realized_pnl": pos.realized_pnl,
                        "return_pct":   float(pos.return_pct or 0),
                        "exit_reason":  reason_code,
                    },
                    f"[추세추종] {pos.name} 전량매도 · 고점 {pos.peak_price:,}원 대비 "
                    f"{dd*100:.1f}% · 실현 {pos.return_pct:.1f}% "
                    f"({pos.realized_pnl:,}원)"
                    + ("  ※급락 안전장치" if crash else ""))

    # 2) 불타기 — 최초 매수가 대비 +20%마다, 횟수 제한 없음
    for code, pos in open_pos.items():
        if pos.entry_date >= day or pos.pyramid_blocked:
            continue
        close = day_closes.get(code)
        if close is None:
            continue
        gain = close / pos.entry_price - 1
        target = int(gain // PYRAMID_STEP)     # 무제한 — 상한 없음
        while pos.tranches - 1 < target:
            qty = ENTRY_AMOUNT // close
            if qty <= 0:
                break
            add_cost = qty * close
            pos.avg_price = (pos.avg_price * pos.quantity + add_cost) / (pos.quantity + qty)
            pos.quantity += qty
            pos.invested += add_cost
            pos.tranches += 1
            sig.add(day, code, "V4_PYRAMID_TREND" + suffix, "BUY",
                    min(100.0, 50 + gain * 100),
                    {
                        "portfolio":     pos.portfolio,
                        "strategy":      "TREND",
                        "tranche":       pos.tranches,
                        "trigger_gain":  round((pos.tranches - 1) * PYRAMID_STEP * 100, 1),
                        "actual_gain":   round(gain * 100, 2),
                        "entry_price":   pos.entry_price,
                        "close":         close,
                        "add_qty":       qty,
                        "add_amount":    add_cost,
                        "avg_price":     round(pos.avg_price, 2),
                        "total_qty":     pos.quantity,
                        "total_invested": pos.invested,
                    },
                    f"[추세추종] {pos.name} 불타기 {pos.tranches-1}회차 · 최초가 대비 "
                    f"+{gain*100:.1f}% · {close:,}원 {qty:,}주 추가 "
                    f"(평단 {pos.avg_price:,.0f}원)")

    # 3) 신규 매수 — 3단계 통과 후보 전부(기보유 제외), 한도 없음
    if allow_buy:
        picks = [c for c in day_candidates if c["code"] not in open_pos]
        picks.sort(key=lambda c: c["pick_score"])
        for cand in picks:
            close = day_closes.get(cand["code"]) or cand["close"]
            if not close:
                continue
            qty = ENTRY_AMOUNT // close
            if qty <= 0:
                continue                   # 주당 1,000만원 초과 — 매수 불가
            invested = qty * close
            pos = Position("VIRTUAL", "TREND", cand["code"], cand["name"], day, close,
                           qty, invested,
                           pyramid_blocked=cand["code"] in stopped_codes)
            open_pos[cand["code"]] = pos
            r = cand["reason"]
            sig.add(day, cand["code"], "V4_BUY_TREND", "BUY",
                    min(100.0, max(0.0, 100.0 - cand["pick_score"] / 3.0)),
                    {
                        "portfolio":       "VIRTUAL",
                        "strategy":        "TREND",
                        "pick_score":      cand["pick_score"],
                        "sector":          r.get("sector"),
                        "sector_rs_rank":  r.get("sector_rs_rank"),
                        "vol_ratio20_prev": r.get("vol_ratio20_prev"),
                        "market_cap":      r.get("market_cap"),
                        "entry_price":     close,
                        "quantity":        qty,
                        "invested":        invested,
                        "pyramid_blocked": pos.pyramid_blocked,
                    },
                    f"[추세추종] {cand['name']} 3단계 신규매수(신고가돌파) · {close:,}원 {qty:,}주 "
                    f"({invested:,}원) · {r.get('sector')} RS "
                    f"{r.get('sector_rs_rank')}위 · 우선순위 {cand['pick_score']:.1f}")

    return closed


# ── 종가베팅: 하루 처리 (매수 익일 시가 전량 매도 · 불타기 없음) ─────────────
def process_day_closebet(day, open_pos, day_closes, day_opens, day_candidates, sig, allow_buy):
    closed = []

    # 1) 매도 판정 — 매수 다음 거래일 시가에 무조건 전량 매도
    for code, pos in list(open_pos.items()):
        if pos.entry_date >= day:
            continue
        openp = day_opens.get(code)
        if openp is None:
            openp = day_closes.get(code)   # 시가 데이터가 없으면 종가로 대체
        if openp is None:
            continue                       # 거래정지 등 — 판정 보류(다음날 재시도)
        pos.close_out(day, openp, "NEXT_OPEN_EXIT")
        closed.append(pos)
        del open_pos[code]
        sig.add(day, code, "V4_SELL_CLOSEBET", "SELL",
                min(100.0, max(0.0, 50 + float(pos.return_pct or 0))),
                {
                    "portfolio":    pos.portfolio,
                    "strategy":     "CLOSEBET",
                    "entry_date":   pos.entry_date.isoformat(),
                    "entry_price":  pos.entry_price,
                    "exit_price":   openp,
                    "quantity":     pos.quantity,
                    "invested":     pos.invested,
                    "realized_pnl": pos.realized_pnl,
                    "return_pct":   float(pos.return_pct or 0),
                    "exit_reason":  "NEXT_OPEN_EXIT",
                },
                f"[종가베팅] {pos.name} 익일시가 전량매도 · {openp:,}원 · "
                f"실현 {pos.return_pct:.1f}% ({pos.realized_pnl:,}원)")

    # 2) 신규 매수 — 3단계 통과 후보 전부(기보유 제외), 한도 없음, 불타기 없음
    if allow_buy:
        picks = [c for c in day_candidates if c["code"] not in open_pos]
        picks.sort(key=lambda c: c["pick_score"])
        for cand in picks:
            close = day_closes.get(cand["code"]) or cand["close"]
            if not close:
                continue
            qty = ENTRY_AMOUNT // close
            if qty <= 0:
                continue
            invested = qty * close
            pos = Position("VIRTUAL", "CLOSEBET", cand["code"], cand["name"], day, close,
                           qty, invested)
            open_pos[cand["code"]] = pos
            r = cand["reason"]
            sig.add(day, cand["code"], "V4_BUY_CLOSEBET", "BUY",
                    min(100.0, max(0.0, 100.0 - cand["pick_score"] / 3.0)),
                    {
                        "portfolio":       "VIRTUAL",
                        "strategy":        "CLOSEBET",
                        "pick_score":      cand["pick_score"],
                        "sector":          r.get("sector"),
                        "sector_rs_rank":  r.get("sector_rs_rank"),
                        "foreign_net":     r.get("foreign_net"),
                        "inst_net":        r.get("inst_net"),
                        "pgtr_net_amt":    r.get("pgtr_net_amt"),
                        "market_cap":      r.get("market_cap"),
                        "entry_price":     close,
                        "quantity":        qty,
                        "invested":        invested,
                    },
                    f"[종가베팅] {cand['name']} 3단계 신규매수(신고가+수급) · {close:,}원 {qty:,}주 "
                    f"({invested:,}원) · {r.get('sector')} RS "
                    f"{r.get('sector_rs_rank')}위 · 익일 시가 전량매도 예정")

    return closed


# ── REAL(사용자 실보유) — 추세추종형 트레일링 손절 규칙만 유지 ───────────────
def process_day_real(day, open_pos, day_closes, sig):
    """REAL 포지션은 전략 구분 없이 기존 v4 트레일링 손절 규칙만 적용합니다."""
    return process_day_trend(day, open_pos, day_closes, [], set(), sig, "_REAL", allow_buy=False)


# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")
        candidates, closes, opens, names = load_all(cur)

        if not candidates["TREND"] and not candidates["CLOSEBET"]:
            print("⚠ V4_CAND_TREND_3 / V4_CAND_CLOSEBET_3 후보가 없습니다. 06_signals.sql을 먼저 실행하세요.")
            conn.rollback()
            return

        all_days = sorted(closes.keys())
        first_cand_days = [min(candidates[s].keys()) for s in ("TREND", "CLOSEBET") if candidates[s]]
        first_cand = min(first_cand_days)
        effective_start = max(first_cand, SIM_START)
        if SIM_FROM:
            effective_start = max(effective_start, SIM_FROM)
        sim_days = [d for d in all_days if d >= effective_start]
        if not sim_days:
            sys.exit(f"❌ {effective_start} 이후 거래일이 없습니다.")

        if len(args) >= 2:
            rec_from = datetime.date.fromisoformat(iso(args[0]))
            rec_to   = datetime.date.fromisoformat(iso(args[1]))
        else:
            rec_from, rec_to = sim_days[0], sim_days[-1]

        print(f"▶ 시뮬레이션 구간: {sim_days[0]} ~ {sim_days[-1]} ({len(sim_days)}거래일)")
        print(f"   신호 기록 구간: {rec_from} ~ {rec_to}")

        sig = SignalBuffer()

        # ── VIRTUAL: 전 기간 재생성, 전략별 독립 운용 ─────────────────────
        cur.execute("DELETE FROM positions WHERE portfolio = 'VIRTUAL'")
        print(f"   기존 VIRTUAL 포지션 {cur.rowcount:,}건 삭제 후 재생성")

        # SIM_START 이전 백테스트 이력(신호)은 더 이상 유효하지 않으므로 제거합니다.
        # (positions는 위에서 이미 전량 삭제 후 SIM_START부터 재생성되므로 별도 처리 불필요)
        cur.execute("""
            DELETE FROM signals
            WHERE signal_type = ANY(%s) AND trade_date < %s
        """, (VIRTUAL_SIGNAL_TYPES, SIM_START))
        if cur.rowcount:
            print(f"   {SIM_START} 이전 VIRTUAL 신호 {cur.rowcount:,}건 삭제 (구 백테스트 이력)")

        open_trend, open_closebet = {}, {}
        closed_trend, closed_closebet = [], []
        stopped_trend = set()
        cum_realized = {"TREND": 0, "CLOSEBET": 0}
        peak_equity = {"TREND": 0, "CLOSEBET": 0}
        mdd_amount = {"TREND": 0, "CLOSEBET": 0}
        max_invested = {"TREND": 0, "CLOSEBET": 0}

        for day in sim_days:
            dc = closes.get(day, {})
            do = opens.get(day, {})

            newly_t = process_day_trend(
                day, open_trend, dc, candidates["TREND"].get(day, []),
                stopped_trend, sig, suffix="", allow_buy=True)
            closed_trend += newly_t

            newly_c = process_day_closebet(
                day, open_closebet, dc, do, candidates["CLOSEBET"].get(day, []),
                sig, allow_buy=True)
            closed_closebet += newly_c

            for label, newly, open_pos in (("TREND", newly_t, open_trend),
                                            ("CLOSEBET", newly_c, open_closebet)):
                cum_realized[label] += sum(p.realized_pnl or 0 for p in newly)
                invested_open = sum(p.invested for p in open_pos.values())
                unrealized = sum(p.quantity * dc[p.code] - p.invested
                                 for p in open_pos.values() if p.code in dc)
                equity = cum_realized[label] + unrealized
                peak_equity[label] = max(peak_equity[label], equity)
                mdd_amount[label] = min(mdd_amount[label], equity - peak_equity[label])
                max_invested[label] = max(max_invested[label], invested_open)

        v_rows = ([p.as_row() for p in closed_trend] + [p.as_row() for p in open_trend.values()] +
                  [p.as_row() for p in closed_closebet] + [p.as_row() for p in open_closebet.values()])

        # ── REAL: 사용자 보유분 — peak 갱신·신호만, 신규매수 없음 ──────────
        cur.execute("""
            SELECT code, entry_date, entry_price, quantity, invested,
                   tranches, pyramid_blocked
            FROM positions WHERE portfolio = 'REAL' AND status = 'OPEN'
        """)
        real_rows = cur.fetchall()
        real_open, real_closed = {}, []
        for code, ed, ep, qty, inv, tr, pb in real_rows:
            real_open[code] = Position("REAL", None, code, names.get(code, code), ed,
                                       int(ep), int(qty), int(inv),
                                       pyramid_blocked=pb, tranches=tr)
        if real_open:
            print(f"   REAL 포지션 {len(real_open)}건 — peak 재계산 및 판정")
            for day in [d for d in all_days if d >= min(p.entry_date for p in real_open.values())]:
                real_closed += process_day_real(day, real_open, closes.get(day, {}), sig)

        # ── 저장 ───────────────────────────────────────────────────────────
        if v_rows:
            execute_values(cur, """
                INSERT INTO positions
                  (portfolio, strategy, code, status, entry_date, entry_price, avg_price,
                   quantity, invested, tranches, peak_price, peak_date,
                   pyramid_blocked, exit_date, exit_price, exit_reason,
                   realized_pnl, return_pct)
                VALUES %s
            """, v_rows, page_size=500)

        for p in list(real_open.values()) + real_closed:
            cur.execute("""
                UPDATE positions SET
                  status = %s, avg_price = %s, quantity = %s, invested = %s,
                  tranches = %s, peak_price = %s, peak_date = %s,
                  exit_date = %s, exit_price = %s, exit_reason = %s,
                  realized_pnl = %s, return_pct = %s
                WHERE portfolio = 'REAL' AND code = %s AND status = 'OPEN'
            """, (p.status, round(p.avg_price, 2), p.quantity, p.invested,
                  p.tranches, p.peak_price, p.peak_date, p.exit_date,
                  p.exit_price, p.exit_reason, p.realized_pnl, p.return_pct,
                  p.code))

        keep = [r for r in sig.rows if rec_from <= r[0] <= rec_to]
        v_keep = [r for r in keep if r[2] in VIRTUAL_SIGNAL_TYPES]
        r_keep = [r for r in keep if r[2] in REAL_SIGNAL_TYPES]

        # VIRTUAL은 전 기간 재생성이라 "이번에 안 나온 과거 신호"를 지워야 합니다.
        cur.execute("""
            SELECT trade_date, code, signal_type, notified
            FROM signals
            WHERE signal_type = ANY(%s) AND trade_date BETWEEN %s AND %s
        """, (VIRTUAL_SIGNAL_TYPES, rec_from, rec_to))
        was_notified = {(d, c, t): n for d, c, t, n in cur.fetchall()}

        cur.execute("""
            DELETE FROM signals
            WHERE signal_type = ANY(%s) AND trade_date BETWEEN %s AND %s
        """, (VIRTUAL_SIGNAL_TYPES, rec_from, rec_to))
        deleted = cur.rowcount

        if v_keep:
            rows = [r + (was_notified.get((r[0], r[1], r[2]), False),) for r in v_keep]
            execute_values(cur, """
                INSERT INTO signals
                  (trade_date, code, signal_type, grade, score, reason,
                   reason_text, notified)
                VALUES %s
            """, rows, page_size=500)
        stale = deleted - len(v_keep)

        # REAL은 삭제 없이 UPSERT만
        if r_keep:
            execute_values(cur, """
                INSERT INTO signals
                  (trade_date, code, signal_type, grade, score, reason, reason_text)
                VALUES %s
                ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
                  grade = EXCLUDED.grade, score = EXCLUDED.score,
                  reason = EXCLUDED.reason, reason_text = EXCLUDED.reason_text
            """, r_keep, page_size=500)

        if DRY_RUN:
            conn.rollback()
            print("   ⚠ --dry-run: 계산만 하고 DB에는 아무것도 쓰지 않았습니다.")
        else:
            conn.commit()

    # ── 요약 ─────────────────────────────────────────────────────────────
    day_idx = {d: i for i, d in enumerate(sim_days)}

    def summarize(label, closed_all, open_pos, cand_dict):
        wins = [p for p in closed_all if (p.realized_pnl or 0) > 0]
        total_pnl = sum(p.realized_pnl or 0 for p in closed_all)
        n_cand = sum(len(v) for v in cand_dict.values())
        cand_days = [d for d in sim_days if cand_dict.get(d)]
        print(f"\n{'='*64}\n[{label}] VIRTUAL 포트폴리오 결과  "
              f"({sim_days[0]} ~ {sim_days[-1]}, {len(sim_days)}거래일)\n{'='*64}")
        print(f"  총 포지션      : {len(closed_all) + len(open_pos):,}건 "
              f"(청산 {len(closed_all):,} / 보유중 {len(open_pos):,})")
        if closed_all:
            print(f"  승률           : {len(wins)/len(closed_all)*100:.1f}% "
                  f"({len(wins)}/{len(closed_all)})")
            print(f"  실현손익 합계  : {total_pnl:,}원")
            print(f"  필요자금(최대) : {max_invested[label]:,}원")
            if max_invested[label]:
                print(f"  자금대비 수익률: {total_pnl/max_invested[label]*100:+.1f}%")
                print(f"  MDD            : {mdd_amount[label]/max_invested[label]*100:.1f}%")
        print(f"  후보 발생      : {len(cand_days)}/{len(sim_days)}일 · "
              f"일평균 {n_cand/len(sim_days):.2f}종목(3단계)")

    summarize("TREND", closed_trend, open_trend, candidates["TREND"])
    summarize("CLOSEBET", closed_closebet, open_closebet, candidates["CLOSEBET"])

    by_type = {}
    for r in sig.rows:
        if rec_from <= r[0] <= rec_to:
            by_type[r[2]] = by_type.get(r[2], 0) + 1
    print(f"\n[생성 신호] (기록 구간 내)")
    for k in sorted(by_type):
        print(f"  {k:<20}: {by_type[k]:,}건")

    conn.close()
    print(f"\n✅ 완료 ({time.time()-t0:.0f}초)")


if __name__ == "__main__":
    main()
