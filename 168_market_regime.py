# -*- coding: utf-8 -*-
"""시장 상태 점수(자동매매 보강 E1, 2026-11-16) — 날짜별 0~100점과 4단계를 market_regime 에 저장

   python 168_market_regime.py --days 5                 # 최근 5거래일 다시 계산(매일 계산 직후)
   python 168_market_regime.py --backfill --report r.md # 최근 2년 채우기 + 검증 보고서

지표(전날 종가 기준, 모두 우리 DB):
  · 지수 추세 25  : 코스피·코스닥 각각 20일선 위 5 · 20일선이 5일 전보다 높음 5 · 60일선 위 2.5
  · 참여도   25  : 시총 1천억 이상 보통주 중 종가 > 60일선 비율. 20% 이하 0점 ~ 70% 이상 만점
  · 상승 비율 15  : 최근 5일 평균 (상승 종목 ÷ (상승+하락)). 35% 이하 0점 ~ 65% 이상 만점
  · 분배일   20  : 최근 25거래일 중 지수 −0.2% 이하 & 거래대금이 전날보다 많은 날 수(코스피·코스닥 중 많은 쪽). 2일 이하 만점 ~ 6일 이상 0점
  · 수급     15  : 코스피 외국인+기관 순매수 5일 합이 최근 250거래일 중 차지하는 순위(백분위)
단계: 70 이상 attack(공격) · 50~69 normal(보통) · 30~49 caution(보수) · 30 미만 defense(방어)

지수는 종목 시총 가중 수익률을 이어 붙인 합성지수(사이트 시장 화면의 market_daily 합성지수와 같은 방식)라
과거 전 기간을 같은 기준으로 계산할 수 있다."""
import os, sys, json, argparse
import numpy as np
import pandas as pd

W = dict(trend=25.0, breadth=25.0, updown=15.0, dist=20.0, flow=15.0)
CAP_MIN = 1e11                       # 참여도·상승 비율 대상: 시총 1,000억 이상
STAGES = [(70, 'attack'), (50, 'normal'), (30, 'caution'), (-1, 'defense')]
STAGE_KO = dict(attack='공격', normal='보통', caution='보수', defense='방어')


def stage_of(score):
    for th, s in STAGES:
        if score >= th:
            return s
    return 'defense'


def clamp01(x):
    return float(min(1.0, max(0.0, x)))


def build_index(px):
    """px: trade_date, code, market, change_pct, market_cap, trade_amount → 시장별 합성지수·거래대금(일별)"""
    px = px.sort_values(['code', 'trade_date']).copy()
    px['cap_prev'] = px.groupby('code')['market_cap'].shift(1)
    px['r'] = px['change_pct'].astype(float) / 100.0
    ok = px['cap_prev'].notna() & px['r'].notna() & (px['r'].abs() < 0.35)   # 상한(±30%)을 넘는 값은 분할·병합 등 이상치
    g = px[ok].assign(w=lambda d: d['cap_prev'] * d['r']).groupby(['market', 'trade_date']).agg(num=('w', 'sum'), den=('cap_prev', 'sum'))
    amt = px.groupby(['market', 'trade_date'])['trade_amount'].sum().rename('amt')
    out = g.join(amt, how='outer').reset_index().sort_values(['market', 'trade_date'])
    out['ret'] = (out['num'] / out['den']).fillna(0.0)
    out['idx'] = out.groupby('market')['ret'].transform(lambda s: 1000.0 * (1 + s).cumprod())
    return out[['market', 'trade_date', 'ret', 'idx', 'amt']]


