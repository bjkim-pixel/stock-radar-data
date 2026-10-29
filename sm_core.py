# -*- coding: utf-8 -*-
"""스마트머니(SM) 매집·분산 국면/신호 계산 핵심 로직.

web/index.html 의 smSeries()와 한 줄 한 줄 같은 계산입니다(종목상세 카드가 브라우저에서
같은 결과를 다시 계산). 한쪽을 고치면 반드시 다른 쪽도 같이 고치고 test_sm_parity.py로 확인하세요.

입력 rows: 날짜 오름차순, 각 행 dict
  date, close, high, low, volume, trade_amount, market_cap, sm(스마트머니 순매수 원), ind(개인 순매수 원)
출력: 행마다 dict (phase, phase_days, signals, hold_pct, cost, gap, dW, d20, indW, ind20, ...)
"""

PHASES = ("NEUTRAL", "ACC", "MARKUP", "DIST", "DOWN")
DEFAULT_SUBJ = ("foreign", "inv_trust", "pe", "pension")   # 외국인+투신+사모+연기금 (2026-10-29 확정)


def thresholds(W):
    """판정 구간별 기준값: 120일 = 지분 +1.0%p·가격 +15% 미만, 60일 = +0.5%p·+10% 미만."""
    return (1.0, 0.15) if W >= 120 else (0.5, 0.10)


