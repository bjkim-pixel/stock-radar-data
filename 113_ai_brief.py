"""AI 데일리 브리핑 — 장마감 후 우리 DB로 다이제스트를 만들고 Gemini Flash가 종합·선별합니다.

원칙: 숫자·순위·방향 판정은 이 코드가 계산하고(다이제스트), AI는 그 다이제스트만 보고 해석·선별만 합니다.
AI가 고른 종목은 후보 목록(candidates)에 있는 코드만 인정하고, 검증 실패 시 1회 재요청 → 그래도 실패면
규칙 점수 상위 후보만 담은 fallback으로 저장합니다(사이트는 'AI 미생성'으로 표시).

사용: SUPABASE_DB_URL=... GEMINI_API_KEY=... python 113_ai_brief.py --round auto|1|2 [--force] [--report r.md]
  round auto: 지금 KST 18시 이전이면 1(16시 데이터), 이후면 2(18시 데이터). 같은 (날짜, 회차)가 이미 있으면 건너뜀(--force면 덮어씀).
모델은 유튜브 포털과 같은 방식: GEMINI_MODEL(기본 gemini-flash-latest) → 혼잡(429/5xx)이면 재시도 후 gemini-flash-lite-latest.
"""
import os, sys, json, re, time, datetime, math
import psycopg2, psycopg2.extras, requests

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-flash-latest"
EOK = 1e8
KST = datetime.timezone(datetime.timedelta(hours=9))
ARGS = sys.argv[1:]
def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS and ARGS.index(name) + 1 < len(ARGS) else default
REPORT = arg("--report")
MIN_AMT_EOK = float(arg("--min-amt", "") or os.environ.get("MIN_AMT_EOK", "") or 300)   # 후보 최소 거래대금(억원) — 소형주 작전 우려로 300억 이상(2026-11-04)
lines = []
def log(m=""):
    print(m, flush=True); lines.append(str(m))

