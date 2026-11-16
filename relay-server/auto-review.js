'use strict';
/* 자동매매 F4(2026-11-16) — 일지 복기용 순수 함수.
   · replayOf    : 그날 화면(진행 기록·후보·주문 카드)을 다시 그릴 수 있는 자료를 일지에 담는다
   · notBoughtOf : 사지 못한 후보와 그 뒤 흐름(선정가 → 종가·일중 고점) — "놓친 것/안 사서 다행"
   · reviewOf    : 자동 복기 문장(규칙 기반). 숫자는 모두 기록에서 계산하고, 문장은 사실만 서술한다 */
const fmt = v => Math.round(v).toLocaleString('ko-KR');
const sp = v => v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
const hm = ms => { const d = new Date(ms + 9 * 3600e3); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null);
const FILLED = o => (o.filled || 0) > 0;
const PLACED = o => o.orderId || (o.filled || 0) > 0 || ['intent', 'open', 'modified', 'filled', 'partial_done'].includes(o.st);

function replayOf(P) {
  const ords = P.orders || {};
  return {
    log: (P.log || []).slice(-300),
    picks: (P.picks || []).map(p => ({ code: p.code, name: p.name, score: p.score, price: p.price, open: p.open || null, changePct: p.changePct == null ? null : p.changePct, sector: p.sector || null, reasons: p.reasons || [], parts: p.parts || null, m: p.m || null, round: p.round || 1, closed: !!p.closed })),
    orders: Object.entries(ords).map(([code, o]) => ({ code, st: o.st, buy: o.buy || null, buy2: o.buy2 || null, qty: o.qty || null, filled: o.filled || 0, avg: o.avg || null, pick: o.pick || null, mode: o.mode || null, target: o.target || (o.plan && o.plan.target) || null,
      plan: o.plan || null, snap: o.snap || null, at: o.at || null, placedAt: o.placedAt || null, modifiedAt: o.modifiedAt || null, filledAt: o.filledAt || null, cancelledAt: o.cancelledAt || null, why: o.why || null, lowSeen: o.lowSeen || null, noReprice: !!o.noReprice })),
    rounds: { n: P.roundN || 1, at: P.roundAt || null },
    notice: P.noticeAt || null, selectedAt: P.selectedAt || null, decisionAt: P.decision && P.decision.at || null,
  };
}

/* 사지 못한 후보: 사유 + 선정가 대비 종가·일중 고점. closes/daily 가 없으면 결과는 null */
function notBoughtOf(P, closes = {}, daily = {}) {
  const ords = P.orders || {}, picks = P.picks || [], dec = P.decision, out = [];
  picks.forEach((p, i) => {
    const o = ords[p.code];
    if (o && FILLED(o)) return;
    let why, kind;
    if (o && o.st === 'skipped') { kind = 'recheck'; why = `재확인 탈락: ${o.why || '조건 미달'}`; }
    else if (o && (o.st === 'cancelled' || o.st === 'partial_done')) { kind = 'unfilled'; why = '미체결로 취소'; }
    else if (o && o.st === 'failed') { kind = 'failed'; why = `주문 거부: ${o.why || ''}`; }
    else if (o && o.st === 'lost') { kind = 'lost'; why = '주문 결과 확인 불가'; }
    else if (o) { kind = 'open'; why = '장 마감까지 체결되지 않음'; }
    else if (p.closed) { kind = 'closed'; why = '그 회차 승인에서 고르지 않음·만료'; }
    else if (!dec || dec.kind === 'expired') { kind = 'expired'; why = '승인 시간이 지나 사지 않음'; }
    else if (dec.kind === 'pass') { kind = 'pass'; why = '패스'; }
    else if (dec.kind === 'buy' && !(dec.nums || []).includes(i + 1)) { kind = 'unpicked'; why = '승인 때 고르지 않음'; }
    else { kind = 'cap'; why = '하루 최대 매수 종목 수 제한 또는 주문 전'; }
    const c = closes[p.code] > 0 ? closes[p.code] : null, d = daily[p.code] || null;
    const px = o && (o.buy2 || o.buy) || null;
    out.push({ code: p.code, name: p.name, kind, why, round: p.round || 1, pickPx: p.price || null, orderPx: px, close: c, high: d ? d.high : null, low: d ? d.low : null,
      closePct: c && p.price ? +pct(c, p.price).toFixed(2) : null, highPct: d && p.price ? +pct(d.high, p.price).toFixed(2) : null,
      reached: px && d ? d.low <= px : null });
  });
  return out;
}

