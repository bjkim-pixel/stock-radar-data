# -*- coding: utf-8 -*-
"""횡보장 전략 0단계(읽기 전용): ① 데이터 인벤토리 ② NXT(20시 마감) 구분 출처 확인 ③ 요인별 사전 검증.
DB는 조회만 한다. 사용: SUPABASE_DB_URL=... [KIS_APP_KEY/SECRET] python 143_sw_phase0.py > sw_phase0_report.md"""
import os, sys, time, json, importlib, datetime as dt
import numpy as np, pandas as pd, psycopg2, requests

conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.set_session(readonly=True, autocommit=True)
cur = conn.cursor()
def q(sql, args=None):
    cur.execute(sql, args); return cur.fetchall()
P = print

# ───────────────────────── ① 인벤토리 ─────────────────────────
P("# 횡보장 전략 0단계 보고 (읽기 전용)")
P(f"- 실행 {dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC\n")
P("## 1. 데이터 인벤토리")
P("| 테이블 | 행 | 시작 | 끝 | 거래일 | 종목/키 |\n|---|---|---|---|---|---|")
for t, key in [("daily_price", "code"), ("daily_flow", "code"), ("daily_metrics", "code"), ("market_daily", "market"),
               ("sector_daily", "sector"), ("market_investor_daily", "market"), ("etf_daily", "code"), ("signals", "code"),
               ("smx_state", "code"), ("global_series_daily", "symbol")]:
    try:
        dcol = "as_of" if t == "smx_state" else "trade_date"
        r = q(f"select count(*), min({dcol}), max({dcol}), count(distinct {dcol}), count(distinct {key}) from {t}")[0]
        P(f"| {t} | {r[0]:,} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |")
    except Exception as e:
        conn.rollback() if not conn.autocommit else None
        P(f"| {t} | 오류 {str(e)[:60]} | | | | |")
r = q("select security_type, market, count(*) from stocks where is_active group by 1,2 order by 1,2")
P("\n- 활성 종목: " + ", ".join(f"{a}/{b} {c}" for a, b, c in r))
r = q("select count(*) filter (where p.market_cap < 1e11), count(*) filter (where p.market_cap between 1e11 and 5e11), count(*) filter (where p.market_cap between 5e11 and 2e12), count(*) filter (where p.market_cap > 2e12) from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' where p.trade_date=(select max(trade_date) from daily_price)")[0]
P(f"- 시총 분포(최신일, 주식): 1천억 미만 {r[0]} · 1천억~5천억 {r[1]} · 5천억~2조 {r[2]} · 2조 초과 {r[3]}")
r = q("select vs.sector, count(*) from v_stock_sector vs join stocks s on s.code=vs.code and s.is_active and s.security_type='STOCK' group by 1 order by 2 desc")
P(f"- 업종 {len(r)}개: " + ", ".join(f"{a} {b}" for a, b in r))
cols = [c[0] for c in q("select column_name from information_schema.columns where table_name='daily_flow' order by ordinal_position")]
P(f"- daily_flow 컬럼: {', '.join(cols)}")
try:
    r = q("select job, to_char(ran_at at time zone 'Asia/Seoul','HH24:MI'), status, row_count, trade_date from ingest_log where ran_at > now() - interval '3 days' order by ran_at desc limit 14")
    P("- 최근 수집 로그(KST): " + " / ".join(f"{a} {b} {c} {d} ({e})" for a, b, c, d, e in r))
except Exception as e:
    P(f"- ingest_log 조회 실패 {str(e)[:60]}")
# 수급 결측: 가격은 있는데 수급 행이 없는 비율(월별)
r = q("""select to_char(p.trade_date,'YYYY-MM'), count(*), count(f.code), count(*) filter (where f.foreign_net is null and f.code is not null)
         from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK' left join daily_flow f on f.code=p.code and f.trade_date=p.trade_date group by 1 order by 1""")