def f(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None
def r1(v, n=1):
    x = f(v)
    return None if x is None else round(x, n)
def eok(v):
    x = f(v)
    return None if x is None else round(x / EOK)
def pct(a, b):
    a, b = f(a), f(b)
    return None if a is None or not b else round((a / b - 1) * 100, 2)

def rows(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]
    except Exception as ex:
        cur.connection.rollback()
        log(f"- ⚠ 조회 실패: {sql[:70]}… → {str(ex)[:160]}")
        return []

# ─────────────────────────────── 다이제스트 ───────────────────────────────
SUBJ = [("foreign", "외국인"), ("inst", "기관합계"), ("individual", "개인"), ("corp_other", "기타법인"),
        ("fin_inv", "금융투자"), ("inv_trust", "투신"), ("pension", "연기금"), ("pe", "사모"), ("program", "프로그램")]

def dir_of(w, m):
    """5일(w)·20일(m) 등락률(%)로 방향 판정."""
    w, m = f(w), f(m)
    if w is None and m is None:
        return "?"
    s = (w or 0) * 0.6 + (m or 0) * 0.4
    return "↑" if s > 1.0 else "↓" if s < -1.0 else "→"

def pack_items(pack, gid, limit=None):
    if not pack:
        return []
    g = next((g for g in pack.get("groups", []) if g.get("id") == gid), None)
    if not g:
        return []
    out = []
    for k in g.get("keys", [])[: limit or 999]:
        it = (pack.get("items") or {}).get(k) or {}
        m = it.get("m") or {}
        if not it:
            continue
        out.append({"n": it.get("n"), "1d": r1(m.get("d"), 2), "5d": r1(m.get("w")), "20d": r1(m.get("m")),
                    "60d": r1(m.get("m3")), "고점대비": r1(m.get("hi")), "추세": {2: "상승", 1: "50일선 위", 0: "50일선 아래"}.get(m.get("tr")),
                    "국면": {"lead": "주도", "impr": "개선", "weak": "둔화", "lag": "부진"}.get(m.get("ph")),
                    "방향": dir_of(m.get("w"), m.get("m"))})
    return out

# 국내 업종 ↔ 미국 섹터·테마 연결표(키워드가 업종명에 들어 있으면 해당 미국 항목을 붙임). (구분, 이름)은 global_pack(US)의 항목명 그대로.
KR_US_MAP = [
    (("반도체",), [("sector", "기술"), ("index", "반도체"), ("index", "메모리"), ("theme", "반도체"), ("theme", "AI 슈퍼사이클")]),
    (("IT", "플랫폼", "소프트", "인터넷", "게임"), [("sector", "기술"), ("sector", "커뮤니케이션"), ("theme", "소프트웨어"), ("theme", "클라우드")]),
    (("2차전지", "배터리", "전지"), [("theme", "리튬·배터리"), ("sector", "경기소비재")]),
    (("바이오", "제약", "헬스"), [("sector", "헬스케어"), ("theme", "비만치료제"), ("theme", "유전체")]),
    (("자동차", "모빌리티"), [("sector", "경기소비재"), ("theme", "리튬·배터리")]),
    (("소비재", "유통", "화장품", "음식", "식품", "의류", "여행", "레저"), [("sector", "경기소비재"), ("sector", "필수소비재")]),
    (("금융", "증권", "은행", "보험"), [("sector", "금융"), ("theme", "BDC·사모대출"), ("theme", "스테이블코인")]),
    (("에너지", "정유", "가스"), [("sector", "에너지"), ("theme", "가스발전·터빈")]),
    (("화학", "철강", "소재", "금속"), [("sector", "소재")]),
    (("인프라", "건설", "전력", "전기", "원전", "원자력"), [("sector", "산업재"), ("sector", "유틸리티"), ("theme", "미국 전력화"), ("theme", "원자력"), ("theme", "데이터센터 공급망")]),
    (("조선", "해운", "운송", "항공"), [("sector", "산업재"), ("theme", "글로벌 해운")]),
    (("방산", "우주"), [("theme", "방산 테크"), ("theme", "우주 혁신"), ("theme", "드론")]),
    (("기계", "장비", "로봇"), [("sector", "산업재"), ("theme", "휴머노이드"), ("theme", "드론")]),
    (("통신",), [("sector", "커뮤니케이션")]),
    (("엔터", "미디어", "콘텐츠"), [("sector", "커뮤니케이션")]),
    (("부동산", "리츠"), [("sector", "부동산")]),
]

def us_link_for(sector, usmap):
    """업종명 → 연결된 미국 섹터·테마 지표 목록 + 한 줄 요약(문자열)."""
    seen, out = set(), []
    for kws, targets in KR_US_MAP:
        if any(k in (sector or "") for k in kws):
            for g, n in targets:
                it = usmap.get((g, n))
                if it and (g, n) not in seen:
                    seen.add((g, n)); out.append({"미국": n, "구분": {"sector": "섹터", "theme": "테마", "index": "지수·ETF"}[g],
                                                  "5d": it.get("5d"), "20d": it.get("20d"), "추세": it.get("추세"), "국면": it.get("국면")})
    out = out[:4]
    if not out:
        return None, None
    v5 = [x["5d"] for x in out if x["5d"] is not None]; v20 = [x["20d"] for x in out if x["20d"] is not None]
    med = lambda v: (sorted(v)[len(v) // 2] if len(v) % 2 else sum(sorted(v)[len(v) // 2 - 1:len(v) // 2 + 1]) / 2) if v else None
    a5, a20 = med(v5), med(v20)   # 평균이 아니라 중앙값 — 한 테마의 극단값에 판정이 끌려가지 않게
    tag = "미국 강세" if (a5 is not None and a5 > 1 and (a20 or 0) > 0) else "미국 약세" if (a5 is not None and a5 < -1 and (a20 or 0) < 0) else "미국 혼조"
    txt = " · ".join(f"{x['미국']}({x['구분']}) 5일 {x['5d']:+.1f}%/20일 {x['20d']:+.1f}%" if x["5d"] is not None and x["20d"] is not None else x["미국"] for x in out)
    return {"연계": out, "판정": tag, "5d중앙": r1(a5), "20d중앙": r1(a20)}, f"{tag}: {txt}"

def build_digest(conn):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("set statement_timeout = '120s'")
    st = rows(cur, "select * from v_data_status")
    d0 = rows(cur, "select max(trade_date) as d from daily_price")[0]["d"]
    D = {"기준일": d0.isoformat(), "데이터상태": "잠정(장중치 포함)" if st and st[0].get("is_partial") else "장마감 확정"}

    # 1) 국내 시장 — 지수·거래대금·수급주체
    mk = {}
    for m in ("KOSPI", "KOSDAQ"):
        r = rows(cur, "select trade_date, index_close, index_ma20, regime from market_daily where market=%s and index_close is not null order by trade_date desc limit 25", (m,))
        if r:
            c = [x["index_close"] for x in r]
            mk[m] = {"종가": r1(c[0], 2), "1d": pct(c[0], c[1]) if len(c) > 1 else None, "5d": pct(c[0], c[5]) if len(c) > 5 else None,
                     "20d": pct(c[0], c[20]) if len(c) > 20 else None, "20일선대비": pct(c[0], r[0].get("index_ma20")), "레짐": r[0].get("regime")}
    ov = rows(cur, "select * from v_market_overview order by trade_date desc limit 1")
    if ov:
        mk["거래대금"] = {"오늘_조원": r1(f(ov[0].get("total_amount")) / 1e12 if f(ov[0].get("total_amount")) else None, 1),
                       "20일평균대비%": pct(ov[0].get("total_amount"), ov[0].get("amt_ma20"))}
    fp = rows(cur, "select * from v_market_flow_periods")
    if fp:
        fp = fp[0]
        mk["수급_억원"] = {lb: {"오늘": eok(fp.get(k + "_1d")), "1주": eok(fp.get(k + "_1w")), "1개월": eok(fp.get(k + "_1m"))}
                         for k, lb in SUBJ if fp.get(k + "_1d") is not None or fp.get(k + "_1w") is not None}
    D["국내시장"] = mk

    # 2) 업종 — RS 순위·거래대금·수급·신흥주도/이탈조짐 + 최근 5일 업종 수급
    sr = rows(cur, "select * from v_sector_rank")
    sf = rows(cur, """select sector, sum(coalesce(foreign_net,0)+coalesce(inst_net,0)) as combo, sum(coalesce(individual_net,0)) as indiv
                      from sector_flow_daily where trade_date in (select distinct trade_date from sector_flow_daily order by trade_date desc limit 5)
                      group by sector""")
    sf5 = {x["sector"]: x for x in sf}
    secs = []
    for x in sr:
        if not x.get("sector"):
            continue
        secs.append({"업종": x["sector"], "RS20순위": x.get("rs_rank"), "RS5순위": x.get("rs5_rank"), "오늘평균등락%": r1(x.get("avg_change_pct"), 2),
                     "거래대금비중%": r1(x.get("share_pct")), "거래대금주간증감%": r1(x.get("amt_chg_1w_pct")),
                     "외국인오늘억": eok(x.get("foreign_net")), "기관오늘억": eok(x.get("inst_net")),
                     "외기합5일억": eok((sf5.get(x["sector"]) or {}).get("combo")), "개인5일억": eok((sf5.get(x["sector"]) or {}).get("indiv")),
                     "신흥주도": bool(x.get("is_emerging_leader")), "이탈조짐": bool(x.get("is_weakening_leader")), "종목수": x.get("stock_count")})
    secs.sort(key=lambda s: (s["RS5순위"] or 99) + (s["RS20순위"] or 99))
    D["업종"] = secs[:22]
    cl = rows(cur, "select * from v_sector_cluster where trade_date = %s", (d0,))
    D["클러스터_같은업종_동반매수"] = [{"업종": c.get("sector_krx"), "외국인동반": c.get("foreign_cnt"), "기관동반": c.get("inst_cnt"),
                                 "종목": (c.get("foreign_names") or c.get("inst_names") or [])[:6]} for c in cl][:8]

    # 3) 종목 — 유동성 통과 종목의 특징값 + 스윙 점수(규칙) → 후보 30
    sc = rows(cur, "select * from v_screener where trade_date = %s", (d0,))
    per = {x["code"]: x for x in rows(cur, "select * from v_stock_flow_periods")}
    sm = {x["code"]: x for x in rows(cur, "select code, phase, phase_days, changed_today, quiet from smart_money_state")}
    sec_rank = {s["업종"]: s for s in secs}
    U = []
    thr = MIN_AMT_EOK
    if sum(1 for r in sc if (f(r.get("market_cap")) or 0) >= 1000 * EOK and (f(r.get("trade_amount")) or 0) >= thr * EOK) < 30 and thr > 100:
        log(f"- ⚠ 거래대금 {thr:g}억 이상이 30종목 미만 — 100억으로 완화")   # 거래 부진일 안전장치
        thr = 100
    D["후보_최소거래대금억"] = thr
    for r in sc:
        cap, amt = f(r.get("market_cap")) or 0, f(r.get("trade_amount")) or 0
        if cap < 1000 * EOK or amt < thr * EOK:
            continue
        p = per.get(r["code"], {})
        combo1 = (f(r.get("foreign_net")) or 0) + (f(r.get("inst_net")) or 0)
        combo5 = (f(p.get("foreign_1w")) or 0) + (f(p.get("inst_1w")) or 0)
        U.append({"r": r, "cap": cap, "amt": amt, "combo1": combo1, "combo5": combo5,
                  "c1r": combo1 / cap * 100, "c5r": combo5 / cap * 100, "sm": sm.get(r["code"], {})})
    def prank(key):
        vals = sorted(u[key] for u in U)
        n = len(vals)
        for u in U:
            lo = sum(1 for v in vals if v < u[key])
            u[key + "_p"] = lo / max(n - 1, 1)
    for k in ("c1r", "c5r"):
        prank(k)
    for u in U:
        r = u["r"]; chg = f(r.get("change_pct")) or 0
        mom = 0.15 * (f(r.get("rs5_pctl")) or 50) + 0.10 * (f(r.get("rs20_pctl")) or 50) + (5 if 2 <= chg < 12 else 2 if 0 < chg < 2 else 1 if chg >= 12 else 0)
        flow = 15 * u["c1r_p"] + 12 * u["c5r_p"] + min(int(r.get("consec_both_buy") or 0), 5) * 1.6
        trend = (7 if r.get("ma_aligned") else 0) + (6 if r.get("is_new_high") or r.get("is_new_high_all") else 4 if r.get("near_high") else 0) \
                + (7 * (f(r.get("close_pos_pct")) or 50) / 100)
        srk = (sec_rank.get(r.get("sector")) or {}).get("RS5순위") or 22
        sect = max(0, 15 - (srk - 1) * 0.9)
        risk = []
        if chg >= 15: risk.append("당일 급등(추격 위험)")
        if (f(r.get("individual_net")) or 0) > 0 and u["combo1"] < 0: risk.append("개인만 매수·외기 매도")
        if (u["sm"].get("phase") or "") in ("DIST", "DOWN"): risk.append("스마트머니 분산 국면")
        if (f(r.get("vol_ratio20_prev")) or 0) >= 400: risk.append("거래량 과열")
        u["score"] = round(mom + flow + trend + sect - 6 * len(risk), 1)
        u["risk"] = risk
    U.sort(key=lambda u: -u["score"])

    def feat(u):
        r = u["r"]
        return {"code": r["code"], "name": r.get("name"), "시장": r.get("market"), "업종": r.get("sector"),
                "종가": f(r.get("close")), "등락%": r1(r.get("change_pct"), 2), "거래대금억": round(u["amt"] / EOK), "시총조": round(u["cap"] / 1e12, 2),
                "외국인오늘억": eok(r.get("foreign_net")), "기관오늘억": eok(r.get("inst_net")), "개인오늘억": eok(r.get("individual_net")),
                "외기합5일억": round(u["combo5"] / EOK), "외기합오늘_시총대비%": round(u["c1r"], 3), "프로그램오늘억": eok(r.get("pgtr_net_amt")),
                "연속양매수일": r.get("consec_both_buy"), "RS5백분위": r1(r.get("rs5_pctl"), 0), "RS20백분위": r1(r.get("rs20_pctl"), 0),
                "거래량비%": r1(r.get("vol_ratio20_prev"), 0), "신고가": bool(r.get("is_new_high") or r.get("is_new_high_all")),
                "고점대비%": r1(r.get("pct_from_high")), "정배열": bool(r.get("ma_aligned")), "종가위치%": r1(r.get("close_pos_pct"), 0),
                "업종RS순위": r.get("sector_rs_rank"), "추세추종신호": r.get("signal_type") == "V4_CANDIDATE",
                "스마트머니국면": {"ACC": "매집·보합", "MARKUP": "매집·상승", "DIST": "분산·전가", "DOWN": "분산·이탈", "NEUTRAL": "중립"}.get(u["sm"].get("phase")),
                "규칙점수": u["score"], "리스크": u["risk"]}
    cands = [feat(u) for u in U[:30]]
    D["후보종목"] = cands
    top = lambda key, n=8, rev=True: [{"name": u["r"].get("name"), "code": u["r"]["code"], "업종": u["r"].get("sector"), "등락%": r1(u["r"].get("change_pct"), 2),
                                       "외기합오늘억": round(u["combo1"] / EOK)} for u in sorted(U, key=key, reverse=rev)[:n]]
    D["강한종목"] = {"등락률상위": top(lambda u: f(u["r"].get("change_pct")) or -99),
                  "외기합순매수상위": top(lambda u: u["combo1"]),
                  "외기합순매도상위": top(lambda u: u["combo1"], rev=False),
                  "신고가": [x["name"] for x in (feat(u) for u in U) if x["신고가"]][:15]}
    D["유동성통과종목수"] = len(U)

    # 3-2) 내 종목(관심·투자) — 후보 필터와 무관하게 watchlist 전체를 평가
    D["내종목"] = build_mine(cur.connection, cur, sc, per, sm, sec_rank, len(secs), mk)

    # 4~6) 미국·글로벌·매크로 — global_pack(이미 계산된 지표)
    packs = {x["tab"]: x["payload"] for x in rows(cur, "select tab, payload from global_pack")}
    for k, v in list(packs.items()):
        if isinstance(v, str):
            packs[k] = json.loads(v)
    us, kr, gl = packs.get("US"), packs.get("KR"), packs.get("GL")
    D["미국"] = {"기준일": (us or {}).get("as_of"), "지수": pack_items(us, "index"), "섹터": pack_items(us, "sector"), "테마": pack_items(us, "theme", 14)}
    D["글로벌_국가지수"] = {"기준일": (gl or {}).get("as_of"), "국가": pack_items(gl, "country")}
    D["매크로"] = {"미국": pack_items(us, "macro"), "한국": pack_items(kr, "index") + pack_items(kr, "credit")}
    D["한국테마ETF"] = pack_items(kr, "theme", 30)

    # 4-2) 국내 업종 ↔ 미국 섹터·테마 연계 — AI가 '국내 수치 + 미국 확인'을 함께 근거로 쓰도록 업종마다 붙임
    usmap = {}
    for g in ("sector", "theme", "index"):
        for it in pack_items(us, g):
            usmap[(g, it["n"])] = it
    for sx in D["업종"]:
        d, _ = us_link_for(sx["업종"], usmap)
        if d:
            sx["미국연계"] = d
    ust = [x for g in ("sector", "theme") for x in pack_items(us, g) if x.get("20d") is not None]
    ust.sort(key=lambda x: -(x["20d"] or 0))
    D["미국_강약요약"] = {"강한_상위5(20일)": [{"n": x["n"], "5d": x["5d"], "20d": x["20d"]} for x in ust[:5]],
                      "약한_하위5(20일)": [{"n": x["n"], "5d": x["5d"], "20d": x["20d"]} for x in ust[-5:]]} if ust else None
    D["_us_link_txt"] = {sx["업종"]: us_link_for(sx["업종"], usmap)[1] for sx in D["업종"] if sx.get("미국연계")}
    return D


# ─────────────────────────────── 내 종목(관심·투자) 매수/보유/매도 의견 ───────────────────────────────
PHASE_KR = {"ACC": "매집·보합", "MARKUP": "매집·상승", "DIST": "분산·전가", "DOWN": "분산·이탈", "NEUTRAL": "중립"}

def journal_cost(cur, codes):
    """투자일지(journal_entries)의 매수·매도 기록 → 종목별 평균단가법 평단·보유수량."""
    out = {}
    if not codes:
        return out
    try:
        cur.execute("""select stock_code, kind, price, qty from journal_entries
                       where stock_code = any(%s) and kind in ('매수','매도') and price is not null and qty is not null
                       order by entry_date, id""", (list(codes),))
        for code, kind, price, qty in cur.fetchall():
            price, qty = float(price), float(qty)
            s = out.setdefault(code, {"qty": 0.0, "cost": 0.0})
            if kind == "매수":
                s["cost"] = (s["cost"] * s["qty"] + price * qty) / (s["qty"] + qty) if s["qty"] + qty else price
                s["qty"] += qty
            else:
                s["qty"] -= qty
                if s["qty"] <= 0:
                    s["qty"], s["cost"] = 0.0, 0.0
    except Exception as ex:
        cur.connection.rollback(); log(f"- ⚠ 투자일지 조회 실패(평단 생략): {str(ex)[:100]}")
    return {c: v for c, v in out.items() if v["qty"] > 0}

def score_mine(r, p, smrow, sec_rank, n_sec, held, avg_cost, etf=None):
    """한 종목의 정량 점수와 근거(항목·값·점수·해석). 모든 숫자는 DB 값, 임계값은 아래 코드 그대로 — AI는 계산하지 않는다."""
    ev = []
    def add(item, val, pts, why):
        ev.append({"항목": item, "값": val, "점수": pts, "설명": why})
    close = f(r.get("close")); chg = f(r.get("change_pct")) or 0
    ma5, ma20, ma60, ma120 = (f(r.get("ma" + k)) for k in ("5", "20", "60", "120"))
    cap = f(r.get("market_cap")) or 0
    is_etf = bool(etf)
    # 1) 추세 — 이동평균 배열
    if close and ma20 and ma60:
        g20, g60 = (close / ma20 - 1) * 100, (close / ma60 - 1) * 100
        aligned = bool(r.get("ma_aligned"))
        if aligned:   pts, why = 2, "종가>5>20>60>120일선 정배열 — 상승 추세"
        elif close > ma20 and ma20 > ma60: pts, why = 1, "20일선 위 · 20>60일선 — 상승 추세 유지"
        elif close < ma60: pts, why = -2, "60일선 아래 — 중기 추세 이탈"
        elif close < ma20: pts, why = -1, "20일선 아래 — 단기 추세 약화"
        else: pts, why = 0, "이평선 혼조"
        add("추세(이평)", f"20일선 {g20:+.1f}% · 60일선 {g60:+.1f}%", pts, why)
    # 2) 상대강도
    rs5, rs20 = f(r.get("rs5_pctl")), f(r.get("rs20_pctl"))
    if rs5 is not None and rs20 is not None:
        avg = (rs5 + rs20) / 2
        pts, why = (1, "시장 대비 상위권 — 강세") if avg >= 70 else (-1, "시장 대비 하위권 — 약세") if avg <= 30 else (0, "시장 평균 수준")
        add("상대강도(RS)", f"5일 {rs5:.0f} · 20일 {rs20:.0f} 백분위", pts, why)
    # 3) 5일 외국인+기관 수급 (시총 대비)
    combo5 = (f(p.get("foreign_1w")) or 0) + (f(p.get("inst_1w")) or 0)
    if is_etf:   # ETF는 투자자별 수급·스마트머니·업종 순위가 없음 — 대신 시장 환경(인버스·레버리지)과 거래량으로 판단
        add("수급·업종", "ETF는 투자자별 수급 미집계", 0, "가격·상대강도·거래량·시장 환경으로만 판단")
        gap = etf.get("gap")
        if etf.get("kind") in ("인버스", "레버리지") and gap is not None:
            sign = -1 if etf["kind"] == "인버스" else 1       # 인버스는 지수가 약할 때, 레버리지는 강할 때 유리
            g = gap * sign
            pts, why = (1, f"{etf['idx']}가 20일선 {'아래' if sign < 0 else '위'} — {etf['kind']} ETF에 유리한 환경") if g >= 2 \
                else (-1, f"{etf['idx']}가 20일선 {'위' if sign < 0 else '아래'} — {etf['kind']} ETF에 불리한 환경") if g <= -2 else (0, "지수가 20일선 부근 — 방향성 약함")
            add("시장 환경(지수)", f"{etf['idx']} 20일선 대비 {gap:+.1f}%", pts, why)
        if etf.get("kind") in ("인버스", "레버리지"):
            add("상품 특성", f"{etf['kind']} ETF", 0, "일간 수익률을 추종 — 길게 들고 가면 복리 효과로 지수와 어긋나 손실 가능(단기용)")
    elif cap:
        c5r = combo5 / cap * 100
        pts, why = (2, "외기 5일 순매수가 시총의 0.1%↑ — 강한 매집") if c5r >= 0.1 else (1, "외기 5일 순매수 우위") if c5r > 0 \
            else (-2, "외기 5일 순매도가 시총의 0.1%↑ — 강한 이탈") if c5r <= -0.1 else (-1, "외기 5일 순매도 우위")
        add("수급(5일 외국인+기관)", f"{round(combo5 / EOK):+,}억 (시총대비 {c5r:+.3f}%)", pts, why)
    # 4) 오늘 수급 + 연속 매수
    combo1 = (f(r.get("foreign_net")) or 0) + (f(r.get("inst_net")) or 0)
    indiv = f(r.get("individual_net")) or 0
    consec = int(r.get("consec_both_buy") or 0)
    if is_etf: pass
    elif combo1 > 0 and consec >= 2: pts, why = 1, f"외국인·기관 {consec}일 연속 동반 순매수"
    elif combo1 < 0 and indiv > 0: pts, why = -1, "개인만 사고 외국인·기관은 파는 수급(물량 넘기기 패턴)"
    else: pts, why = 0, "뚜렷한 방향 없음"
    if not is_etf: add("수급(오늘·연속)", f"외기 {round(combo1 / EOK):+,}억 · 개인 {round(indiv / EOK):+,}억 · 연속 {consec}일", pts, why)
    # 5) 스마트머니 국면
    ph = (smrow or {}).get("phase")
    if ph:
        pts = {"MARKUP": 2, "ACC": 1, "DIST": -2, "DOWN": -2}.get(ph, 0)
        add("스마트머니 국면", PHASE_KR.get(ph, ph), pts, {"MARKUP": "큰손이 사 모으며 상승 중", "ACC": "큰손 매집 구간", "DIST": "고점권에서 큰손이 개인에게 넘기는 중",
                                                            "DOWN": "주가가 내려오는데 큰손 이탈 지속"}.get(ph, "큰손 방향 뚜렷하지 않음"))
    # 6) 고점 위치·과열
    pf = f(r.get("pct_from_high")); vr = f(r.get("vol_ratio20_prev"))
    if pf is not None:
        if chg >= 15 or (vr is not None and vr >= 400 and chg >= 10):
            pts, why = -1, "당일 급등·거래량 과열 — 추격 위험"
        elif pf >= -3: pts, why = 1, "고점 부근/신고가 — 돌파 구간"
        elif pf <= -20: pts, why = -1, "고점 대비 -20% 이하 — 반등 근거 약함"
        else: pts, why = 0, "고점과 적당한 거리"
        add("고점 대비 위치", f"{pf:+.1f}% · 오늘 {chg:+.1f}% · 거래량비 {round(vr) if vr is not None else '–'}%", pts, why)
    # 7) 업종 강도
    sr = None if is_etf else (sec_rank.get(r.get("sector")) or {}).get("RS5순위")
    if sr is not None:
        pts, why = (1, "업종이 단기 상위권") if sr <= 5 else (-1, "업종이 단기 하위권") if sr >= n_sec - 4 else (0, "업종 중위권")
        add("업종 강도", f"{r.get('sector')} RS5 {sr}위/{n_sec}", pts, why)
    # 8) 내 포지션 (투자종목만)
    pnl = None
    if held and avg_cost and close:
        pnl = (close / avg_cost - 1) * 100
        if pnl <= -7: pts, why = -3, "평단 -7% 이하 — 손절 기준(트레일링 -7%) 도달"
        elif pnl <= -3: pts, why = -1, "평단 대비 손실 구간 — 손절선 접근"
        elif pnl >= 20: pts, why = 0, "수익 20%↑ — 20일선 이탈 시 이익 보호 청산 검토"
        else: pts, why = 0, "평단 부근~소폭 수익"
        add("내 평단 대비", f"평단 {avg_cost:,.0f}원 → {pnl:+.1f}%", pts, why)
    score = sum(e["점수"] for e in ev)
    # 판정 규칙: 보유 중이면 매수(추가)·보유·매도, 아니면 매수·관망·매도(=진입 회피)
    bt = (4 if is_etf else 5) if held else (3 if is_etf else 4)   # ETF는 평가 항목이 적어 매수 기준을 한 단계 낮춤
    if held:
        act = "매수" if score >= bt else "매도" if score <= -3 else "보유"
        if pnl is not None and pnl <= -7: act = "매도"
    else:
        act = "매수" if score >= bt else "매도" if score <= -3 else "관망"
    stop = None
    if close:
        stop = round(ma20 * 0.97) if ma20 else round(close * 0.95)
        if held and avg_cost: stop = max(stop, round(avg_cost * 0.93))
        if stop >= close: stop = round(close * 0.95)
    resist = round(close / (1 + pf / 100)) if (close and pf is not None and pf < 0) else (round(close) if close else None)
    return score, act, ev, stop, resist, pnl

def build_mine(conn, cur, sc, per, sm, sec_rank, n_sec, mk=None):
    """watchlist(관심·투자) 종목 + 투자일지 평단 → 정량 점수·규칙 판정·근거."""
    wl = rows(cur, "select kind, code, name from my_watchlist")
    if not wl:
        log("- 내 종목: my_watchlist 비어 있음(또는 테이블 없음) — 건너뜀")
        return []
    kinds = {}
    for w in wl:
        kinds.setdefault(w["code"], set()).add(w["kind"])
    names = {w["code"]: w["name"] for w in wl}
    holds = [c for c, k in kinds.items() if "hold" in k]
    cost = journal_cost(cur, holds)
    by = {r["code"]: r for r in sc}
    etf_by = {}
    miss = [c for c in kinds if c not in by]
    if miss:   # 주식 화면(v_screener)에 없으면 ETF 화면(v_etf_screener)에서 찾음 — ETF·인버스·레버리지
        for r in rows(cur, "select distinct on (code) * from v_etf_screener where code = any(%s) order by code, trade_date desc", (miss,)):
            etf_by[r["code"]] = r
    out = []
    for code, ks in kinds.items():
        r = by.get(code)
        etf = None
        if not r and code in etf_by:
            r = etf_by[code]; nm = r.get("name") or ""
            kind = "인버스" if "인버스" in nm else "레버리지" if "레버리지" in nm else "일반"
            idx = "KOSDAQ" if "코스닥" in nm else "KOSPI"
            etf = {"kind": kind, "idx": idx, "gap": ((mk or {}).get(idx) or {}).get("20일선대비")}
        if not r:
            log(f"- 내 종목 {names.get(code) or code}({code}): 오늘 데이터 없음 — 제외"); continue
        held = "hold" in ks
        c = cost.get(code)
        score, act, ev, stop, resist, pnl = score_mine(r, per.get(code, {}), sm.get(code, {}), sec_rank, n_sec, held, c["cost"] if c else None, etf)
        out.append({"code": code, "name": r.get("name") or names.get(code), "구분": ("투자" if held else "관심"), "유형": ("주식" if not etf else "인버스 ETF" if etf["kind"] == "인버스" else "레버리지 ETF" if etf["kind"] == "레버리지" else "ETF"),
                    "기준일": str(r.get("trade_date")) if etf else None, "업종": r.get("sector"),
                    "종가": f(r.get("close")), "등락%": r1(r.get("change_pct"), 2), "정량점수": score, "규칙판정": act,
                    "손절참고": stop, "직전고점": resist, "평단": round(c["cost"]) if c else None, "평단대비%": None if pnl is None else round(pnl, 1),
                    "근거": ev})
    out.sort(key=lambda x: (x["구분"] != "투자", -x["정량점수"]))
    log(f"- 내 종목 {len(out)}개 평가 (투자 {sum(1 for x in out if x['구분'] == '투자')} · 관심 {sum(1 for x in out if x['구분'] == '관심')})")
    return out

ACT_ORDER = {"매도": 0, "관망": 1, "보유": 1, "매수": 2}
def finalize_mine(D, res):
    """규칙 판정(코드) + AI 의견(Gemini)을 합쳐 res['mine']을 만든다. AI는 규칙 판정에서 한 단계까지만 조정 가능."""
    ai = {str(m.get("code", "")).strip(): m for m in (res.get("mine") or []) if isinstance(m, dict)}
    items = []
    for x in D.get("내종목") or []:
        held = x["구분"] == "투자"
        allowed = ("매수", "보유", "매도") if held else ("매수", "관망", "매도")
        a = ai.get(x["code"]) or {}
        act = a.get("action") if a.get("action") in allowed else x["규칙판정"]
        if abs(ACT_ORDER[act] - ACT_ORDER[x["규칙판정"]]) > 1:
            act = x["규칙판정"]
        ev = x["근거"]
        top = sorted(ev, key=lambda e: -abs(e["점수"]))[:2]
        auto = f"{x['규칙판정']} 판정: " + ", ".join(f"{e['항목']} {e['점수']:+d}({e['설명']})" for e in top if e["점수"]) if any(e["점수"] for e in top) else f"{x['규칙판정']} 판정: 뚜렷한 우위 항목 없음"
        neg = sorted([e for e in ev if e["점수"] < 0], key=lambda e: e["점수"])
        items.append({"code": x["code"], "name": x["name"], "kind": x["구분"], "etype": x.get("유형"), "action": act, "rule_action": x["규칙판정"], "score": x["정량점수"],
                      "opinion": (a.get("opinion") or auto), "risk": (a.get("risk") or (neg[0]["설명"] if neg else "")),
                      "stop": x["손절참고"], "resist": x["직전고점"], "avg_cost": x["평단"], "pnl_pct": x["평단대비%"],
                      "close": x["종가"], "chg": x["등락%"], "asof": x.get("기준일") or D["기준일"], "evidence": ev, "ai": bool(a.get("opinion"))})
    res["mine"] = items
    return res

# ─────────────────────────────── Gemini ───────────────────────────────
SCHEMA_HINT = """{
 "headline": "오늘 시장을 한 문장으로(40자 내외)",
 "stance": "공격 | 중립 | 방어 중 하나",
 "stance_reason": "왜 그 스탠스인지 2~3문장 (지수·수급·매크로 근거)",
 "market": "국내 시장 요약 3~4문장 (KOSPI/KOSDAQ 등락, 거래대금, 외국인·기관·개인 수급 방향)",
 "sectors": {"summary": "업종 흐름 2~3문장(국내 업종 + 미국 섹터·테마 동조/괴리 포함)", "strong": [{"name": "업종명", "reason": "국내 수치 + 미국연계 수치를 함께 인용한 근거 1~2문장"}], "weak": [{"name": "업종명", "reason": "국내 수치 + 미국연계 수치를 함께 인용한 근거 1~2문장"}]},
 "stocks_today": "오늘 강했던 종목들의 공통점 2~3문장 (종목명 언급 가능)",
 "us": "미국 지수·섹터·테마 요약 2~3문장과 국내 업종에 주는 시사점",
 "global": "국가별 지수 강약 1~2문장",
 "macro": {"summary": "금리·달러/원화·금·구리·원유·VIX 등의 방향이 주는 투자 방향 2~3문장",
           "items": [{"name": "지표명", "dir": "↑ | ↓ | →", "comment": "해석 1문장"}]},
 "focus_sectors": [{"name": "업종명(업종 목록의 이름 그대로)", "reason": "단기 스윙 관점 근거 — 국내 수치 + 미국연계 수치 인용"}],
 "picks": [{"code": "후보종목의 code 그대로", "name": "종목명", "reason": "선정 근거 1~2문장(수급·가격·업종)",
            "risk": "주의할 점 1문장", "invalidation": "이 조건이 나오면 관심 제외(구체적으로)"}],
 "mine": [{"code": "내종목의 code 그대로", "action": "내종목의 규칙판정과 같거나 한 단계 차이(매수|보유|관망|매도)", "opinion": "의견 2문장 — 근거 항목의 수치를 인용", "risk": "주의점 1문장"}],
 "avoid": [{"name": "업종 또는 유형", "reason": "국내 수치 + 미국연계 수치를 함께 인용한 근거 1~2문장"}],
 "checkpoints": ["내일 장에서 확인할 것 (3개)"]
}"""

def prompt_of(D, err=None):
    p = f"""너는 한국 주식 단기 스윙(보유 3~10거래일) 전문 애널리스트다. 아래 JSON은 오늘 장마감 후 우리 시스템이 계산한 데이터 전부다.
규칙:
1) 이 데이터에 있는 숫자·이름만 사용한다. 데이터에 없는 뉴스·실적·수치를 지어내지 않는다.
2) picks는 반드시 "후보종목" 목록의 code에서만 정확히 5개 고른다. 규칙점수는 참고용이며 그대로 상위 5개를 고르지 말고, 업종 흐름·수급 지속성·매크로와의 정합성·리스크를 종합해 판단한다. 같은 업종에 3개 이상 몰지 않는다.
3) focus_sectors는 3개, 업종 목록의 이름 그대로 쓴다. 업종 판단(sectors.strong/weak, focus_sectors, avoid)의 reason에는 반드시 ①국내 수치(RS순위·오늘등락·외기합5일억·거래대금 변화)와 ②해당 업종의 "미국연계"(미국 섹터·테마의 5일·20일 수익률과 판정)를 함께 인용한다. 국내 강세+미국 강세는 '미국 동조로 지속성 근거', 국내 강세+미국 약세는 '미국과 괴리 — 지속성 주의', 국내 약세+미국 강세는 '반등 후보', 국내 약세+미국 약세는 '회피 근거'처럼 두 쪽의 관계를 한 문장에 밝힌다. 미국연계 필드가 없는 업종은 국내 근거만 쓴다. "미국_강약요약"은 us 항목과 업종 판단의 배경으로 활용한다.
4) 금액 단위는 억원, 등락은 %. 문장은 한국어 존댓말 없이 간결한 보고서체(~임, ~함 아님, 평서문 '~다').
5) 투자 권유가 아니라 분석 보조임을 전제로, 단정 대신 조건·근거를 분명히 쓴다.
6) "내종목"이 비어 있지 않으면 mine에 내종목 전부를 code별로 한 번씩 쓴다. 각 종목(주식·ETF·인버스 ETF·레버리지 ETF 모두 포함, 유형 필드 참고)은 코드가 계산한 정량점수·규칙판정·근거(항목별 점수)를 따르며 — ETF는 수급 데이터가 없어 가격·RS·시장 환경으로만 판단했음을 의견에 반영하고, 인버스·레버리지는 단기용이라는 점과 지수 방향과의 관계를 언급하며, action은 규칙판정과 같거나 인접한 값만 가능(바꾸면 opinion에 이유). 근거에 없는 수치·뉴스를 쓰지 않는다. 투자 구분은 보유 중(매수=추가매수, 보유, 매도=청산·비중축소), 관심 구분은 미보유(매수=신규진입, 관망, 매도=진입 회피).
7) 출력은 아래 형식의 JSON 하나만. 마크다운 금지.
형식:
{SCHEMA_HINT}

데이터:
{json.dumps({k: v for k, v in D.items() if not k.startswith('_')}, ensure_ascii=False, separators=(',', ':'))}
"""
    if err:
        p += f"\n\n※ 직전 응답이 검증에 실패했다: {err}. 규칙을 지켜 다시 출력하라."
    return p

def call_gemini(prompt):
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4}}
    r, used = None, None
    for attempt, m in enumerate([MODEL, MODEL, "gemini-flash-lite-latest", "gemini-flash-lite-latest"]):
        try:
            r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent",
                              params={"key": KEY}, json=body, timeout=180)
        except requests.RequestException as ex:
            log(f"- Gemini 연결 오류({m}): {str(ex)[:120]}"); time.sleep(15); continue
        if r.status_code == 200:
            used = m; break
        log(f"- Gemini {m} → HTTP {r.status_code} {r.text[:160]}")
        if r.status_code not in (429, 500, 502, 503, 504):
            break
        time.sleep(20 * (attempt + 1))
    if used is None:
        raise RuntimeError(f"Gemini 실패 {getattr(r, 'status_code', '연결 실패')}")
    j = r.json()
    text = j["candidates"][0]["content"]["parts"][0]["text"]
    usage = j.get("usageMetadata") or {}
    log(f"- Gemini 응답: {used} · 입력 {usage.get('promptTokenCount')} / 출력 {usage.get('candidatesTokenCount')} 토큰")
    return json.loads(re.sub(r"^```(json)?|```$", "", text.strip())), used