def sm_series(rows, W=120):
    dth, rth = thresholds(W)
    n = len(rows)
    out = []
    F = []      # SM 누적 지분 변화 (%, 상장주식수 대비, 0에서 시작)
    I = []      # 개인 누적 지분 변화 (%)
    Q = []      # SM 순매수 주식수(추정)
    QI = []     # 개인 순매수 주식수(추정)
    closes = [float(r["close"]) for r in rows]
    vols = [float(r["volume"] or 0) for r in rows]
    shares = None
    H = 0.0; C = 0.0; Hpeak = 0.0
    phase = "NEUTRAL"; pdays = 0; pend_t = None; pend = 0
    gap_prev = None
    last_b2 = -999
    ma20 = []
    for i, r in enumerate(rows):
        close = closes[i]
        mc = float(r["market_cap"] or 0)
        if mc > 0 and close > 0:
            shares = mc / close
        ta = float(r["trade_amount"] or 0); vol = vols[i]
        vwap = ta / vol if (ta > 0 and vol > 0) else close
        sm = float(r["sm"] or 0); ind = float(r["ind"] or 0)
        q = sm / vwap if vwap > 0 else 0.0
        qi = ind / vwap if vwap > 0 else 0.0
        Q.append(q); QI.append(qi)
        fr = q / shares * 100 if shares else 0.0
        ifr = qi / shares * 100 if shares else 0.0
        F.append((F[-1] if F else 0.0) + fr)
        I.append((I[-1] if I else 0.0) + ifr)
        # 평균원가법: 순매수일만 원가 갱신, 순매도일은 수량만 감소, 보유 0이면 초기화
        Hprev, Hpeak_prev = H, Hpeak
        if q > 0:
            C = (C * H + vwap * q) / (H + q)
            H = H + q
        else:
            H = H + q
            if H <= 0:
                H = 0.0; C = 0.0; Hpeak = 0.0
        if H > Hpeak:
            Hpeak = H
        hold_pct = H / shares * 100 if shares else 0.0
        peak_pct = Hpeak / shares * 100 if shares else 0.0

        def back(arr, k):
            j = i - k
            return arr[j] if j >= 0 else 0.0
        dW = F[i] - back(F, W)
        d20 = F[i] - back(F, 20)
        indW = I[i] - back(I, W)
        ind20 = I[i] - back(I, 20)
        c0 = closes[max(0, i - W)]
        retW = close / c0 - 1 if c0 > 0 else 0.0
        lo20 = max(0, i - 19)
        buy20 = sum(1 for x in Q[lo20:i + 1] if x > 0)
        high20p = max(closes[max(0, i - 20):i]) if i >= 1 else close
        high60 = max(closes[max(0, i - 59):i + 1])
        vol20p = (sum(vols[max(0, i - 20):i]) / len(vols[max(0, i - 20):i])) if i >= 1 else vol
        vol5 = sum(vols[max(0, i - 4):i + 1]) / len(vols[max(0, i - 4):i + 1])
        ma20.append(sum(closes[i - 19:i + 1]) / 20 if i >= 19 else None)
        rising = i >= 24 and ma20[i] is not None and ma20[i - 5] is not None and ma20[i] > ma20[i - 5]
        gap = (close / C - 1) if (C > 0 and H > 0) else None
        num = 0.0; den = 0.0
        for k in range(lo20, i + 1):
            if Q[k] < 0:
                den += -Q[k]
                num += min(-Q[k], max(QI[k], 0.0))
        transfer = num / den if den > 0 else None

        acc = dW >= dth and retW < rth and indW < 0
        quiet = acc and retW <= 0
        markup = H > 0 and Hpeak > 0 and H >= 0.8 * Hpeak and gap is not None and gap > 0.05 and rising
        dist = H > 0 and ((gap is not None and gap >= 0.20) or close >= 0.95 * high60) and d20 < 0 and ind20 > 0 and vol5 >= vol20p
        markdown = d20 < 0 and ((peak_pct >= 0.5 and H <= 0.5 * Hpeak) or (gap is not None and gap < 0))

        sig = []
        cur = phase
        # ── 이벤트 신호 (그날 시작 국면 기준) ──
        if cur == "ACC" and pdays >= 20 and i >= 20 and close > high20p and q > 0 and vol >= 1.5 * vol20p:
            sig.append("B1")
        if cur == "MARKUP" and gap is not None and 0 <= gap <= 0.05 and sum(Q[max(0, i - 4):i + 1]) >= 0 and ind < 0 and i - last_b2 >= 5:
            sig.append("B2"); last_b2 = i
        if cur in ("MARKUP", "DIST") and gap is not None and gap < 0 and gap_prev is not None and gap_prev < 0 \
                and not (i >= 2 and out[i - 2]["gap"] is not None and out[i - 2]["gap"] < 0):
            sig.append("S2")
        if peak_pct >= 0.5 and H <= 0.5 * Hpeak and Hpeak_prev > 0 and Hprev > 0.5 * Hpeak_prev:
            sig.append("S3")
        hl = float(r["high"] or 0) - float(r["low"] or 0)
        if gap is not None and gap >= 0.30 and vol >= 2 * vol20p and hl > 0 and (float(r["high"] or 0) - close) / hl >= 0.5 and q < 0:
            sig.append("S4")

        # ── 국면 전환 (3일 연속 확인, B1은 즉시 상승 전환) ──
        if cur == "ACC":
            tgt = "DOWN" if markdown else ("MARKUP" if (markup and retW >= rth) else ("NEUTRAL" if dW <= 0 else "ACC"))
        elif cur == "MARKUP":
            tgt = "DIST" if dist else ("DOWN" if markdown else ("NEUTRAL" if H == 0 else "MARKUP"))
        elif cur == "DIST":
            tgt = "DOWN" if markdown else ("MARKUP" if (markup and d20 > 0) else ("NEUTRAL" if H == 0 else "DIST"))
        elif cur == "DOWN":
            tgt = "ACC" if acc else ("NEUTRAL" if not markdown else "DOWN")
        else:
            tgt = "ACC" if acc else ("DIST" if dist else ("MARKUP" if markup else "NEUTRAL"))
        new = cur
        if "B1" in sig:
            new = "MARKUP"; pend_t = None; pend = 0
        elif tgt != cur:
            if pend_t == tgt:
                pend += 1
            else:
                pend_t = tgt; pend = 1
            if pend >= 3:
                new = tgt; pend_t = None; pend = 0
        else:
            pend_t = None; pend = 0
        if new != cur:
            if new == "DIST":
                sig.append("S1")
            phase = new; pdays = 1
        else:
            pdays += 1
        gap_prev = gap
        out.append(dict(date=r["date"], close=close, phase=phase, phase_days=pdays, signals=sig,
                        hold_pct=hold_pct, peak_pct=peak_pct, cost=C if H > 0 else None, gap=gap,
                        F=F[i], I=I[i], dW=dW, d20=d20, indW=indW, ind20=ind20, retW=retW,
                        buy20=buy20, transfer=transfer, quiet=quiet, q=q))
    return out


BUY_SIG = ("B1", "B2")
SELL_SIG = ("S1", "S2", "S3", "S4")


def recency_pts(ago):
    if ago is None:
        return 0
    return 40 if ago == 0 else (25 if ago <= 2 else (10 if ago <= 4 else 0))


def last_signal(series, kinds):
    """가장 최근 kinds 신호와 몇 거래일 전인지."""
    n = len(series)
    for k in range(n - 1, -1, -1):
        hit = [s for s in series[k]["signals"] if s in kinds]
        if hit:
            return hit[-1], n - 1 - k, series[k]["date"]
    return None, None, None


def gap_pts(gap):
    if gap is None or gap < 0:
        return 0
    return 15 if gap <= 0.10 else (7 if gap <= 0.20 else 0)
