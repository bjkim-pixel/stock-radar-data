# -*- coding: utf-8 -*-
"""업종동향 > 글로벌 시황 > '글로벌 주식' 탭 데이터(global_pack, tab='GL') 생성.
etf_daily(해외주식 ETF 12종)로 국가별 카드를 만들고, 국가 GDP(명목) 큰 순서로 섹션을 배열한다.
21_collect_global.py의 align / metrics / item / save_pack 을 재사용 — 화면 코드는 기존 글로벌 시황과 같은 형식을 읽는다.
etf_collect.yml 의 마지막 단계에서 실행(별도 수집 없음). 여러 번 실행해도 안전."""
import os, sys, importlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
G = importlib.import_module("21_collect_global")

# (섹션 이름, [ETF 코드...]) — 국가 GDP(명목, IMF 2025 추정) 내림차순. 인도는 일본 앞. 국가가 아닌 지역형은 맨 아래.
SECTIONS = [
    ("1. 미국",          ["426020", "426030"]),
    ("2. 중국",          ["283580", "414780"]),
    ("3. 유럽(유로존)",   ["195930"]),
    ("4. 인도",          ["453810"]),
    ("5. 일본",          ["241180", "101280"]),
    ("6. 인도네시아",     ["256440"]),
    ("7. 베트남",        ["245710"]),
    ("지역형 (국가 아님)", ["195980", "0060H0"]),
]
BENCH = "426020"   # 상대강도 기준: TIME 미국S&P500액티브

def main():
    conn = G.db()
    with conn.cursor() as cur:
        codes = [c for _, l in SECTIONS for c in l]
        cur.execute("select code, name, mgmt, flags, mcap_eok from etf_master where code = any(%s)", (codes,))
        M = {r[0]: r for r in cur.fetchall()}
        cur.execute("select code, trade_date, close from etf_daily where code = any(%s) and trade_date >= %s order by trade_date",
                    (codes, G.BACKFILL_FROM))
        S = {}
        for c, d, x in cur.fetchall():
            S.setdefault(c, {})[d] = float(x)
    with conn.cursor() as cur:   # 대리 미국 ETF의 구성종목 상위 5 (21_collect_global.py가 etf_holdings에 저장)
        cur.execute("select etf_symbol, stock_code, stock_name, weight, change_pct, exch from etf_holdings where etf_symbol like 'US:%%' order by etf_symbol, rank")
        H = {}
        for e, sc, sn, w, ch, ex in cur.fetchall():
            H.setdefault(e[3:], []).append({"c": sc, "n": sc, "f": sn, "k": G.US_KO.get(sc) or G.short_en(sn),
                                            "x": G.exch_label(sc, ex), "w": float(w) if w is not None else None,
                                            "ch": float(ch) if ch is not None else None})
    cal = sorted({d for s in S.values() for d in s})
    if len(cal) < 30:
        raise SystemExit("etf_daily 데이터 부족")
    bench = G.align(cal, S.get(BENCH) or {})
    items, secs = {}, []
    for title, lst in SECTIONS:
        keys, cap = [], 0
        for c in lst:
            m = M.get(c)
            if not m or c not in S:
                G.log(f"- ⚠ {c} 없음 — 건너뜀"); continue
            it = G.item(cal, S[c], m[1], bench)
            if not it:
                continue
            it["etf"] = f"{c} · {m[2] or ''}" + (f" · {m[3]}" if m[3] else "")
            it["cap"] = round(float(m[4])) if m[4] else None
            px = G.GL_PROXY.get(c)
            if px and H.get(px):
                it["h"] = H[px]; it["hn"] = f"{px} 구성 상위 5 (같은 시장 대리)"
            cap += it["cap"] or 0
            items["etf:" + c] = it; keys.append("etf:" + c)
        if keys:
            secs.append({"n": title, "cap": cap, "keys": keys})
    pack = {"tab": "GL", "as_of": cal[-1].isoformat(), "bench": "TIME 미국S&P500액티브",
            "dates": [d.isoformat() for d in cal[-G.CHART_N:]],
            "summary": [], "groups": [{"id": "country", "title": "국가별 (GDP 큰 순)", "period": 126,
                                       "keys": [k for s in secs for k in s["keys"]], "sections": secs}],
            "items": items,
            "note": "원화로 거래되는 국내 상장 ETF 기준이라 환율 변동이 섞여 있습니다 (H)=환헤지. 현지 지수와 정확히 같지 않습니다. 모든 차트는 기간 시작=100 기준. 국가 순서는 명목 GDP(IMF 2025 추정) 큰 순."}
    G.save_pack(conn, pack)
    for s in secs:
        print(s["n"], [(items[k]["n"], items[k]["m"].get("m") if items[k]["m"] else None) for k in s["keys"]])
    for c in codes:   # 검증용: 최근 종가 (1달 전 / 직전 / 최신)
        sr = S.get(c) or {}
        ds = sorted(sr)
        if len(ds) > 22:
            print("  ", c, M[c][1], "| 21행전", ds[-22], sr[ds[-22]], "| 직전", ds[-2], sr[ds[-2]], "| 최신", ds[-1], sr[ds[-1]])
    conn.close()

if __name__ == "__main__":
    main()