def validate(res, D):
    codes = {c["code"]: c for c in D["후보종목"]}
    secnames = {s["업종"] for s in D["업종"]}
    picks = []
    for p in res.get("picks") or []:
        c = str(p.get("code", "")).strip()
        if c in codes and c not in [x["code"] for x in picks]:
            p["code"] = c; p["name"] = codes[c]["name"]; p["sector"] = codes[c]["업종"]
            p["close"] = codes[c]["종가"]; p["chg"] = codes[c]["등락%"]; p["score"] = codes[c]["규칙점수"]
            picks.append(p)
    if len(picks) < 3:
        return None, f"picks 중 후보 목록에 있는 code가 {len(picks)}개뿐 — 후보종목의 code만 정확히 5개"
    res["picks"] = picks[:5]
    finalize_mine(D, res)
    res["focus_sectors"] = [s for s in (res.get("focus_sectors") or []) if s.get("name") in secnames][:3]
    ut = D.get("_us_link_txt") or {}
    for grp in (res["focus_sectors"], (res.get("sectors") or {}).get("strong") or [], (res.get("sectors") or {}).get("weak") or [], res.get("avoid") or []):
        for x in grp:
            if isinstance(x, dict) and x.get("name") in ut:
                x["us_link"] = ut[x["name"]]
    if res.get("stance") not in ("공격", "중립", "방어"):
        res["stance"] = "중립"
    for k in ("headline", "market", "us", "global", "stocks_today"):
        res.setdefault(k, "")
    return res, None