P("- 월별 가격행/수급행: " + ", ".join(f"{a} {b}/{c}" for a, b, c, d in r))

# ───────────────────────── ② NXT 구분 출처 ─────────────────────────
P("\n## 2. NXT(20시 마감) 거래 종목 구분 출처")
try:
    KEY = os.environ["KIS_APP_KEY"]; SEC = os.environ["KIS_APP_SECRET"]
    tok = importlib.import_module("72_kis_token").get_token_cached()
    H = {"Content-Type": "application/json; charset=utf-8", "authorization": f"Bearer {tok}", "appkey": KEY, "appsecret": SEC, "custtype": "P"}
    B = "https://openapi.koreainvestment.com:9443"
    for code in ["005930", "003010", "036930"]:
        j = requests.get(B + "/uapi/domestic-stock/v1/quotations/search-stock-info", params={"PRDT_TYPE_CD": "300", "PDNO": code}, headers={**H, "tr_id": "CTPF1002R"}, timeout=20).json()
        o = j.get("output") or {}
        P(f"- search-stock-info {code}: rt_cd {j.get('rt_cd')} · " + ", ".join(f"{k}={v}" for k, v in o.items() if any(x in k.lower() for x in ("nxt", "cptt", "ovtm", "trad"))) + f" · 키 {len(o)}개")
        time.sleep(0.2)
        for mk in ("J", "NX", "UN"):
            j = requests.get(B + "/uapi/domestic-stock/v1/quotations/inquire-price", params={"FID_COND_MRKT_DIV_CODE": mk, "FID_INPUT_ISCD": code}, headers={**H, "tr_id": "FHKST01010100"}, timeout=20).json()
            o = j.get("output") or {}
            P(f"  - inquire-price {mk} {code}: rt_cd {j.get('rt_cd')} {str(j.get('msg1',''))[:30]} · 현재가 {o.get('stck_prpr')} · 거래량 {o.get('acml_vol')} · " + ", ".join(f"{k}={v}" for k, v in o.items() if "nxt" in k.lower() or "cptt" in k.lower()))
            time.sleep(0.2)
except Exception as e:
    P(f"- KIS 확인 실패: {str(e)[:120]}")

# ───────────────────────── ③ 요인 사전 검증 ─────────────────────────
P("\n## 3. 요인별 사전 검증")
px = pd.read_sql("""select p.trade_date d, p.code, s.market mk, vs.sector, p.open o, p.high h, p.low l, p.close c, p.change_pct chg,
                           p.trade_amount amt, p.market_cap cap
                    from daily_price p join stocks s on s.code=p.code and s.security_type='STOCK'
                    left join v_stock_sector vs on vs.code=p.code where p.close>0 order by p.code, p.trade_date""", conn)
fcols = [c for c in ["foreign_net", "inst_net", "fin_inv_net", "inv_trust_net", "pension_net", "pe_net", "individual_net", "corp_other_net"] if c in cols]
fl = pd.read_sql(f"select trade_date d, code, {', '.join(fcols)} from daily_flow", conn)
df = px.merge(fl, on=["d", "code"], how="left")
for c in ["o", "h", "l", "c", "chg", "amt", "cap"] + fcols:
    df[c] = pd.to_numeric(df[c], errors="coerce")
df["d"] = pd.to_datetime(df["d"])
df = df.sort_values(["code", "d"]).reset_index(drop=True)
# 데이터 품질: 시가·고가·저가가 0 이하인 행(수집 누락) → 결측 처리, 월별 건수 보고
bad = df[(df["o"] <= 0) | (df["h"] <= 0) | (df["l"] <= 0) | (df["h"] < df["l"])]
P(f"- 시가·고가·저가 0 또는 역전 행: {len(bad):,}건 · 월별 " + ", ".join(f"{k} {v}" for k, v in bad.groupby(bad["d"].dt.strftime("%y-%m")).size().items()))
for c in ("o", "h", "l"):
    df.loc[df[c] <= 0, c] = np.nan
