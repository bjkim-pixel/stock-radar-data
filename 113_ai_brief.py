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
    for r in sc:
        cap, amt = f(r.get("market_cap")) or 0, f(r.get("trade_amount")) or 0
        if cap < 1000 * EOK or amt < 10 * EOK:
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
    return D

# ─────────────────────────────── Gemini ───────────────────────────────
SCHEMA_HINT = """{
 "headline": "오늘 시장을 한 문장으로(40자 내외)",
 "stance": "공격 | 중립 | 방어 중 하나",
 "stance_reason": "왜 그 스탠스인지 2~3문장 (지수·수급·매크로 근거)",
 "market": "국내 시장 요약 3~4문장 (KOSPI/KOSDAQ 등락, 거래대금, 외국인·기관·개인 수급 방향)",
 "sectors": {"summary": "업종 흐름 2~3문장", "strong": [{"name": "업종명", "reason": "근거 1문장"}], "weak": [{"name": "업종명", "reason": "근거 1문장"}]},
 "stocks_today": "오늘 강했던 종목들의 공통점 2~3문장 (종목명 언급 가능)",
 "us": "미국 지수·섹터·테마 요약 2~3문장과 국내 업종에 주는 시사점",
 "global": "국가별 지수 강약 1~2문장",
 "macro": {"summary": "금리·달러/원화·금·구리·원유·VIX 등의 방향이 주는 투자 방향 2~3문장",
           "items": [{"name": "지표명", "dir": "↑ | ↓ | →", "comment": "해석 1문장"}]},
 "focus_sectors": [{"name": "업종명(업종 목록의 이름 그대로)", "reason": "단기 스윙 관점 근거"}],
 "picks": [{"code": "후보종목의 code 그대로", "name": "종목명", "reason": "선정 근거 1~2문장(수급·가격·업종)",
            "risk": "주의할 점 1문장", "invalidation": "이 조건이 나오면 관심 제외(구체적으로)"}],
 "avoid": [{"name": "업종 또는 유형", "reason": "근거 1문장"}],
 "checkpoints": ["내일 장에서 확인할 것 (3개)"]
}"""

def prompt_of(D, err=None):
    p = f"""너는 한국 주식 단기 스윙(보유 3~10거래일) 전문 애널리스트다. 아래 JSON은 오늘 장마감 후 우리 시스템이 계산한 데이터 전부다.
규칙:
1) 이 데이터에 있는 숫자·이름만 사용한다. 데이터에 없는 뉴스·실적·수치를 지어내지 않는다.
2) picks는 반드시 "후보종목" 목록의 code에서만 정확히 5개 고른다. 규칙점수는 참고용이며 그대로 상위 5개를 고르지 말고, 업종 흐름·수급 지속성·매크로와의 정합성·리스크를 종합해 판단한다. 같은 업종에 3개 이상 몰지 않는다.
3) focus_sectors는 3개, 업종 목록의 이름 그대로 쓴다.
4) 금액 단위는 억원, 등락은 %. 문장은 한국어 존댓말 없이 간결한 보고서체(~임, ~함 아님, 평서문 '~다').
5) 투자 권유가 아니라 분석 보조임을 전제로, 단정 대신 조건·근거를 분명히 쓴다.
6) 출력은 아래 형식의 JSON 하나만. 마크다운 금지.
형식:
{SCHEMA_HINT}

데이터:
{json.dumps(D, ensure_ascii=False, separators=(',', ':'))}
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
    res["focus_sectors"] = [s for s in (res.get("focus_sectors") or []) if s.get("name") in secnames][:3]
    if res.get("stance") not in ("공격", "중립", "방어"):
        res["stance"] = "중립"
    for k in ("headline", "market", "us", "global", "stocks_today"):
        res.setdefault(k, "")
    return res, None

def fallback(D):
    c = D["후보종목"][:5]
    return {"headline": "AI 미생성 — 규칙 점수 상위 후보만 표시", "stance": None, "fallback": True,
            "picks": [{"code": x["code"], "name": x["name"], "sector": x["업종"], "close": x["종가"], "chg": x["등락%"], "score": x["규칙점수"],
                       "reason": "규칙 점수 상위(모멘텀·수급·추세·업종)", "risk": ", ".join(x["리스크"]) or "-", "invalidation": "-"} for x in c]}

# ─────────────────────────────── 추천 성과 추적 ───────────────────────────────
def update_perf(conn):
    """ok 상태 브리핑(최근 90일)의 관심 종목 → 기준일 종가 대비 1·5·20거래일 뒤/최신 수익률과 같은 기간 KOSPI 수익률."""
    cur = conn.cursor()
    cur.execute("select trade_date, round, result from ai_brief where status='ok' and trade_date >= current_date - 90 order by trade_date")
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

# ─────────────────────────────── main ───────────────────────────────
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
    log(f"# AI 데일리 브리핑 ({now:%Y-%m-%d %H:%M} KST · {rnd}회차 = {'16시' if rnd == 1 else '18시'} 데이터)")
    D = build_digest(conn)
    td = D["기준일"]
    with conn.cursor() as cur:
        cur.execute("select status from ai_brief where trade_date=%s and round=%s", (td, rnd))
        ex = cur.fetchone()
    if ex and "--force" not in ARGS and ex[0] == "ok":
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
                    (td, rnd, model, status, D["데이터상태"].startswith("잠정"), json.dumps(D, ensure_ascii=False), json.dumps(res, ensure_ascii=False)))
    conn.commit()
    log(f"- 저장: {td} {rnd}회차 · status={status} · model={model}")
    log(f"- 헤드라인: {res.get('headline')}")
    log(f"- 스탠스: {res.get('stance')} · 주목 업종: {[s.get('name') for s in res.get('focus_sectors') or []]}")
    for p in res.get("picks") or []:
        log(f"  - {p.get('name')}({p.get('code')}) {p.get('sector')} · 점수 {p.get('score')} · {p.get('reason')}")
    update_perf(conn)
    if "--dump" in ARGS:
        log("\n## 다이제스트(일부)\n```json\n" + json.dumps({k: D[k] for k in ("국내시장", "매크로")}, ensure_ascii=False, indent=1)[:6000] + "\n```")
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