def fallback(D):
    c = D["후보종목"][:5]
    return finalize_mine(D, {"headline": "AI 미생성 — 규칙 점수 상위 후보만 표시", "stance": None, "fallback": True,
            "picks": [{"code": x["code"], "name": x["name"], "sector": x["업종"], "close": x["종가"], "chg": x["등락%"], "score": x["규칙점수"],
                       "reason": "규칙 점수 상위(모멘텀·수급·추세·업종)", "risk": ", ".join(x["리스크"]) or "-", "invalidation": "-"} for x in c]})

# ─────────────────────────────── 추천 성과 추적 ───────────────────────────────
def update_perf(conn):
    """ok 상태 브리핑(최근 90일)의 관심 종목 → 기준일 종가 대비 1·5·20거래일 뒤/최신 수익률과 같은 기간 KOSPI 수익률."""
    cur = conn.cursor()
    cur.execute("select trade_date, round, result from ai_brief where status='ok' and round > 0 and trade_date >= current_date - 90 order by trade_date")
    briefs = cur.fetchall()
    if not briefs:
        return
    first = min(b[0] for b in briefs)
    cur.execute("select trade_date, index_close from market_daily where market='KOSPI' and index_close is not null and trade_date >= %s order by trade_date", (first,))
    kd = [(d, float(c)) for d, c in cur.fetchall()]
    kidx = {d: i for i, (d, _) in enumerate(kd)}
    codes = sorted({p["code"] for _, _, res in briefs for p in ((res or {}).get("picks") or []) if p.get("code")})
    cur.execute("select code, trade_date, close from daily_price where code = any(%s) and trade_date >= %s order by trade_date", (codes, first))
    px = {}
    for c, d, cl in cur.fetchall():
        px.setdefault(c, []).append((d, float(cl)))
    n = 0
    for td, rnd, res in briefs:
        for rank, p in enumerate((res or {}).get("picks") or [], 1):
            ser = px.get(p.get("code")) or []
            ent = next((cl for d, cl in ser if d == td), None)
            if not ent:
                continue
            after = [(d, cl) for d, cl in ser if d > td]
            def ret(k):   # k거래일 뒤(None이면 최신)
                if not after or (k and len(after) < k):
                    return None, None
                d, cl = after[(k - 1) if k else -1]
                a = (cl / ent - 1) * 100
                b = None
                if td in kidx and d in kidx:
                    b = (kd[kidx[d]][1] / kd[kidx[td]][1] - 1) * 100
                return round(a, 2), None if b is None else round(b, 2)
            (r1, k1), (r5, k5), (r20, k20), (rl, kl) = ret(1), ret(5), ret(20), ret(0)
            cur.execute("""insert into ai_brief_perf (trade_date, round, code, name, rank, entry_close, days_after, r1, r5, r20, r_last, k1, k5, k20, k_last, updated_at)
                           values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                           on conflict (trade_date, round, code) do update set name=excluded.name, rank=excluded.rank, entry_close=excluded.entry_close,
                             days_after=excluded.days_after, r1=excluded.r1, r5=excluded.r5, r20=excluded.r20, r_last=excluded.r_last,
                             k1=excluded.k1, k5=excluded.k5, k20=excluded.k20, k_last=excluded.k_last, updated_at=now()""",
                        (td, rnd, p["code"], p.get("name"), rank, ent, len(after), r1, r5, r20, rl, k1, k5, k20, kl))
            n += 1
    conn.commit()
    log(f"- 추천 성과 갱신: {n}건 (브리핑 {len(briefs)}회)")
    cur.execute("""select count(*), round(avg(r1),2), round(avg(r5),2), round(avg(r_last),2) from ai_brief_perf""")
    log(f"- 성과 요약(전체): 건수 {cur.fetchone()}  [건수, 평균 1일, 평균 5일, 평균 최신]")

