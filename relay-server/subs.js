'use strict';
/* 실시간 시세 구독 슬롯 배분 (2026-11-13)
   KIS 실시간 등록 한도(승인키당 41, 릴레이 안전 한도 36) 안에서 프론트가 요청한 종목만 배분한다.
   상따·전략성과 보유 종목은 사용자 요청으로 구독 대상에서 제외했다.
   우선순위: ① 매매 화면 종목(hi) → ② 최근에 활동한 접속의 요청 → ③ 그 접속이 보낸 순서(화면 순위).
   한도 밖 종목은 polled로 돌려 REST 멀티시세 폴링으로 대체한다. */

// clients: [{ codes:Set, hi:Set, rank:Map(code->순서), lastActive:number }]
function allocate(clients, limit) {
  const best = new Map();   // code -> { p, at, r }
  for (const c of clients) {
    for (const code of c.codes) {
      const k = {
        p: c.hi && c.hi.has(code) ? 0 : 1,
        at: c.lastActive || 0,
        r: c.rank && c.rank.has(code) ? c.rank.get(code) : 1e6,
      };
      const b = best.get(code);
      if (!b || k.p < b.p || (k.p === b.p && (k.at > b.at || (k.at === b.at && k.r < b.r)))) best.set(code, k);
    }
  }
  const order = [...best.entries()].sort((a, b) => a[1].p - b[1].p || b[1].at - a[1].at || a[1].r - b[1].r || (a[0] < b[0] ? -1 : 1));
  const ws = new Set(), polled = new Set();
  order.forEach(([code], i) => (i < limit ? ws : polled).add(code));
  return { ws, polled, order: order.map(([code, k]) => ({ code, hi: k.p === 0 })) };
}

// 폴링 시간대: 평일 07:50~20:10 KST (NXT 프리·애프터 포함). 그 밖엔 시세가 안 바뀌므로 호출하지 않는다.
function pollWindowOpen(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600e3), dow = k.getUTCDay(), m = k.getUTCHours() * 60 + k.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 7 * 60 + 50 && m <= 20 * 60 + 10;
}

// 멀티시세(FHKST11300006) 한 행 → 웹소켓 체결 메시지와 같은 모양(polled 표시)
function multiRowToPayload(o, num) {
  const code = o.inter_shrn_iscd, price = num(o.inter2_prpr);
  if (!code || !(price > 0)) return null;
  const p = { type: 'price', code, price, changePct: num(o.prdy_ctrt), sign: o.prdy_vrss_sign || null, time: null, polled: true };
  const op = num(o.inter2_oprc), hi = num(o.inter2_hgpr), av = num(o.acml_vol), aa = num(o.acml_tr_pbmn);
  if (op > 0) p.open = op;
  if (hi > 0) p.dayHighPx = hi;
  if (av > 0) p.accVol = av;
  if (aa > 0) p.accAmt = aa;
  return p;
}

// KIS 구독 해지를 바로 하지 않고 grace 동안 미룬다(2026-11-13) — TOP20 순위 출렁임·화면 왕복 때마다
// 해지/재등록이 반복되는 부담을 줄인다. 단, 미룬 종목이 새로 필요한 종목의 자리를 막지는 않는다(한도 안에서만 유지).
// current: 지금 KIS에 등록된 코드, want: 필요한 코드, unwantedAt: code->필요 없어진 시각(호출 측이 들고 있는 상태, 여기서 갱신)
function planReconcile(current, want, unwantedAt, now, limit, graceMs) {
  for (const c of [...unwantedAt.keys()]) if (want.has(c) || !current.has(c)) unwantedAt.delete(c);
  const stale = [...current].filter(c => !want.has(c));
  for (const c of stale) if (!unwantedAt.has(c)) unwantedAt.set(c, now);
  const add = [...want].filter(c => !current.has(c));
  const room = Math.max(0, limit - want.size);
  const fresh = stale.filter(c => now - unwantedAt.get(c) < graceMs).sort((a, b) => unwantedAt.get(b) - unwantedAt.get(a)).slice(0, room);
  const keep = new Set(fresh);
  const remove = stale.filter(c => !keep.has(c));
  for (const c of remove) unwantedAt.delete(c);
  const nextAt = fresh.length ? Math.min(...fresh.map(c => unwantedAt.get(c))) + graceMs : null;
  return { add, remove, keep: [...keep], nextAt };
}

module.exports = { allocate, pollWindowOpen, multiRowToPayload, planReconcile };
