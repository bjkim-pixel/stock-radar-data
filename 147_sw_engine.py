# -*- coding: utf-8 -*-
"""국면 전환 전략 계산 엔진 → sw_daily(상태·신호·모의 성과), sw_picks(조건 충족·보유 종목).
규칙과 수익 계산은 백테스트(145_sw_absret_bt.py)와 같은 코드를 그대로 쓴다(수급은 전일까지 값, 종가 체결, 비용 포함).
 ① 선별 매수: 당일 +3%↑·거래대금 50억↑·20일선 위·시총 2조↓·5일 외+기 순매수 시총의 0.2%↑, 코스피 20일 박스 위치 30% 초과일 때만, 3거래일 보유
 ② 반등 매도 인버스: 코스피 < 60일선 & 3일 +4%↑ → KODEX 인버스 5거래일
 ③ ① 50% + ② 50%   ④ 외국인 20일 매집 상위 15(시총 2조↓, 5일 교체), 60일선 아래면 바스켓 50% + 인버스 50%
사용: SUPABASE_DB_URL=... python 147_sw_engine.py"""
import os, math
import psycopg2
from psycopg2.extras import execute_values
src = open("145_sw_absret_bt.py", encoding="utf-8").read()
exec(src.split('P("# 절대수익 전략 백테스트')[0])          # 데이터 적재 + run/hold/topn/tranche (조회 전용 연결)
START = pd.Timestamp("2026-08-03"); LIVE = pd.Timestamp("2026-11-10")
EL = LIQ & C.notna(); SM = EL & (CAP <= 2e12)
down = (KS < ma[60]); gate = (pos20 > 0.3)
mask = (CHG >= 3) & (AMT >= 5e9) & (sm5 >= 0.002) & EL & (C > MA20) & (CAP <= 2e12)
WF = tranche(mask, 3).mul(gate.astype(float), axis=0)
ret3 = KS / KS.shift(3) - 1
sig = (ret3 >= 0.04) & down
winv = hold(sig, 5)
Wb = topn(fo20, 15, SM); dn = down.astype(float); up = 1 - dn
r1, _ = run(W=WF); r2, _ = run(wv=winv); r3, _ = run(W=WF * 0.5, wv=winv * 0.5); r4, _ = run(W=Wb.mul(0.5 * dn + up, axis=0), wv=0.5 * dn)
idx = D[D >= START]
eq = lambda r: ((1 + r.reindex(idx).fillna(0)).cumprod() * 100)
E1, E2, E3, E4, EK = eq(r1), eq(r2), eq(r3), eq(r4), eq(kr)
# 인버스 남은 보유일: 마지막 신호일로부터 5거래일
last_sig = pd.Series(np.where(sig.fillna(False), np.arange(len(D)), np.nan), index=D).ffill()
left = (5 - (pd.Series(np.arange(len(D)), index=D) - last_sig)).where(winv > 0, 0).fillna(0).astype(int)
nnew = mask.sum(axis=1); nhold = (WF > 0).sum(axis=1)
f = lambda v, n=4: None if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else round(float(v), n)
rows = []
for d in idx:
    rows.append((d.date(), f(KS[d], 2), f(ma[60][d], 2), f(hi20[d], 2), f(lo20[d], 2), f(pos20[d]), f(ret3[d] * 100, 2), bool(down[d]), bool(gate[d]), bool(sig[d]), bool(winv[d] > 0), int(left[d]),
                 int(nnew[d]), int(nhold[d]), f(r1[d] * 100), f(r2[d] * 100), f(r3[d] * 100), f(r4[d] * 100), f(kr[d] * 100),
                 f(E1[d], 3), f(E2[d], 3), f(E3[d], 3), f(E4[d], 3), f(EK[d], 3), bool(d >= LIVE)))