function reviewOf({ P, positions = [], sells = [], notBought = [], totals = {}, shadow = null, funnel = {}, params = null }) {
  const L = [], add = (k, tone, text) => L.push({ k, tone, text });
  const f = funnel, rn = P.roundN || 1, extra = (P.picks || []).filter(p => (p.round || 1) > 1).length;
  if (f.pool != null) add('funnel', 'info', `후보 선정: 풀 ${f.pool}종목 → 기본 통과 ${f.base} → 수급 통과 ${f.flowPass} → 알림 ${f.picks}종목${rn > 1 ? ` (장중 ${rn}회 검토, 새 후보 ${extra}종목 추가)` : ''}.`);
  if (P.noticeAt && P.decision && P.decision.at) {
    const m = Math.max(0, Math.round((Date.parse(P.decision.at) - Date.parse(P.noticeAt)) / 60000));
    add('approval', 'info', `승인: ${P.decision.kind === 'buy' ? '매수 승인' : P.decision.kind === 'pass' ? '패스' : '시간 만료'}${m ? `, 알림 ${m}분 뒤` : ', 알림 직후'}.`);
  } else if (!P.decision && (P.picks || []).length) add('approval', 'bad', '승인이 없어 매수하지 못했어요.');
  const ords = P.orders || {};
  for (const x of positions) {
    const o = ords[x.code] || {}, pl = o.plan || {}, tp1 = pl.steps && pl.steps[0] ? pct(pl.steps[0].p, x.buyAvg) : null;
    const parts = [];
    if (o.placedAt && o.filledAt) { const m = Math.round((o.filledAt - o.placedAt) / 60000); parts.push(`${m <= 0 ? '바로' : m + '분 만에'} 체결${o.buy2 && o.buy2 !== o.buy ? '(정정 후)' : ''}`); }
    const pk = (P.picks || []).find(p => p.code === x.code);
    if (pk && pk.price) parts.push(`알림가 대비 ${sp(pct(x.buyAvg, pk.price))}에 매수`);
    const mySells = sells.filter(s => s.code === x.code), last = mySells[mySells.length - 1];
    let tone = x.pnl > 0 ? 'good' : x.pnl < 0 ? 'bad' : 'info', res;
    if (mySells.some(s => s.why === '손절')) res = `손절 −${pl.stopPct != null ? pl.stopPct : '–'}%에 닿아 정리했어요${x.mfe != null && x.mfe > 0.5 ? ` (그 전 최고 ${sp(x.mfe)})` : ''}`;
    else if (mySells.some(s => /익절/.test(s.why))) res = `${mySells.filter(s => /익절/.test(s.why)).length}단계 익절${x.held > 0 ? `, 나머지 ${fmt(x.held)}주는 ${x.state === 'carried' ? '이월' : '보유'}` : ''}`;
    else if (last && last.why === '종가 전 정리') res = '종가 판정에서 약해서 정리했어요';
    else if (x.state === 'carried') res = `종가베팅으로 이월(넘긴 가격 ${x.px0 ? fmt(x.px0) : '–'}원, ${sp(pct(x.px0, x.buyAvg))})`;
    else res = x.held > 0 ? '아직 보유 중' : '정리했어요';
    parts.push(res);
    if (x.mfe != null && x.mae != null) {
      parts.push(`매수 뒤 최고 ${sp(x.mfe)} · 최저 ${sp(x.mae)}${x.exSrc === 'daily' ? '(일봉 근사)' : ''}`);
      if (tp1 != null && x.mfe >= tp1 && mySells.some(s => s.why === '손절')) { tone = 'bad'; parts.push(`1차 익절선(${sp(tp1)})까지 갔다가 손절로 끝났어요 — 익절 분할·추적 설정을 볼 만해요`); }
      else if (tp1 != null && x.mfe < tp1 * 0.5 && x.pnl < 0) parts.push('익절선 근처에도 못 가고 내렸어요 — 진입 시점·수급 조건을 볼 만해요');
    }
    add('trade', tone, `${x.name} ${x.pnl >= 0 ? '+' : '−'}${fmt(Math.abs(x.pnl))}원(${sp(x.pct)}): ${parts.join(' · ')}.`);
  }
  const missed = notBought.filter(n => n.closePct != null && n.closePct >= 3), dodged = notBought.filter(n => n.closePct != null && n.closePct <= -3);
  if (notBought.length) {
    const byK = {}; notBought.forEach(n => { byK[n.kind] = (byK[n.kind] || 0) + 1; });
    const KO = { recheck: '재확인 탈락', unfilled: '미체결 취소', failed: '주문 거부', lost: '확인 불가', open: '미체결', closed: '이전 회차 마감', expired: '승인 시간 초과', pass: '패스', unpicked: '선택 안 함', cap: '종목 수 제한' };
    add('missed', 'info', `사지 못한 후보 ${notBought.length}종목(${Object.entries(byK).map(([k, v]) => `${KO[k] || k} ${v}`).join(' · ')}).`);
    if (missed.length) add('missed', 'bad', `이 중 ${missed.length}종목은 선정가보다 종가가 3% 이상 높았어요: ${missed.map(n => `${n.name} ${sp(n.closePct)}`).join(', ')}.`);
    if (dodged.length) add('missed', 'good', `${dodged.length}종목은 종가가 3% 이상 낮아 안 사길 잘했어요: ${dodged.map(n => `${n.name} ${sp(n.closePct)}`).join(', ')}.`);
    const unf = notBought.filter(n => n.kind === 'unfilled' && n.reached === false);
    if (unf.length) add('missed', 'info', `${unf.map(n => n.name).join(', ')}: 주문가까지 내려오지 않아 체결이 안 됐어요(일중 저점이 주문가 위).`);
    const unf2 = notBought.filter(n => n.kind === 'unfilled' && n.reached === true);
    if (unf2.length) add('missed', 'bad', `${unf2.map(n => n.name).join(', ')}: 일중 저점이 주문가에 닿았는데 체결되지 않았어요 — 내 앞 대기 물량이 많았을 수 있어요.`);
  }
  if (shadow && shadow.all != null) add('overall', 'info', `그림자 비교(선정가→종가): 통과 전체 ${sp(shadow.all)} · 알림 후보 ${sp(shadow.picked)} · 실제 매수 ${sp(shadow.bought)}.`);
  if (totals.n) add('overall', totals.net >= 0 ? 'good' : 'bad', `하루 결과: ${totals.n}종목 매수, 이긴 ${totals.wins || 0} · 진 ${totals.losses || 0}, 순손익 ${totals.net >= 0 ? '+' : '−'}${fmt(Math.abs(totals.net))}원(${sp(totals.pct)})${params && params.maxBuys ? ` · 하루 최대 ${params.maxBuys}종목 중 ${totals.n}종목` : ''}.`);
  else if ((P.picks || []).length) add('overall', 'info', '오늘은 매수한 종목이 없어요.');
  return L;
}

module.exports = { replayOf, notBoughtOf, reviewOf, sp, hm };