def compute(px, flow, dates=None):
    """px: 종목 일별(trade_date, code, market, close, change_pct, market_cap, trade_amount)
       flow: 코스피 외국인+기관 일별(trade_date, smart) — 없으면 수급 0점 처리
       dates: 결과를 낼 날짜(없으면 계산 가능한 전 기간). 반환: DataFrame(trade_date, score, stage, parts)"""
    px = px.copy()
    px['trade_date'] = pd.to_datetime(px['trade_date'])
    ix = build_index(px)
    mk = {}
    for m in ('KOSPI', 'KOSDAQ'):
        s = ix[ix['market'] == m].set_index('trade_date').sort_index()
        s['ma20'] = s['idx'].rolling(20).mean()
        s['ma60'] = s['idx'].rolling(60).mean()
        s['ma20_5'] = s['ma20'].shift(5)
        s['distday'] = ((s['ret'] <= -0.002) & (s['amt'] > s['amt'].shift(1))).astype(int)
        s['dist25'] = s['distday'].rolling(25).sum()
        mk[m] = s
    # 참여도·상승 비율(시총 1천억 이상)
    px = px.sort_values(['code', 'trade_date'])
    px['ma60'] = px.groupby('code')['close'].transform(lambda s: s.rolling(60).mean())
    big = px[px['market_cap'] >= CAP_MIN]
    br = big[big['ma60'].notna()].assign(a=lambda d: (d['close'] > d['ma60']).astype(int)).groupby('trade_date').agg(pct60=('a', 'mean'), n=('a', 'size'))
    ud = big.assign(up=lambda d: (d['change_pct'] > 0).astype(int), dn=lambda d: (d['change_pct'] < 0).astype(int)).groupby('trade_date')[['up', 'dn']].sum()
    ud['r'] = ud['up'] / (ud['up'] + ud['dn']).replace(0, np.nan)
    ud['r5'] = ud['r'].rolling(5).mean()
    # 수급
    fl = None
    if flow is not None and len(flow):
        fl = flow.copy(); fl['trade_date'] = pd.to_datetime(fl['trade_date']); fl = fl.set_index('trade_date').sort_index()
        fl['s5'] = fl['smart'].rolling(5).sum()
        fl['pctl'] = fl['s5'].rolling(250, min_periods=120).apply(lambda a: (a[:-1] < a[-1]).mean() if len(a) > 1 else np.nan, raw=True)
    alld = mk['KOSPI'].index
    if dates is not None:
        alld = [d for d in alld if d in set(pd.to_datetime(list(dates)))]
    rows = []
    for d in alld:
        try:
            t_parts, t = {}, 0.0
            for m in ('KOSPI', 'KOSDAQ'):
                r = mk[m].loc[d]
                if pd.isna(r['ma60']) or pd.isna(r['ma20_5']):
                    raise KeyError('warmup')
                a20, up20, a60 = bool(r['idx'] > r['ma20']), bool(r['ma20'] > r['ma20_5']), bool(r['idx'] > r['ma60'])
                p = 5 * a20 + 5 * up20 + 2.5 * a60
                t += p
                t_parts[m] = dict(above20=a20, rising20=up20, above60=a60, vs20=round(float(r['idx'] / r['ma20'] - 1) * 100, 2), ret=round(float(r['ret']) * 100, 2))
            b = br.loc[d] if d in br.index else None
            if b is None or b['n'] < 100:
                raise KeyError('breadth')
            bp = W['breadth'] * clamp01((b['pct60'] - 0.20) / 0.50)
            u = ud.loc[d]['r5'] if d in ud.index else np.nan
            if pd.isna(u):
                raise KeyError('updown')
            up = W['updown'] * clamp01((u - 0.35) / 0.30)
            dk, dq = int(mk['KOSPI'].loc[d]['dist25']), int(mk['KOSDAQ'].loc[d]['dist25'])
            dmax = max(dk, dq)
            dp = W['dist'] * clamp01((6 - dmax) / 4)
            if fl is not None and d in fl.index and not pd.isna(fl.loc[d]['pctl']):
                fpct = float(fl.loc[d]['pctl']); fp = W['flow'] * fpct; fs5 = float(fl.loc[d]['s5'])
            else:
                fpct, fp, fs5 = None, 0.0, None
            score = round(t + bp + up + dp + fp, 1)
            parts = dict(
                trend=dict(pts=round(t, 1), max=W['trend'], **{k.lower(): v for k, v in t_parts.items()}),
                breadth=dict(pts=round(bp, 1), max=W['breadth'], pct60=round(float(b['pct60']) * 100, 1), n=int(b['n'])),
                updown=dict(pts=round(up, 1), max=W['updown'], ratio5=round(float(u) * 100, 1)),
                dist=dict(pts=round(dp, 1), max=W['dist'], kospi=dk, kosdaq=dq),
                flow=dict(pts=round(fp, 1), max=W['flow'], pctl=None if fpct is None else round(fpct * 100, 1), sum5=fs5),
                idx=dict(kospi=round(float(mk['KOSPI'].loc[d]['ret']) * 100, 2), kosdaq=round(float(mk['KOSDAQ'].loc[d]['ret']) * 100, 2)),
            )
            rows.append(dict(trade_date=d.date(), score=score, stage=stage_of(score), parts=parts))
        except KeyError:
            continue
    return pd.DataFrame(rows), mk, ud