df.loc[df["h"] < df["l"], ["h", "l"]] = np.nan
jump = df[(df["chg"].abs() > 30.5)]
P(f"- 등락률 ±30% 초과 행(권리락·분할 의심): {len(jump)}건 → 검증에서 제외")
g = df.groupby("code", sort=False)
COST = 0.25   # 왕복 비용 가정(%) — 세금·수수료·체결 오차
for k in (1, 3, 5):
    df[f"r{k}"] = (g["c"].shift(-k) / df["c"] - 1) * 100                 # 당일 종가 매수 → k일 뒤 종가
    df[f"q{k}"] = (g["c"].shift(-k) / g["o"].shift(-1) - 1) * 100         # 다음 날 시가 매수 → k일 뒤 종가
df["gap"] = (g["o"].shift(-1) / df["c"] - 1) * 100
df["badfwd"] = g["chg"].transform(lambda s: s.abs().shift(-1).rolling(5, min_periods=1).max().shift(-4)) > 30.5   # 이후 5일 안에 가격 불연속
for k in (1, 3, 5):
    df["x%d" % k] = df[f"r{k}"] - df.groupby("d")[f"r{k}"].transform("mean")   # 같은 날 전체 평균 대비 초과수익
# 5일 내 +5% 도달 vs -3% 이탈(먼저 닿는 쪽, 같은 날이면 손절로 계산)
H5 = np.column_stack([g["h"].shift(-k).values for k in range(1, 6)]); L5 = np.column_stack([g["l"].shift(-k).values for k in range(1, 6)])
c0 = df["c"].values[:, None]
up = (H5 / c0 - 1) * 100 >= 5; dn = (L5 / c0 - 1) * 100 <= -3
fu = np.where(up.any(1), up.argmax(1), 99); fd = np.where(dn.any(1), dn.argmax(1), 99)
valid5 = ~(np.isnan(H5).any(1) | np.isnan(L5).any(1))
df["tp"] = np.where(valid5, (fu < fd).astype(float), np.nan); df["sl"] = np.where(valid5, ((fd <= fu) & (fd < 99)).astype(float), np.nan)
# 요인
df["amt20"] = g["amt"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).mean())
df["amtx"] = df["amt"] / df["amt20"]
df["pos"] = np.where(df["h"] > df["l"], (df["c"] - df["l"]) / (df["h"] - df["l"]), np.nan)
df["sm"] = df["foreign_net"].fillna(0) + df["inst_net"].fillna(0)
df["smcap"] = df["sm"] / df["cap"] * 1e4                                   # bp
df["sm5cap"] = g["sm"].transform(lambda s: s.rolling(5, min_periods=3).sum()) / df["cap"] * 1e4
pos_day = (df["sm"] > 0).astype(int)
df["consec"] = pos_day.groupby(df["code"]).transform(lambda s: s * (s.groupby((s != s.shift()).cumsum()).cumcount() + 1))
df["smcum"] = g["sm"].cumsum()
df["smhigh60"] = df["smcum"] >= g["smcum"].transform(lambda s: s.rolling(60, min_periods=20).max())
df["r5past"] = (df["c"] / g["c"].shift(5) - 1) * 100
df["ma20"] = g["c"].transform(lambda s: s.rolling(20, min_periods=15).mean()); df["disp"] = df["c"] / df["ma20"] * 100
subj = {"foreign_net": "외국인", "fin_inv_net": "금투", "inv_trust_net": "투신", "pension_net": "연기금", "pe_net": "사모", "corp_other_net": "기타법인", "individual_net": "개인"}
sc = [c for c in subj if c in df.columns]
df["lead"] = df[sc].fillna(0).idxmax(axis=1).map(subj)
df["up3"] = (df["chg"] >= 3).astype(int)
sb = df.groupby(["d", "sector"])["up3"].agg(["sum", "count"]).rename(columns={"sum": "sec_up", "count": "sec_n"}).reset_index()
df = df.merge(sb, on=["d", "sector"], how="left"); df["sec_ratio"] = (df["sec_up"] - df["up3"]) / (df["sec_n"] - 1).clip(lower=1)
# 지수 20일 박스 위치
try:
    ix = pd.read_sql("select trade_date d, market mk, index_close ic from market_daily where index_close is not null and market in ('KOSPI','KOSDAQ') order by 2,1", conn)
    ix["d"] = pd.to_datetime(ix["d"]); ix["ic"] = pd.to_numeric(ix["ic"]); gi = ix.groupby("mk")["ic"]
    lo, hi = gi.transform(lambda s: s.rolling(20, min_periods=10).min()), gi.transform(lambda s: s.rolling(20, min_periods=10).max())
    ix["box"] = np.where(hi > lo, (ix["ic"] - lo) / (hi - lo), np.nan)
    df = df.merge(ix[["d", "mk", "box"]], on=["d", "mk"], how="left")