def sim(conn, D):
    log(f"## 시뮬레이션 — 후보 최소 거래대금 {MIN_AMT_EOK:g}억원 · 기준일 {D['기준일']} · 통과 {D['유동성통과종목수']}종목")
    cur = conn.cursor()
    cur.execute("select round, result from ai_brief where trade_date=%s order by round", (D["기준일"],))
    old = {rd: [(p.get("code"), p.get("name")) for p in ((res or {}).get("picks") or [])] for rd, res in cur.fetchall()}
    amt_of = {c["code"]: c["거래대금억"] for c in D["후보종목"]}
    cur.execute("select code, trade_amount from v_screener where trade_date=%s", (D["기준일"],))
    amt_all = {c: round(float(a) / EOK) for c, a in cur.fetchall() if a is not None}
    for rd, picks in old.items():
        log(f"- 기존 {rd}회차 AI 추천 5종목의 거래대금: " + ", ".join(f"{n}({c}) {amt_all.get(c)}억" for c, n in picks))
    log("")
    log("| 순위 | 종목 | 업종 | 점수 | 등락% | 거래대금(억) | 시총(조) | 외국인(억) | 기관(억) | 외기5일(억) | 연속양매수 | 고점대비% | 스마트머니 | 리스크 |")
    log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, c in enumerate(D["후보종목"][:20], 1):
        log(f"| {i} | {c['name']}({c['code']}) | {c['업종']} | {c['규칙점수']} | {c['등락%']} | {c['거래대금억']} | {c['시총조']} | {c['외국인오늘억']} | {c['기관오늘억']} | {c['외기합5일억']} | {c['연속양매수일']} | {c['고점대비%']} | {c['스마트머니국면']} | {', '.join(c['리스크'])} |")
    sc = [c["규칙점수"] for c in D["후보종목"]]
    am = sorted(c["거래대금억"] for c in D["후보종목"])
    log(f"\n- 점수 분포(후보 {len(sc)}): 1위 {sc[0]} · 5위 {sc[4] if len(sc)>4 else None} · 10위 {sc[9] if len(sc)>9 else None} · 30위 {sc[-1]} · 평균 {round(sum(sc)/len(sc),1)}")
    log(f"- 후보 거래대금(억): 최소 {am[0]} · 중앙 {am[len(am)//2]} · 최대 {am[-1]}")
    log("- 상위10: " + ", ".join(f"{c['name']}({c['규칙점수']}/{c['거래대금억']}억)" for c in D["후보종목"][:10]))
    # 업종 분포
    from collections import Counter
    cnt = Counter(c["업종"] for c in D["후보종목"])
    log("\n- 후보 30 업종 분포: " + ", ".join(f"{k} {v}" for k, v in cnt.most_common()))
    finish()

