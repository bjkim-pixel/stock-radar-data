# -*- coding: utf-8 -*-
"""
STOCK RADAR · v4 포지션 엔진 (매수 확정 · 불타기 · 트레일링 손절)
==========================================================================
06_signals.sql이 만든 V4_CANDIDATE를 받아, 포지션 상태가 있어야만 판정할 수
있는 부분을 처리합니다.

  06_signals.sql  → V4_CANDIDATE   (조건 통과 종목 전부, 상태 불필요)
  06_portfolio.py → V4_BUY         (일 5종목 한도·기보유 제외를 적용한 실제 매수)
                    V4_PYRAMID     (+14%/+28%/+42% 추가매수)
                    V4_SELL        (보유 중 최고종가 대비 -7% 트레일링 손절)
                    V4_CRASH_SELL  (-7%를 건너뛰고 바로 -10% 이하 급락)

하루 처리 순서 (백테스트와 동일)
  1) 매도 판정 — 보유 포지션의 peak_price 갱신 후 낙폭 확인 (매수 당일 제외)
  2) 불타기   — 살아남은 포지션 중 최초 매수가 대비 +14% 배수 도달분
  3) 신규 매수 — 당일 후보 중 기보유 제외, pick_score 오름차순 최대 5종목

포트폴리오 두 종류
  VIRTUAL : 백테스트 규칙 그대로 엔진이 자동 운용. 매 실행 시 전 기간을 처음부터
            재생성하므로(결정론적) 직접 수정하지 마세요.
  REAL    : 사용자가 positions에 직접 넣은 실제 보유분. 엔진은 peak_price 갱신과
            신호 생성만 합니다. ⚠ 손절 조건이 걸리면 REAL 포지션도 CLOSED로
            바꿉니다 — 실제로 팔지 않으셨다면 포지션을 다시 넣어주세요.
            (매일 반복 알림을 피하려는 선택입니다. 다르게 원하시면 알려주세요.)

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

# ── v4 스펙 파라미터 ──────────────────────────────────────────────────────────
ENTRY_AMOUNT    = 10_000_000     # 종목당 최초 매수금액 (원)
MAX_BUY_PER_DAY = 5              # 일 매수 한도 (종목)
STOP_PCT        = -0.07          # 1차: 보유 중 최고종가 대비 트레일링 손절
CRASH_PCT       = -0.10          # 2차: 급락 안전장치 (라벨만 다름, 결과 동일)
PYRAMID_STEP    = 0.14           # 불타기 트리거 간격 (2R, R=7%)
PYRAMID_MAX     = 3              # 불타기 최대 횟수 (+14%/+28%/+42%)
COST_ONE_WAY    = 0.0012         # 편도 거래비용 (왕복 0.24%)

# VIRTUAL 신호는 매 실행 시 전 기간을 재생성하므로 "지우고 다시 넣기"가 안전합니다.
VIRTUAL_SIGNAL_TYPES = ["V4_BUY", "V4_PYRAMID", "V4_SELL", "V4_CRASH_SELL"]

# REAL 신호는 다릅니다. 한 번 청산된 REAL 포지션은 다음 실행 때 OPEN이 아니라서
# 다시 계산되지 않는데, VIRTUAL과 똑같이 "이번에 안 나왔으니 stale"로 지워버리면
# 실제 매도 이력이 재실행 한 번에 사라집니다. 그래서 REAL은 UPSERT만 하고
# 절대 일괄 삭제하지 않습니다.
REAL_SIGNAL_TYPES = ["V4_BUY_REAL", "V4_PYRAMID_REAL",
                     "V4_SELL_REAL", "V4_CRASH_SELL_REAL"]


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


args = [a for a in sys.argv[1:] if not a.startswith("--")]


# ── 데이터 로드 ───────────────────────────────────────────────────────────────
def load_all(cur):
    """후보·종가·종목명을 한 번에 읽어 메모리에 올립니다(유니버스 300종목 규모라 가볍습니다)."""
    cur.execute("""
        SELECT sg.trade_date, sg.code, sg.reason, s.name
        FROM signals sg
        JOIN stocks s ON s.code = sg.code
        WHERE sg.signal_type = 'V4_CANDIDATE'
        ORDER BY sg.trade_date, (sg.reason->>'pick_score')::numeric
    """)
    candidates = {}
    for d, code, reason, name in cur.fetchall():
        candidates.setdefault(d, []).append({
            "code": code,
            "name": name,
            "pick_score": float(reason.get("pick_score") or 1e9),
            "close": int(reason.get("close") or 0),
            "reason": reason,
        })

    cur.execute("""
        SELECT p.trade_date, p.code, p.close
        FROM daily_price p
        JOIN stocks s ON s.code = p.code
        WHERE s.security_type = 'STOCK' AND p.close > 0
    """)
    closes = {}
    for d, code, close in cur.fetchall():
        closes.setdefault(d, {})[code] = int(close)

    cur.execute("SELECT code, name FROM stocks")
    names = dict(cur.fetchall())

    return candidates, closes, names


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
    __slots__ = ("portfolio", "code", "name", "entry_date", "entry_price",
                 "avg_price", "quantity", "invested", "tranches", "peak_price",
                 "peak_date", "pyramid_blocked", "status", "exit_date",
                 "exit_price", "exit_reason", "realized_pnl", "return_pct")

    def __init__(self, portfolio, code, name, entry_date, entry_price,
                 quantity, invested, pyramid_blocked=False, tranches=1,
                 avg_price=None, peak_price=None, peak_date=None):
        self.portfolio = portfolio
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
        return (self.portfolio, self.code, self.status, self.entry_date,
                self.entry_price, round(self.avg_price, 2), self.quantity,
                self.invested, self.tranches, self.peak_price, self.peak_date,
                self.pyramid_blocked, self.exit_date, self.exit_price,
                self.exit_reason, self.realized_pnl, self.return_pct)


# ── 하루 처리 ─────────────────────────────────────────────────────────────────
def process_day(day, open_pos, day_closes, day_candidates, stopped_codes,
                sig, suffix, allow_buy):
    """open_pos: {code: Position}. 청산된 포지션 리스트를 반환합니다."""
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
                    ("V4_CRASH_SELL" if crash else "V4_SELL") + suffix,
                    "SELL",
                    min(100.0, abs(dd) * 1000),
                    {
                        "portfolio":    pos.portfolio,
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
                    f"{pos.name} 전량매도 · 고점 {pos.peak_price:,}원 대비 "
                    f"{dd*100:.1f}% · 실현 {pos.return_pct:.1f}% "
                    f"({pos.realized_pnl:,}원)"
                    + ("  ※급락 안전장치" if crash else ""))

    # 2) 불타기 — 최초 매수가 대비 +14% 배수 도달분
    for code, pos in open_pos.items():
        if pos.entry_date >= day or pos.pyramid_blocked:
            continue
        close = day_closes.get(code)
        if close is None:
            continue
        gain = close / pos.entry_price - 1
        target = min(PYRAMID_MAX, int(gain // PYRAMID_STEP))
        while pos.tranches - 1 < target:
            qty = ENTRY_AMOUNT // close
            if qty <= 0:
                break
            add_cost = qty * close
            pos.avg_price = (pos.avg_price * pos.quantity + add_cost) / (pos.quantity + qty)
            pos.quantity += qty
            pos.invested += add_cost
            pos.tranches += 1
            sig.add(day, code, "V4_PYRAMID" + suffix, "BUY",
                    min(100.0, 50 + gain * 100),
                    {
                        "portfolio":     pos.portfolio,
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
                    f"{pos.name} 불타기 {pos.tranches-1}회차 · 최초가 대비 "
                    f"+{gain*100:.1f}% · {close:,}원 {qty:,}주 추가 "
                    f"(평단 {pos.avg_price:,.0f}원)")

    # 3) 신규 매수 — 후보 중 기보유 제외, pick_score 오름차순 최대 5종목
    if allow_buy:
        picks = [c for c in day_candidates if c["code"] not in open_pos]
        picks.sort(key=lambda c: c["pick_score"])
        for cand in picks[:MAX_BUY_PER_DAY]:
            close = day_closes.get(cand["code"]) or cand["close"]
            if not close:
                continue
            qty = ENTRY_AMOUNT // close
            if qty <= 0:
                continue                   # 주당 1,000만원 초과 — 매수 불가
            invested = qty * close
            pos = Position("VIRTUAL", cand["code"], cand["name"], day, close,
                           qty, invested,
                           pyramid_blocked=cand["code"] in stopped_codes)
            open_pos[cand["code"]] = pos
            r = cand["reason"]
            sig.add(day, cand["code"], "V4_BUY", "BUY",
                    min(100.0, max(0.0, 100.0 - cand["pick_score"] / 3.0)),
                    {
                        "portfolio":       "VIRTUAL",
                        "pick_score":      cand["pick_score"],
                        "sector":          r.get("sector"),
                        "sector_rs_rank":  r.get("sector_rs_rank"),
                        "vol_ratio20_prev": r.get("vol_ratio20_prev"),
                        "market_cap":      r.get("market_cap"),
                        "nonpersonal_net": r.get("nonpersonal_net"),
                        "change_pct":      r.get("change_pct"),
                        "entry_price":     close,
                        "quantity":        qty,
                        "invested":        invested,
                        "pyramid_blocked": pos.pyramid_blocked,
                    },
                    f"{cand['name']} 신규매수 · {close:,}원 {qty:,}주 "
                    f"({invested:,}원) · {r.get('sector')} RS "
                    f"{r.get('sector_rs_rank')}위 · 우선순위 {cand['pick_score']:.1f}")

    return closed


# ── 메인 ──────────────────────────────────────────────────────────────────────
def main():
    t0 = time.time()
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min'")
        candidates, closes, names = load_all(cur)

        if not candidates:
            print("⚠ V4_CANDIDATE가 없습니다. 06_signals.sql을 먼저 실행하세요.")
            conn.rollback()
            return

        all_days = sorted(closes.keys())
        first_cand = min(candidates.keys())
        sim_days = [d for d in all_days if d >= first_cand]

        if len(args) >= 2:
            rec_from = datetime.date.fromisoformat(iso(args[0]))
            rec_to   = datetime.date.fromisoformat(iso(args[1]))
        else:
            rec_from, rec_to = sim_days[0], sim_days[-1]

        print(f"▶ 시뮬레이션 구간: {sim_days[0]} ~ {sim_days[-1]} ({len(sim_days)}거래일)")
        print(f"   신호 기록 구간: {rec_from} ~ {rec_to}")

        sig = SignalBuffer()

        # ── VIRTUAL: 전 기간 재생성 ────────────────────────────────────────
        cur.execute("DELETE FROM positions WHERE portfolio = 'VIRTUAL'")
        print(f"   기존 VIRTUAL 포지션 {cur.rowcount:,}건 삭제 후 재생성")

        open_pos, closed_all, stopped = {}, [], set()
        for day in sim_days:
            closed_all += process_day(
                day, open_pos, closes.get(day, {}), candidates.get(day, []),
                stopped, sig, suffix="", allow_buy=True)

        v_rows = [p.as_row() for p in closed_all] + [p.as_row() for p in open_pos.values()]

        # ── REAL: 사용자 보유분 — peak 갱신·신호만, 신규매수 없음 ──────────
        cur.execute("""
            SELECT code, entry_date, entry_price, quantity, invested,
                   tranches, pyramid_blocked
            FROM positions WHERE portfolio = 'REAL' AND status = 'OPEN'
        """)
        real_rows = cur.fetchall()
        real_open, real_closed = {}, []
        for code, ed, ep, qty, inv, tr, pb in real_rows:
            real_open[code] = Position("REAL", code, names.get(code, code), ed,
                                       int(ep), int(qty), int(inv),
                                       pyramid_blocked=pb, tranches=tr)
        if real_open:
            print(f"   REAL 포지션 {len(real_open)}건 — peak 재계산 및 판정")
            r_stopped = set()
            for day in [d for d in all_days if d >= min(p.entry_date for p in real_open.values())]:
                real_closed += process_day(
                    day, real_open, closes.get(day, {}), [], r_stopped,
                    sig, suffix="_REAL", allow_buy=False)

        # ── 저장 ───────────────────────────────────────────────────────────
        if v_rows:
            execute_values(cur, """
                INSERT INTO positions
                  (portfolio, code, status, entry_date, entry_price, avg_price,
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
        # 통째로 지우고 다시 넣되, 텔레그램 중복 발송을 막는 notified 플래그는
        # 기존 값을 읽어와 복원합니다.
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

        # REAL은 삭제 없이 UPSERT만 (위 주석 참고)
        if r_keep:
            execute_values(cur, """
                INSERT INTO signals
                  (trade_date, code, signal_type, grade, score, reason, reason_text)
                VALUES %s
                ON CONFLICT (trade_date, code, signal_type) DO UPDATE SET
                  grade = EXCLUDED.grade, score = EXCLUDED.score,
                  reason = EXCLUDED.reason, reason_text = EXCLUDED.reason_text
            """, r_keep, page_size=500)

        conn.commit()

    # ── 요약 ─────────────────────────────────────────────────────────────
    wins = [p for p in closed_all if (p.realized_pnl or 0) > 0]
    total_pnl = sum(p.realized_pnl or 0 for p in closed_all)
    hold_days = [(p.exit_date - p.entry_date).days for p in closed_all if p.exit_date]

    print(f"\n{'='*64}\nVIRTUAL 포트폴리오 결과\n{'='*64}")
    print(f"  총 포지션      : {len(closed_all) + len(open_pos):,}건 "
          f"(청산 {len(closed_all):,} / 보유중 {len(open_pos):,})")
    if closed_all:
        print(f"  승률           : {len(wins)/len(closed_all)*100:.1f}% "
              f"({len(wins)}/{len(closed_all)})")
        print(f"  실현손익 합계  : {total_pnl:,}원")
        print(f"  매도건 평균수익: {sum(float(p.return_pct or 0) for p in closed_all)/len(closed_all):+.2f}%")
        if hold_days:
            print(f"  평균 보유일수  : {sum(hold_days)/len(hold_days):.1f}일 (달력일)")
        avg_win = sum(p.realized_pnl for p in wins) / len(wins) if wins else 0
        losses = [p for p in closed_all if (p.realized_pnl or 0) <= 0]
        avg_loss = abs(sum(p.realized_pnl for p in losses) / len(losses)) if losses else 0
        if avg_loss:
            print(f"  손익비         : {avg_win/avg_loss:.1f}배")
    if open_pos:
        print(f"\n  [보유 중 {len(open_pos)}건]")
        for p in sorted(open_pos.values(), key=lambda x: x.entry_date):
            last = closes.get(sim_days[-1], {}).get(p.code)
            cur_ret = (last / p.avg_price - 1) * 100 if last else 0
            print(f"    {p.code} {p.name[:12]:<12} {p.entry_date} 진입 "
                  f"평단 {p.avg_price:>9,.0f} 트랜치 {p.tranches} 평가 {cur_ret:+.1f}%")

    by_type = {}
    for r in sig.rows:
        if rec_from <= r[0] <= rec_to:
            by_type[r[2]] = by_type.get(r[2], 0) + 1
    print(f"\n  [생성 신호] (기록 구간 내)")
    for k in sorted(by_type):
        print(f"    {k:<20}: {by_type[k]:,}건")
    if stale > 0:
        print(f"    (재생성 결과 더는 나오지 않아 사라진 과거 신호 {stale:,}건)")

    conn.close()
    print(f"\n✅ 완료 ({time.time()-t0:.0f}초)")


if __name__ == "__main__":
    main()