except Exception as e:
    df["box"] = np.nan; P(f"- 지수 박스 계산 실패 {str(e)[:60]}")

days = df["d"].nunique(); BOX0 = pd.Timestamp("2026-08-01")
P(f"- 표본: {df['code'].nunique()}종목 × {days}거래일 = {len(df):,}행 · {df['d'].min():%Y-%m-%d}~{df['d'].max():%Y-%m-%d} · 2026-08 이후 {df[df['d']>=BOX0]['d'].nunique()}거래일")
P(f"- 수익률은 비용 차감 전(%). 왕복 비용 가정 {COST}%를 빼고 읽어야 함. r=당일 종가 매수, q=다음 날 시가 매수, 숫자=보유 거래일")
P(f"- 익절·손절: 5거래일 안에 +5%에 먼저 닿으면 익절, -3%에 먼저 닿으면 손절(같은 날이면 손절로 계산)")

def row(name, s):
    s = s[(~s["badfwd"].fillna(False)) & (s["chg"].abs() <= 30.5)].dropna(subset=["r5"])
    if len(s) < 30:
        return f"| {name} | {len(s)} | 표본 부족 | | | | | | | | | |"
    dm = s.groupby("d")["x3"].mean(); t = dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm))) if len(dm) > 5 and dm.std(ddof=1) > 0 else np.nan
    return (f"| {name} | {len(s):,} | {s['r1'].mean():+.2f} | {s['r3'].mean():+.2f} | {s['r5'].mean():+.2f} | {s['r3'].median():+.2f} | {(s['r3']>COST).mean()*100:.0f}% "
            f"| {s['x3'].mean():+.2f} | {t:+.1f} | {s['gap'].mean():+.2f} | {s['q3'].mean():+.2f} | {s['tp'].mean()*100:.0f}%/{s['sl'].mean()*100:.0f}% |")
P("- 초과 r3 = 같은 날 전체 종목 평균 r3를 뺀 값(시장 영향 제거). t = 일별 평균 초과수익의 t값(대략 2 이상이면 우연으로 보기 어려움)")
HD = "| 조건 | 건수 | r1 | r3 | r5 | r3 중앙 | r3 승률 | 초과 r3 | t | 익일 갭 | q3 | 익절/손절 |\n|---|---|---|---|---|---|---|---|---|---|---|---|"