# ─────────────────────────────── main ───────────────────────────────
def mine_only(conn):
    """내 종목 의견만 새로 만들어 오늘 최신 브리핑의 result.mine에 덮어쓴다(시장 브리핑·추천은 그대로). 종목을 담은 직후 바로 확인하고 싶을 때."""
    D = build_digest(conn)
    td = D["기준일"]
    if not D.get("내종목"):
        log("- 내 종목이 없어 종료"); return finish()
    res = {}
    if KEY:
        slim = {"기준일": td, "국내시장": D["국내시장"], "내종목": D["내종목"]}
        p = ("너는 한국 주식 단기 스윙 애널리스트다. 아래 데이터(코드가 계산한 정량 점수·규칙판정·근거)만 사용해 내종목 각각의 의견을 쓴다. "
             "숫자를 지어내지 않는다. 평서문 보고서체. action은 규칙판정과 같거나 인접한 값만(투자=매수·보유·매도, 관심=매수·관망·매도), 바꾸면 opinion에 이유. "
             'JSON 하나만: {"mine":[{"code":"","action":"","opinion":"2문장(근거 수치 인용)","risk":"1문장"}]}\n\n'
             + json.dumps(slim, ensure_ascii=False, separators=(",", ":")))
        try:
            res, _ = call_gemini(p)
        except Exception as ex:
            log(f"- ⚠ AI 오류 — 규칙 판정만 저장: {str(ex)[:150]}"); res = {}
    finalize_mine(D, res)
    with conn.cursor() as cur:
        cur.execute("""update ai_brief set result = coalesce(result,'{}'::jsonb) || jsonb_build_object('mine', %s::jsonb)
                       where trade_date=%s and round=(select max(round) from ai_brief where trade_date=%s)""",
                    (json.dumps(res["mine"], ensure_ascii=False), td, td))
        n = cur.rowcount
    conn.commit()
    log(f"- 내 종목 의견 저장: {len(res['mine'])}개 → {td} 최신 브리핑 {n}건 갱신" + ("" if n else " (해당 날짜 브리핑이 아직 없음 — 먼저 AI 브리핑 실행)"))
    for m in res["mine"]:
        log(f"  - {m['name']}({m['code']}) [{m['kind']}] {m['action']} · 점수 {m['score']:+d} · {m['opinion'][:90]}")
    finish()

