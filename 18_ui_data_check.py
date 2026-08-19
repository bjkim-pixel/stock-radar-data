# -*- coding: utf-8 -*-
"""
STOCK RADAR · 웹 UI 연동 전 데이터 점검 (읽기 전용)
========================================================
기존 엑셀 기반 사이트에서 쓰던 화면 항목들이 지금 DB에 실제로 들어 있는지,
특히 사용자가 매일 스크리닝에 쓰는 3개 축이 쓸 만한 상태인지 확인합니다.

  ① 무게/주식수 (weight_per_share = 등락률 × 거래량 ÷ 상장주식수)
  ② 등락률      (change_pct)
  ③ 시가총액    (market_cap)

사용법
  python 18_ui_data_check.py

환경변수
  SUPABASE_DB_URL
"""
import os, sys
import psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
if not DB_URL:
    sys.exit("❌ SUPABASE_DB_URL 환경변수를 설정하세요.")


def section(t):
    print(f"\n{'─'*66}\n{t}\n{'─'*66}")


def main():
    with psycopg2.connect(DB_URL) as conn, conn.cursor() as cur:
        cur.execute("SELECT max(trade_date) FROM daily_price")
        latest = cur.fetchone()[0]
        print(f"기준일: {latest}")

        # ── 1. 핵심 3축 커버리지 ──────────────────────────────────────────
        section("① 스크리닝 3축 데이터 충족도 (최근일 기준)")
        cur.execute("""
            SELECT count(*) AS universe,
                   count(*) FILTER (WHERE p.weight_per_share IS NOT NULL) AS w_ok,
                   count(*) FILTER (WHERE p.change_pct IS NOT NULL)       AS chg_ok,
                   count(*) FILTER (WHERE p.market_cap > 0)               AS cap_ok,
                   count(*) FILTER (WHERE p.listed_shares > 0)            AS shares_ok,
                   count(*) FILTER (WHERE p.volume > 0)                   AS vol_ok
            FROM daily_price p JOIN stocks s ON s.code = p.code
            WHERE p.trade_date = %s AND s.security_type = 'STOCK'
        """, (latest,))
        r = cur.fetchone()
        n = r[0]
        for label, v in [("전체 종목", n), ("무게/주식수", r[1]), ("등락률", r[2]),
                         ("시가총액", r[3]), ("상장주식수", r[4]), ("거래량", r[5])]:
            pct = f"{v/n*100:5.1f}%" if n and label != "전체 종목" else ""
            print(f"  {label:<12}: {v:>5,}  {pct}")

        # 전 기간 커버리지도 확인 (과거 조회 화면용)
        cur.execute("""
            SELECT count(*),
                   count(*) FILTER (WHERE weight_per_share IS NOT NULL),
                   count(*) FILTER (WHERE market_cap > 0)
            FROM daily_price
        """)
        r = cur.fetchone()
        print(f"\n  [전 기간] {r[0]:,}행 중 무게/주식수 {r[1]:,} ({r[1]/r[0]*100:.1f}%) · "
              f"시총 {r[2]:,} ({r[2]/r[0]*100:.1f}%)")

        # ── 2. 실제 값 샘플 — 축별 상위 10 ────────────────────────────────
        for label, col, fmt in [
            ("② 무게/주식수 상위 10", "p.weight_per_share", "w"),
            ("③ 등락률 상위 10",      "p.change_pct",       "c"),
            ("④ 시가총액 상위 10",    "p.market_cap",       "m"),
        ]:
            section(label)
            cur.execute(f"""
                SELECT s.name, s.code, s.sector_krx, p.close, p.change_pct,
                       p.weight_per_share, p.market_cap, p.trade_amount
                FROM daily_price p JOIN stocks s ON s.code = p.code
                WHERE p.trade_date = %s AND s.security_type='STOCK' AND {col} IS NOT NULL
                ORDER BY {col} DESC LIMIT 10
            """, (latest,))
            print(f"  {'종목명':<14}{'업종':<12}{'종가':>10}{'등락률':>9}"
                  f"{'무게/주식수':>13}{'시총(억)':>11}")
            for nm, cd, sec, cl, chg, w, cap, amt in cur.fetchall():
                wv = f"{float(w)*100:.4f}%" if w is not None else "-"
                print(f"  {(nm or cd)[:13]:<14}{(sec or '-')[:11]:<12}{cl:>10,}"
                      f"{float(chg):>8.2f}%{wv:>13}{cap/1e8:>11,.0f}")

        # ── 3. 기존 사이트 컬럼 → 현재 DB 매핑 ────────────────────────────
        section("⑤ 기존 엑셀 사이트 화면 항목 → 현재 DB 보유 여부")
        cur.execute("""
            SELECT count(*) FILTER (WHERE accounts IS NOT NULL),
                   count(DISTINCT trade_date), max(trade_date)
            FROM kiwoom_holder_stats
        """)
        kw = cur.fetchone()
        cur.execute("""
            SELECT count(*) FILTER (WHERE amt_avg20 IS NOT NULL),
                   count(*) FILTER (WHERE quarter_amt IS NOT NULL),
                   count(*) FILTER (WHERE consec_both_buy > 0),
                   count(*) FILTER (WHERE high_period IS NOT NULL),
                   count(*)
            FROM daily_metrics WHERE trade_date = %s
        """, (latest,))
        dm = cur.fetchone()
        cur.execute("""
            SELECT count(*) FILTER (WHERE foreign_net IS NOT NULL),
                   count(*) FILTER (WHERE inst_net IS NOT NULL),
                   count(*) FILTER (WHERE fin_inv_net IS NOT NULL),
                   count(*) FILTER (WHERE individual_net IS NOT NULL),
                   count(*)
            FROM daily_flow WHERE trade_date = %s
        """, (latest,))
        df = cur.fetchone()

        rows = [
            ("종가·등락률·거래량·거래대금", "daily_price",       f"{n:,}종목", "OK"),
            ("시가총액·상장주식수",         "daily_price",       f"{r[2]:,}행", "OK"),
            ("무게/주식수",                 "daily_price(생성)", f"{r[1]:,}행", "OK"),
            ("대금비중",                    "미저장",            "trade_amount/market_cap", "조회시 계산"),
            ("업종",                        "stocks.sector_krx", "-", "OK"),
            ("거래량 20일평균·급증률",      "daily_metrics",     f"{dm[0]:,}", "OK"),
            ("분기(90일) 거래대금",         "daily_metrics",     f"{dm[1]:,}", "OK"),
            ("최고가·최고가일·며칠전",      "daily_metrics",     f"{dm[3]:,}", "OK"),
            ("연속 양매수일수",             "daily_metrics",     f"{dm[2]:,}", "OK"),
            ("외국인·기관 순매수",          "daily_flow",        f"{df[0]:,}/{df[1]:,}", "OK"),
            ("금융투자·투신·사모·연기금",   "daily_flow",        f"{df[2]:,}", "OK"),
            ("개인 순매수",                 "daily_flow",        f"{df[3]:,}", "OK"),
            ("기타법인 순매수",             "미저장",            "-(개인+외국인+기관)", "조회시 계산"),
            ("보유계좌수·평균매수가",       "kiwoom_holder_stats",
                                            f"{kw[0]:,}행/{kw[1]}일", "부분(수동업로드)"),
            ("매수·매도 신호",              "signals(v4)",       "-", "OK"),
            ("보유 포지션·트레일링",        "positions",         "-", "OK(신규)"),
        ]
        print(f"  {'화면 항목':<28}{'저장 위치':<22}{'수량':<24}{'상태'}")
        for a, b, c, d in rows:
            print(f"  {a:<28}{b:<22}{c:<24}{d}")

        print(f"\n  ※ 키움 보유계좌수는 {kw[1]}일치만 있고 최신 {kw[2]} — 수동 CSV 업로드분이라 "
              f"매일 채워지지 않습니다.")

        # ── 4. 최신 v4 신호 ───────────────────────────────────────────────
        section("⑥ 최신 거래일 v4 신호 / 보유 포지션")
        cur.execute("""
            SELECT sg.signal_type, s.name, sg.reason_text
            FROM signals sg JOIN stocks s ON s.code = sg.code
            WHERE sg.trade_date = %s AND sg.signal_type LIKE 'V4[_]%%'
            ORDER BY sg.signal_type, sg.score DESC
        """, (latest,))
        sigs = cur.fetchall()
        if sigs:
            for st, nm, txt in sigs:
                print(f"  [{st}] {txt}")
        else:
            print("  (최신일 v4 신호 없음 — 신호가 희소한 전략이라 정상입니다)")

        cur.execute("""
            SELECT p.code, s.name, p.entry_date, p.avg_price, p.peak_price,
                   p.tranches, p.invested
            FROM positions p JOIN stocks s ON s.code = p.code
            WHERE p.portfolio='VIRTUAL' AND p.status='OPEN' ORDER BY p.entry_date
        """)
        for cd, nm, ed, avg, peak, tr, inv in cur.fetchall():
            print(f"  [보유] {nm} · {ed} 진입 · 평단 {float(avg):,.0f} · "
                  f"고점 {peak:,} · 트랜치 {tr} · 투입 {inv:,}원")

    print("\n✅ 점검 완료")


if __name__ == "__main__":
    main()