def validate(res, mk, ud):
    """단계별로 다음 1·5거래일 합성 코스피·코스닥 수익률과 다음 날 상승 종목 비율 비교(검증 보고서용)"""
    k, q = mk['KOSPI'], mk['KOSDAQ']
    fwd = pd.DataFrame(index=k.index)
    fwd['k1'] = k['idx'].shift(-1) / k['idx'] - 1
    fwd['k5'] = k['idx'].shift(-5) / k['idx'] - 1
    fwd['q5'] = q['idx'].shift(-5) / q['idx'] - 1
    fwd['dd5'] = pd.concat([k['idx'].shift(-i) for i in range(1, 6)], axis=1).min(axis=1) / k['idx'] - 1
    fwd['up1'] = ud['r'].shift(-1)
    r = res.copy(); r['trade_date'] = pd.to_datetime(r['trade_date'])
    r = r.set_index('trade_date').join(fwd).dropna(subset=['k5'])
    L = []
    L.append(f"기간 {r.index.min().date()} ~ {r.index.max().date()} · {len(r)}거래일(다음 5일 결과가 있는 날)\n")
    L.append("| 단계 | 일수(비중) | 다음날 코스피 | 다음 5일 코스피 | 5일 하락 확률 | 5일 중 최대 하락 | 다음 5일 코스닥 | 다음날 상승 종목 비율 |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for _, s in STAGES:
        g = r[r['stage'] == s]
        if not len(g):
            L.append(f"| {STAGE_KO[s]} | 0 | – | – | – | – | – | – |"); continue
        L.append(f"| {STAGE_KO[s]} | {len(g)} ({len(g)/len(r)*100:.0f}%) | {g['k1'].mean()*100:+.2f}% | {g['k5'].mean()*100:+.2f}% | {(g['k5']<0).mean()*100:.0f}% | {g['dd5'].mean()*100:.2f}% | {g['q5'].mean()*100:+.2f}% | {g['up1'].mean()*100:.1f}% |")
    L.append(f"| 전체 | {len(r)} | {r['k1'].mean()*100:+.2f}% | {r['k5'].mean()*100:+.2f}% | {(r['k5']<0).mean()*100:.0f}% | {r['dd5'].mean()*100:.2f}% | {r['q5'].mean()*100:+.2f}% | {r['up1'].mean()*100:.1f}% |")
    rho = r['score'].rank().corr(r['k5'].rank())
    L.append(f"\n점수와 다음 5일 코스피 수익률의 순위 상관(스피어만): {rho:+.3f}")
    # 지표별 단독 설명력(점수 성분별 순위 상관)
    comp = {c: r['parts'].map(lambda p, c=c: p[c]['pts']) for c in ('trend', 'breadth', 'updown', 'dist', 'flow')}
    L.append("지표별 다음 5일 코스피와의 순위 상관: " + " · ".join(f"{c} {v.rank().corr(r['k5'].rank()):+.3f}" for c, v in comp.items()))
    # 전반·후반 나눠 안정성 확인(과최적화 점검)
    half = r.index[len(r) // 2]
    for nm, g in (("전반", r[r.index < half]), ("후반", r[r.index >= half])):
        seg = " · ".join(f"{STAGE_KO[s]} {g[g['stage']==s]['k5'].mean()*100:+.2f}%({(g['stage']==s).sum()}일)" for _, s in STAGES if (g['stage'] == s).any())
        L.append(f"{nm}({g.index.min().date()}~{g.index.max().date()}) 다음 5일 코스피: {seg}")
    mono = [r[r['stage'] == s]['k5'].mean() for _, s in STAGES if (r['stage'] == s).sum() >= 10]
    ok = all(mono[i] >= mono[i + 1] - 0.002 for i in range(len(mono) - 1)) if len(mono) >= 2 else False
    L.append(f"\n판정: 단계가 낮을수록 다음 5일 수익률이 낮아지는가 → {'예(연결 검토 가능)' if ok else '아니오(배점 재검토 필요)'}")
    return "\n".join(L)


def load(conn, start):
    px = pd.read_sql("""select p.trade_date, p.code, s.market, p.close::float8 close, p.change_pct::float8 change_pct, p.market_cap::float8 market_cap, p.trade_amount::float8 trade_amount
                        from daily_price p join stocks s on s.code = p.code
                        where s.security_type = 'STOCK' and s.market in ('KOSPI','KOSDAQ') and p.trade_date >= %s and p.close > 0""", conn, params=(start,))
    flow = pd.read_sql("""select f.trade_date, sum(coalesce(f.foreign_net,0) + coalesce(f.inst_net,0))::float8 smart
                          from daily_flow f join stocks s on s.code = f.code
                          where s.market = 'KOSPI' and s.security_type = 'STOCK' and f.trade_date >= %s group by 1 order by 1""", conn, params=(start,))
    return px, flow


def save(conn, res):
    if not len(res):
        return 0
    from psycopg2.extras import execute_values
    cur = conn.cursor()
    execute_values(cur, """insert into public.market_regime(trade_date, score, stage, parts, updated_at) values %s
                           on conflict (trade_date) do update set score = excluded.score, stage = excluded.stage, parts = excluded.parts, updated_at = now()""",
                   [(r.trade_date, r.score, r.stage, json.dumps(r.parts, ensure_ascii=False), ) for r in res.itertuples()], template="(%s, %s, %s, %s::jsonb, now())")
    conn.commit()
    return len(res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=5)
    ap.add_argument('--backfill', action='store_true')
    ap.add_argument('--years', type=float, default=2.0)
    ap.add_argument('--report', default=None)
    a = ap.parse_args()
    import psycopg2
    url = os.environ.get('SUPABASE_DB_URL')
    if not url:
        sys.exit('SUPABASE_DB_URL 미설정')
    conn = psycopg2.connect(url)
    cur = conn.cursor()
    cur.execute("select max(trade_date) from daily_price"); last = cur.fetchone()[0]
    span = int(a.years * 365) + 420 if a.backfill else 420     # 250거래일 백분위·60일선 준비 기간 포함
    start = last - pd.Timedelta(days=span)
    px, flow = load(conn, start)
    print(f"불러옴: 종목 일별 {len(px):,}행 · 수급 {len(flow)}일 · {start} ~ {last}")
    res, mk, ud = compute(px, flow)
    if not a.backfill:
        res = res.tail(a.days)
    else:
        cut = pd.Timestamp(last) - pd.Timedelta(days=int(a.years * 365))
        res = res[pd.to_datetime(res['trade_date']) >= cut]
    n = save(conn, res)
    out = [f"# 시장 상태 점수 — {'과거 채우기' if a.backfill else '최근 갱신'}", f"저장 {n}일 · 마지막 {last}"]
    if len(res):
        t = res.iloc[-1]
        out.append(f"최근: {t.trade_date} {t.score}점 {STAGE_KO[t.stage]} — " + " · ".join(f"{k} {v['pts']}/{v['max']:g}" for k, v in t.parts.items() if isinstance(v, dict) and 'pts' in v))
        out.append("\n최근 10일: " + " · ".join(f"{r.trade_date.strftime('%m-%d') if hasattr(r.trade_date,'strftime') else r.trade_date} {r.score:g}" for r in res.tail(10).itertuples()))
    if a.backfill and len(res):
        out.append("\n## 검증(단계별 이후 시장)\n")
        out.append(validate(res, mk, ud))
        out.append("\n단계별 분포: " + ", ".join(f"{STAGE_KO[s]} {(res['stage']==s).sum()}일" for _, s in STAGES))
    txt = "\n".join(out)
    print(txt)
    if a.report:
        open(a.report, 'w', encoding='utf-8').write(txt + "\n")


if __name__ == '__main__':
    main()