def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    now = datetime.datetime.now(KST)
    rd = arg("--round", "auto")
    rnd = (1 if now.hour < 18 else 2) if rd == "auto" else int(rd)
    conn = psycopg2.connect(DB_URL)
    here = os.path.dirname(os.path.abspath(__file__))
    with conn.cursor() as cur:
        cur.execute(open(os.path.join(here, "113_ai_brief.sql"), encoding="utf-8").read()); conn.commit()
    log(f"# AI 데일리 브리핑 ({now:%Y-%m-%d %H:%M} KST · {rnd}회차 = {'장중 수동' if rnd == 0 else '16시' if rnd == 1 else '18시'} 데이터)")
    if "--mine-only" in ARGS:
        return mine_only(conn)
    D = build_digest(conn)
    td = D["기준일"]
    if "--sim" in ARGS:   # 시뮬레이션: 저장·AI 호출 없이 최소 거래대금 기준의 후보 순위만 출력
        return sim(conn, D)
    with conn.cursor() as cur:
        cur.execute("select status from ai_brief where trade_date=%s and round=%s", (td, rnd))
        ex = cur.fetchone()
    if ex and "--force" not in ARGS and ex[0] == "ok" and rnd != 0:   # 0회차(장중 수동)는 누를 때마다 새로 만든다
        log(f"- {td} {rnd}회차 이미 생성됨 — 건너뜀 (--force로 덮어쓰기)")
        update_perf(conn)
        return finish()
    log(f"- 기준일 {td} · {D['데이터상태']} · 유동성 통과 {D['유동성통과종목수']}종목 · 후보 {len(D['후보종목'])} · 업종 {len(D['업종'])}")
    log(f"- 다이제스트 크기 {len(json.dumps(D, ensure_ascii=False))}자")
    res, model, status = None, None, "fallback"
    if not KEY:
        log("- ⚠ GEMINI_API_KEY 시크릿 없음 — 데이터 요약·규칙 후보만 저장")
    else:
        err = None
        for _ in range(2):
            try:
                raw, model = call_gemini(prompt_of(D, err))
                res, err = validate(raw, D)
                if res:
                    status = "ok"; break
                log(f"- 검증 실패: {err}")
            except Exception as ex:
                err = str(ex)[:200]; log(f"- ⚠ AI 오류: {err}")
    if not res:
        res, model = fallback(D), None
    with conn.cursor() as cur:
        cur.execute("""insert into ai_brief (trade_date, round, model, status, data_partial, digest, result)
                       values (%s,%s,%s,%s,%s,%s,%s)
                       on conflict (trade_date, round) do update set created_at=now(), model=excluded.model, status=excluded.status,
                         data_partial=excluded.data_partial, digest=excluded.digest, result=excluded.result""",
                    (td, rnd, model, status, D["데이터상태"].startswith("잠정"), json.dumps({k: v for k, v in D.items() if not k.startswith("_")}, ensure_ascii=False), json.dumps(res, ensure_ascii=False)))
    conn.commit()
    log(f"- 저장: {td} {rnd}회차 · status={status} · model={model}")
    log(f"- 헤드라인: {res.get('headline')}")
    log(f"- 스탠스: {res.get('stance')} · 주목 업종: {[s.get('name') for s in res.get('focus_sectors') or []]}")
    for p in res.get("picks") or []:
        log(f"  - {p.get('name')}({p.get('code')}) {p.get('sector')} · 점수 {p.get('score')} · {p.get('reason')}")
    update_perf(conn)
    if "--dump" in ARGS:
        log("\n## 다이제스트(일부)\n```json\n" + json.dumps({k: D[k] for k in ("국내시장", "매크로")}, ensure_ascii=False, indent=1)[:6000] + "\n```")
        log("\n## 업종 판단(미국 연계 포함)\n```json\n" + json.dumps({"sectors": res.get("sectors"), "focus": res.get("focus_sectors"), "avoid": res.get("avoid")}, ensure_ascii=False, indent=1)[:6000] + "\n```")
        log("\n## 업종별 미국연계 요약\n" + "\n".join(f"- {k}: {v}" for k, v in (D.get("_us_link_txt") or {}).items()))
        log("\n## 내 종목\n" + "\n".join(f"- {m['name']}({m['code']}) [{m.get('etype')}/{m['kind']}] {m['action']} 점수 {m['score']:+d}" for m in res.get("mine", [])))
    finish()

def finish():
    if REPORT:
        open(REPORT, "w", encoding="utf-8").write("\n".join(lines) + "\n")

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        log(f"❌ {type(ex).__name__}: {ex}")
        finish(); raise
