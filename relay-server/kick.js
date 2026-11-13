'use strict';
/* 체결 틱 → 매매 엔진 깨우기 연결부(2026-11-13). 판정은 엔진이 REST 시세로 하고, 여기서는 "깨울지"만 정한다.
   deps: { held: () => Set(보유·미체결 종목), watchLines: code => [[engine, lines]], kick: (engine, code) => Promise<bool>, log? } */
const { shouldKick } = require('./trail');

function createTickHook(deps) {
  const hi = new Map();   // code -> [{s: 초, m: 그 초 최고가}] 최근 10초
  const stat = { n: 0, acted: 0, lastAt: null, lastCode: null, lastEng: null };
  function recentMax(code, price, nowMs) {
    const sec = Math.floor(nowMs / 1000);
    let a = hi.get(code); if (!a) { a = []; hi.set(code, a); }
    const last = a[a.length - 1];
    if (last && last.s === sec) { if (price > last.m) last.m = price; } else a.push({ s: sec, m: price });
    while (a.length && a[0].s < sec - 10) a.shift();
    return a.reduce((x, e) => Math.max(x, e.m), 0);
  }
  function onTick(code, price, nowMs) {
    if (!(price > 0) || !deps.held().has(code)) return [];
    const mx = recentMax(code, price, nowMs), fired = [];
    for (const [eng, L] of deps.watchLines(code) || []) {
      if (!shouldKick(L, price, mx)) continue;
      stat.n++;
      fired.push(Promise.resolve(deps.kick(eng, code)).then(ok => {
        if (!ok) return false;
        stat.acted++; stat.lastAt = nowMs; stat.lastCode = code; stat.lastEng = eng;
        if (deps.log) deps.log(`[틱 점검] ${eng} ${code} 틱 ${price} → 즉시 점검`);
        return true;
      }).catch(() => false));
    }
    return fired;
  }
  return { onTick, stat };
}
module.exports = { createTickHook };
