'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionOf, restVenue, expiryOf, krxAfterOk, stopLimitPrice, T } = require('../session');
const E = require('../paper-engine');

const m = s => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
const NXT = { nxt: true, etf: false, warnings: [] }, KRX = { nxt: false, etf: false, warnings: [] };

test('NXT 종목 시간표', () => {
  const at = s => sessionOf(m(s), NXT);
  assert.equal(at('07:59').open, false);
  assert.deepEqual([at('08:00').name, at('08:00').venue, at('08:00').market, at('08:00').mkt], ['pre', 'NXT', false, 'NX']);
  assert.equal(at('08:49').name, 'pre');
  assert.equal(at('08:50').open, false);
  assert.equal(at('08:59').open, false);
  assert.deepEqual([at('09:00').name, at('09:00').venue, at('09:00').market, at('09:00').mkt], ['regular', 'SOR', true, 'UN']);
  assert.deepEqual([at('15:20').name, at('15:20').venue, at('15:20').mkt], ['close', 'KRX', 'J']);
  assert.equal(at('15:30').open, false);
  assert.deepEqual([at('15:40').name, at('15:40').venue, at('15:40').market, at('15:40').mkt], ['after', 'NXT', false, 'NX']);
  assert.deepEqual([at('16:00').venue, at('16:00').market, at('16:00').mkt], ['SOR', false, 'UN']);
  assert.equal(at('19:59').open, true);
  assert.equal(at('20:00').open, false);
});

test('KRX 전용 종목 시간표', () => {
  const at = s => sessionOf(m(s), KRX);
  assert.equal(at('08:10').open, false);
  assert.match(at('08:10').reason, /09:00/);
  assert.deepEqual([at('09:00').venue, at('09:00').mkt, at('09:00').market], ['KRX', 'J', true]);
  assert.equal(at('15:25').name, 'close');
  assert.equal(at('15:45').open, false);
  assert.match(at('15:45').reason, /16:00/);
  assert.deepEqual([at('16:00').name, at('16:00').venue, at('16:00').market, at('16:00').mkt], ['after', 'KRX', false, 'J']);
  assert.equal(at('20:00').open, false);
});

test('nxt_ok 미확인(null)은 KRX 전용으로', () => {
  assert.equal(sessionOf(m('08:10'), { nxt: null }).open, false);
  assert.equal(sessionOf(m('08:10'), null).open, false);
});

test('KRX 애프터마켓 제외 종목(ETF·투자경고 등)', () => {
  assert.equal(krxAfterOk({ etf: true }), false);
  assert.equal(krxAfterOk({ etf: false, warnings: ['투자경고'] }), false);
  assert.equal(krxAfterOk({ etf: false, warnings: ['단기과열'] }), true);
  assert.equal(sessionOf(m('17:00'), { nxt: false, etf: true }).open, false);
  assert.equal(sessionOf(m('17:00'), { nxt: false, warnings: ['정리매매'] }).open, false);
  assert.equal(sessionOf(m('10:00'), { nxt: false, etf: true }).open, true);   // 정규장은 그대로
  assert.equal(sessionOf(m('17:00'), { nxt: true, etf: false, warnings: ['투자경고'] }).open, true);   // NXT 종목은 NXT 로 거래
});

test('익절 대기 주문 거래소', () => {
  assert.equal(restVenue(m('08:10'), NXT), 'NXT');
  assert.equal(restVenue(m('10:00'), NXT), 'NXT');
  assert.equal(restVenue(m('15:25'), NXT), null);    // NXT 장 사이(종가 단일가) — 새로 내지 않음
  assert.equal(restVenue(m('17:00'), NXT), 'NXT');
  assert.equal(restVenue(m('10:00'), KRX), 'KRX');
  assert.equal(restVenue(m('15:25'), KRX), 'KRX');
  assert.equal(restVenue(m('15:35'), KRX), null);
  assert.equal(restVenue(m('17:00'), KRX), 'KRX');
});

test('주문 소멸 시각', () => {
  assert.equal(expiryOf('KRX', m('10:00')), T.KRX_CLOSE);
  assert.equal(expiryOf('KRX', m('16:10')), T.END);
  assert.equal(expiryOf('NXT', m('08:10')), T.END);
  assert.equal(expiryOf('SOR', m('10:00')), T.END);
});

test('시간외 손절 지정가: 매수 1호가에서 n호가 아래, 하한가 이상', () => {
  const q = { price: 10050, lower: 7000, bids: [{ p: 10000, q: 5 }] };
  assert.equal(stopLimitPrice(q, 5, E.tickOf, E.floorTick), 9950);   // 10원 단위 5호가 아래
  assert.equal(stopLimitPrice({ price: 2000, bids: [{ p: 2000, q: 1 }] }, 5, E.tickOf, E.floorTick), 1995);   // 2,000원 아래는 1원 단위
  assert.equal(stopLimitPrice({ price: 7020, lower: 7000, bids: [{ p: 7010, q: 1 }] }, 5, E.tickOf, E.floorTick), 7000);   // 하한가에서 멈춤
  assert.equal(stopLimitPrice({ price: 5000, bids: [] }, 2, E.tickOf, E.floorTick), 4990);   // 매수호가가 없으면 현재가 기준
});