def study(title, base):
    P(f"\n### {title}"); P(HD)
    cand = base[(base["chg"] >= 3) & (base["amt"] >= 5e9)]
    P(row("전체 종목·일(기준선)", base)); P(row("후보: 당일 +3% 이상·거래대금 50억 이상", cand))
    top = base[base["amt"] >= 5e9].sort_values(["d", "chg"], ascending=[True, False]).groupby("d").head(10)
    P(row("비교: 당일 상승률 상위 10", top))
    C = cand
    for nm, m in [("등락률 3~7%", C["chg"].between(3, 7)), ("등락률 7~15%", (C["chg"] > 7) & (C["chg"] <= 15)), ("등락률 15% 초과", C["chg"] > 15),
                  ("거래대금 20일평균의 1.5배 미만", C["amtx"] < 1.5), ("거래대금 1.5~3배", C["amtx"].between(1.5, 3)), ("거래대금 3배 초과", C["amtx"] > 3),
                  ("종가 위치 상위 20%(고가 근처)", C["pos"] >= 0.8), ("종가 위치 50~80%", C["pos"].between(0.5, 0.8, inclusive="left")), ("종가 위치 50% 미만(윗꼬리)", C["pos"] < 0.5),
                  ("외+기 당일 순매수(시총 대비 +5bp 이상)", C["smcap"] >= 5), ("외+기 당일 중립(-5~+5bp)", C["smcap"].between(-5, 5, inclusive="neither")), ("외+기 당일 순매도(-5bp 이하)", C["smcap"] <= -5),
                  ("분배: 개인 순매수·외+기 순매도", (C["individual_net"] > 0) & (C["sm"] < 0)),
                  ("외+기 5일 누적 +20bp 이상", C["sm5cap"] >= 20), ("외+기 5일 누적 -20bp 이하", C["sm5cap"] <= -20),
                  ("외+기 연속 순매수 3일 이상", C["consec"] >= 3), ("외+기 누적 60일 고점 경신", C["smhigh60"]),
                  ("같은 업종 동반 상승 30% 이상", C["sec_ratio"] >= 0.3), ("같은 업종 동반 상승 10% 미만(단독)", C["sec_ratio"] < 0.1),
                  ("직전 5일 누적 +15% 초과(과열)", C["r5past"] > 15), ("직전 5일 누적 0~15%", C["r5past"].between(0, 15)), ("직전 5일 누적 마이너스(반등 첫날)", C["r5past"] < 0),
                  ("20일선 이격 110 초과", C["disp"] > 110), ("20일선 이격 100~110", C["disp"].between(100, 110)), ("20일선 아래", C["disp"] < 100),
                  ("코스피", C["mk"] == "KOSPI"), ("코스닥", C["mk"] == "KOSDAQ"),
                  ("시총 5천억 미만", C["cap"] < 5e11), ("시총 5천억~2조", C["cap"].between(5e11, 2e12)), ("시총 2조 초과", C["cap"] > 2e12),
                  ("지수 20일 박스 하단(30% 이하)", C["box"] <= 0.3), ("지수 박스 중단", C["box"].between(0.3, 0.7, inclusive="neither")), ("지수 박스 상단(70% 이상)", C["box"] >= 0.7)]:
        P(row(nm, C[m.fillna(False)]))
    P("\n주도 주체별(후보 중, 당일 순매수 1위 주체)\n"); P(HD)
    for nm in ["외국인", "금투", "투신", "연기금", "사모", "기타법인", "개인"]:
        P(row(nm, C[C["lead"] == nm]))
    # 조합 예시(가설 점검용)
    P("\n조합(가설 점검)\n"); P(HD)
    combo = C[(C["smcap"] >= 5) & (C["pos"] >= 0.6) & (C["chg"] <= 15) & (C["r5past"] <= 15)]
    P(row("A: 외+기 순매수 + 종가 위치 60% 이상 + 과열 아님", combo))
    P(row("B: A + 같은 업종 동반 상승 20% 이상", combo[combo["sec_ratio"] >= 0.2]))
    P(row("C: A + 외+기 연속 순매수 2일 이상", combo[combo["consec"] >= 2]))
    P(row("D: A + 거래대금 1.5배 이상", combo[combo["amtx"] >= 1.5]))
    E = C[(C["box"] > 0.3) & (C["disp"] >= 100) & (C["sm5cap"] >= 20)]
    P(row("E: 지수 박스 하단 아님 + 20일선 위 + 외+기 5일 누적 +20bp", E))
    P(row("F: E + 시총 2조 이하", E[E["cap"] <= 2e12]))
    P(row("G: E + 거래대금 1.5배 이상", E[E["amtx"] >= 1.5]))
    P(row("H: E + 종가 위치 50~80%", E[E["pos"].between(0.5, 0.8)]))
    P(row("I: 지수 박스 하단 아님 + 20일선 위(수급 조건 없음)", C[(C["box"] > 0.3) & (C["disp"] >= 100)]))
    P(row("J: 지수 박스 하단 + 외+기 5일 누적 +20bp", C[(C["box"] <= 0.3) & (C["sm5cap"] >= 20)]))
    P("\n손절·익절 폭 비교(후보 전체, 5거래일 내 먼저 닿는 쪽)\n")
    P("| 익절/손절 폭 | 익절률 | 손절률 | 미결 | 건당 기대(%) |\n|---|---|---|---|---|")
    V = C[(~C["badfwd"].fillna(False))].dropna(subset=["r5"]); idx = V.index.values
    for tp_, sl_ in [(5, 3), (5, 5), (7, 5), (10, 5), (10, 7), (3, 3)]:
        u = (H5[idx] / c0[idx] - 1) * 100 >= tp_; dnn = (L5[idx] / c0[idx] - 1) * 100 <= -sl_
        ok = ~(np.isnan(H5[idx]).any(1) | np.isnan(L5[idx]).any(1))
        a = np.where(u.any(1), u.argmax(1), 99); b = np.where(dnn.any(1), dnn.argmax(1), 99)
        win = (a < b) & ok; lose = (b <= a) & (b < 99) & ok; none = ok & ~win & ~lose
        ev = (win.sum() * tp_ - lose.sum() * sl_ + V["r5"].values[none].sum()) / max(1, ok.sum())
        P(f"| +{tp_}% / -{sl_}% | {win.sum()/ok.sum()*100:.0f}% | {lose.sum()/ok.sum()*100:.0f}% | {none.sum()/ok.sum()*100:.0f}% | {ev:+.2f} |")
    return cand