# 종목: 최근 40거래일치
nxt = {}
wconn = psycopg2.connect(os.environ["SUPABASE_DB_URL"]); wconn.autocommit = False; wc = wconn.cursor()
wc.execute(open("147_sw_strategy.sql", encoding="utf-8").read())
wc.execute("select code, nxt_ok from stocks"); nxt = dict(wc.fetchall())
vol20 = R.abs().rolling(20, min_periods=10).mean() * 100
picks = []; pos = {d: i for i, d in enumerate(D)}
for d in D[-40:]:
    i = pos[d]
    for c in mask.columns[mask.loc[d].values]:
        picks.append((d.date(), c, "new", d.date(), f(C.at[d, c], 2), f(C.at[d, c], 2), f(CHG.at[d, c], 2), f(AMT.at[d, c] / 1e8, 1), f(CAP.at[d, c] / 1e8, 0), f(sm5.at[d, c] * 100, 3), f(fo20.at[d, c] * 100, 3),
                      f(WF.at[d, c] * 100, 2), 3 if gate[d] else 0, f(vol20.at[d, c], 2), nxt.get(c)))
    if gate[d]:
        for k in (1, 2):
            if i - k < 0: continue
            e = D[i - k]
            for c in mask.columns[mask.loc[e].values]:
                if mask.at[d, c]: continue      # 오늘도 충족이면 new 로 이미 표시
                picks.append((d.date(), c, "hold", e.date(), f(C.at[e, c], 2), f(C.at[d, c], 2), f(CHG.at[d, c], 2), f(AMT.at[d, c] / 1e8, 1), f(CAP.at[d, c] / 1e8, 0), f(sm5.at[d, c] * 100, 3), f(fo20.at[d, c] * 100, 3),
                              f(WF.at[d, c] * 100, 2), 3 - k, f(vol20.at[d, c], 2), nxt.get(c)))
    for c in Wb.columns[(Wb.loc[d] > 0).values]:
        picks.append((d.date(), c, "basket", None, None, f(C.at[d, c], 2), f(CHG.at[d, c], 2), f(AMT.at[d, c] / 1e8, 1), f(CAP.at[d, c] / 1e8, 0), f(sm5.at[d, c] * 100, 3), f(fo20.at[d, c] * 100, 3),
                      f(Wb.at[d, c] * 100, 2), None, f(vol20.at[d, c], 2), nxt.get(c)))
seen = set(); picks = [p for p in picks if not ((p[0], p[1], p[2]) in seen or seen.add((p[0], p[1], p[2])))]
wc.execute("delete from sw_daily"); wc.execute("delete from sw_picks")
execute_values(wc, """insert into sw_daily(trade_date,kospi,ma60,box_hi,box_lo,pos20,ret3,trend_down,gate_open,inv_signal,inv_hold,inv_left,n_new,n_hold,r1,r2,r3,r4,rk,eq1,eq2,eq3,eq4,eqk,is_live) values %s""", rows, page_size=500)
execute_values(wc, """insert into sw_picks(trade_date,code,kind,entry_date,entry_close,close,chg,amt_eok,cap_eok,sm5_pct,fo20_pct,weight,days_left,vol20,nxt_ok) values %s""", picks, page_size=1000)
wconn.commit()
d = idx[-1]; L = [f"# 국면 전환 전략 엔진", f"- 기준일 {d:%Y-%m-%d} · sw_daily {len(rows)}행 · sw_picks {len(picks)}행",
     f"- 코스피 {KS[d]:,.2f} · 60일선 {ma[60][d]:,.2f} ({'아래' if down[d] else '위'}) · 박스 {lo20[d]:,.0f}~{hi20[d]:,.0f} · 위치 {pos20[d]*100:.0f}% · 3일 {ret3[d]*100:+.1f}%",
     f"- ① 매수 허용 {'예' if gate[d] else '아니오'} · 오늘 조건 충족 {int(nnew[d])}종목 · 보유 {int(nhold[d])}종목 ‖ ② 신호 {'발생' if sig[d] else '없음'} · 보유 {'중(' + str(int(left[d])) + '일 남음)' if winv[d] > 0 else '없음'}",
     f"- 누적(2026-08-03=100): ① {E1[d]:.1f} · ② {E2[d]:.1f} · ③ {E3[d]:.1f} · ④ {E4[d]:.1f} · 코스피 {EK[d]:.1f}",
     f"- NXT 표시: 가능 {sum(1 for v in nxt.values() if v)} · 불가 {sum(1 for v in nxt.values() if v is False)}"]
nm = px.drop_duplicates("code").set_index("code")["name"]
L.append("- 오늘 조건 충족: " + (", ".join(nm.get(c, c) for c in mask.columns[mask.loc[d].values]) or "없음"))
open("sw_engine_report.md", "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
