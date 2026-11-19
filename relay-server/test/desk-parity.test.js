'use strict';
/* 화면 짝 맞춤 시험(2026-11-19 분리 기획 C): 가상매매·실전매매 화면은 코드 하나 + 쪽 설정표(DESKS)로 띄운다.
   이 시험은 web/index.html 을 읽어 ① 두 쪽 메뉴가 같은 화면을 갖는지 ② 설정표 항목이 같은지 ③ 설정표 밖에서 가상/실전을 직접 비교하지 않는지
   ④ 주문 주소를 직접 쓰지 않는지(trdBase() 로만) 확인한다. 한쪽에만 필요한 것은 설정표나 아래 허용 목록에 이유와 함께 추가 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');

test('docs/index.html 은 web/index.html 과 같아야 함(배포본 복사 누락 방지)', () => {
  assert.equal(docs, html, 'web/index.html 을 고친 뒤 docs/index.html 로 복사하세요');
});

test('① 메뉴: 가상매매·실전매매가 같은 화면(주식주문·매도 계획·보유현황·거래내역·자동매매)을 같은 순서로', () => {
  const items = side => [...html.matchAll(new RegExp(`<button data-v="${side}-(\\w+)">([^<]+)</button>`, 'g'))].map(m => ({ v: m[1], label: m[2] }));
  const P = items('paper'), R = items('real');
  assert.ok(P.length >= 5, '가상매매 메뉴');
  assert.deepEqual(R.map(x => x.v), P.map(x => x.v), '두 쪽 메뉴의 화면 목록·순서가 같아야 함');
  const LABEL_DIFF = { hold: '실전은 계좌 현황(실제 계좌 잔고·대사)이 함께 있어 「보유현황 · 계좌」' };
  P.forEach((p, i) => { if (!LABEL_DIFF[p.v]) assert.equal(R[i].label, p.label, `메뉴 이름이 다름: ${p.v}`); });
});

test('② 쪽 설정표: 두 쪽이 같은 항목을 가짐', () => {
  const m = /const DESKS=\{([\s\S]*?)\n\};/.exec(html);
  assert.ok(m, 'DESKS 설정표');
  const keysOf = side => { const r = new RegExp(`\\b${side}:\\{([^}]*)\\}`).exec(m[1]); assert.ok(r, side); return [...r[1].matchAll(/(\w+):/g)].map(x => x[1]).sort(); };
  assert.deepEqual(keysOf('real'), keysOf('paper'));
});

test('③ 설정표 밖에서 가상/실전을 직접 비교하지 않음(desk-config 표시된 줄만)', () => {
  const bad = html.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /(TRD\.mode|S\.tradeMode)\s*[!=]==/.test(l) && !/desk-config/.test(l));
  assert.deepEqual(bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`), [], '쪽에 따른 차이는 trdDeskCfg()(DESKS) 로');
  const marked = html.split('\n').filter(l => /desk-config/.test(l) && /(TRD\.mode|S\.tradeMode)\s*[!=]==/.test(l)).length;
  assert.ok(marked <= 3, `직접 비교는 설정표·라우팅 3곳까지(지금 ${marked})`);
});

test('④ 주문 주소는 trdBase() 로만 — 실전 전용 조회·스위치만 예외', () => {
  const REAL_ONLY = { account: '실제 계좌 현황', probe: '시세 출처 점검(실전)', switch: '사이트 「실전 주문」 스위치' };
  const lits = [...html.matchAll(/"\/trade\/(live|paper)\/([a-z-]+)/g)].map(m => [m[1], m[2]]);
  for (const [side, ep] of lits) {
    assert.equal(side, 'live', `가상 주문 주소를 직접 씀: /trade/paper/${ep} — trdBase() 사용`);
    assert.ok(REAL_ONLY[ep], `실전 주문 주소를 직접 씀: /trade/live/${ep} — trdBase() 사용(실전 전용이면 REAL_ONLY 에 이유와 함께)`);
  }
});