c_all = study("3-1. 전체 기간", df)
c_box = study("3-2. 2026-08 이후(횡보 구간)", df[df["d"] >= BOX0])
study("3-2a. 횡보 구간 앞 절반(2026-08~09)", df[(df["d"] >= BOX0) & (df["d"] < pd.Timestamp("2026-10-01"))])
study("3-2b. 횡보 구간 뒤 절반(2026-10~11)", df[df["d"] >= pd.Timestamp("2026-10-01")])
# 월별 안정성: 후보군과 조합 A의 r3 월별 평균
P("\n### 3-3. 월별 안정성(r3 평균, 건수)")
df["ym"] = df["d"].dt.strftime("%y-%m")
C = df[(df["chg"] >= 3) & (df["amt"] >= 5e9)]; A = C[(C["smcap"] >= 5) & (C["pos"] >= 0.6) & (C["chg"] <= 15) & (C["r5past"] <= 15)]
P("| 월 | 전체 | 후보 | 조합 A |\n|---|---|---|---|")
for ym in sorted(df["ym"].unique()):
    f = lambda s: (lambda x: f"{x['r3'].mean():+.2f} ({len(x)})" if len(x) >= 10 else f"– ({len(x)})")(s[s["ym"] == ym].dropna(subset=["r3"]))
    P(f"| {ym} | {f(df)} | {f(C)} | {f(A)} |")
P(f"\n- 하루 평균 후보 수: 전체 기간 {len(c_all)/days:.1f}개 · 횡보 구간 {len(c_box)/max(1,df[df['d']>=BOX0]['d'].nunique()):.1f}개")
