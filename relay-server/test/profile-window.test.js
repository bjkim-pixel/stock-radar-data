'use strict';
const assert = require('assert'), X = require('../auto-exec');
const t = (n, f) => { try { f(); console.log('PASS', n); } catch (e) { console.log('FAIL', n, e.message); process.exitCode = 1; } };
// 이력: 앞 180일은 100~144k 구간(개인 순매수 큼), 최근 126일은 70~97k — 6개월 기준이면 현재가 위 매물대 없음
const mk = () => { const r = []; for (let i = 0; i < 306; i++) { const old = i < 180, c = old ? 100000 + (i % 40) * 1000 : 70000 + (i - 180) * 200;
  r.push({ trade_date: new Date(Date.UTC(2025, 8, 1 + i)).toISOString().slice(0, 10), close: c, high: c, low: c, trade_amount: 17e9, individual_net: old ? 5e9 : 1e8 }); } return r; };
t('매물대 창 = 최근 126거래일', () => { assert.equal(X.PROFILE_DAYS, 126); assert.equal(X.profWin(mk()).length, 126); assert.equal(X.profWin([]).length, 0); });
t('옛 이력 매물대에 막히지 않고, 위가 비면 손절폭×3 목표', () => {
  const rows = mk(); rows[rows.length - 1].close = 96800;
  const q = { price: 96800, amt: 17e9, bids: [{ p: 96800, q: 100 }], asks: [{ p: 96900, q: 100 }], upper: 125800, lower: 67800 };
  const o = X.makeOrder({ q, rows, perStockKrw: 1e6, opt: { stopPct: 5, rr: 3 } });
  assert.equal(o.mode, 'no-supply'); assert.ok(o.target > 96800 * 1.14, '목표 ' + o.target);
});
