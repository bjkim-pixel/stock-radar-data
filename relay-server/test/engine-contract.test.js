'use strict';
/* 엔진 규격 시험(2026-11-19 분리 기획 C): 가상(paper)·드라이런(dry)·실전(live, 가짜 KIS) 세 장부가 같은 규격·같은 동작을 하는지 한 벌의 시험으로 확인.
   한 장부에만 기능을 넣으면 여기서 실패한다 — 두 쪽 모두 넣거나, 한쪽 전용이면 아래 ONLY 표에 이유와 함께 추가 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, fakeKis, boot } = require('./paper-harness');

const REAL = { REAL_TRADING_ENABLED: '1', KIS_ACCOUNT_NO: '12345678-01' };
const KINDS = ['paper', 'dry', 'live'];
/* 한쪽 전용 함수(이유): 여기 없는 함수가 한 장부에만 있으면 실패 */
const ONLY = {
  live: ['account', 'buyable', 'drain', 'probe', 'reconSnapshot', '_bal', '_plans'],   // 실제 계좌 조회·대사·배포 중 보내는 중 주문 정리 — 가상 장부엔 계좌가 없음
  paper: ['_dirty', '_positions'], dry: ['_dirty', '_positions'],                         // 시험용 내부 상태
};
async function rig() {
  const db = fakeDb(), kx = fakeKis(), c = await boot(db, { envExtra: REAL, kx });
  const settle = async kind => { if (kind !== 'live') return; for (let i = 0; i < 3; i++) { c.st.clock += 31000; await c.t.live.tick(); } };   // 실전은 체결조회로 따라옴
  return { db, kx, c, settle };
}

test('규격: 세 장부가 같은 함수를 가짐(한쪽 전용은 ONLY 표에 이유와 함께)', async () => {
  const { c } = await rig();
  const keys = Object.fromEntries(KINDS.map(k => [k, new Set(Object.keys(c.t[k]))]));
  const common = [...keys.paper].filter(f => KINDS.every(k => keys[k].has(f)));
  for (const k of KINDS) {
    const extra = [...keys[k]].filter(f => !common.includes(f)).sort();
    assert.deepEqual(extra, (ONLY[k] || []).slice().sort(), `${k} 에만 있는 함수 — 다른 장부에도 넣거나 ONLY 에 이유와 함께 추가`);
  }
  for (const f of ['place', 'cancel', 'modify', 'editPlan', 'state', 'report', 'health', 'reload', 'heldCodes', 'watchLines', 'kick', 'setPreHold']) assert.ok(common.includes(f), `공통 함수 ${f}`);
  await c.close();
});

for (const kind of KINDS) {
  test(`동작[${kind}]: 지정가 매수 대기 → 상태에 보임 → 정정 → 취소`, async () => {
    const { c, settle } = await rig();
    const E = c.t[kind];
    const r = await E.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9000, qty: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const id = r.order.id;
    let st = await E.state();
    assert.equal(st.ok, true);
    const o = st.orders.find(x => x.id === id);
    assert.ok(o, '주문 목록에 보임');
    for (const f of ['id', 'code', 'side', 'type', 'qty', 'status']) assert.ok(f in o, `주문 필드 ${f}`);
    assert.equal(o.code, '005930'); assert.equal(o.side, 'buy');
    const m = await E.modify({ id, price: 9100, qty: 1 });
    assert.equal(m.ok, true, JSON.stringify(m));
    await settle(kind);
    st = await E.state();
    const live1 = st.orders.filter(x => x.code === '005930' && x.side === 'buy' && ['open', 'partial'].includes(x.status));
    assert.equal(live1.length, 1, '정정 뒤 살아 있는 주문 1건');
    const cn = await E.cancel(live1[0].id);
    assert.equal(cn.ok, true, JSON.stringify(cn));
    await settle(kind);
    st = await E.state();
    assert.equal(st.orders.filter(x => x.code === '005930' && ['open', 'partial'].includes(x.status)).length, 0, '취소 뒤 대기 주문 없음');
    await c.close();
  });

  test(`동작[${kind}]: 시장가 매수 체결 → 보유 → 손절 계획 저장 · 보유 없는 매도는 거부`, async () => {
    const { c, settle, kx } = await rig();
    const E = c.t[kind];
    const r = await E.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    await settle(kind);
    const st = await E.state();
    const p = st.positions.find(x => x.code === '005930');
    assert.ok(p, `${kind}: 보유에 보임 ${JSON.stringify(st.positions)}`); assert.equal(p.qty, 2);
    const pl = await E.editPlan({ code: '005930', stop: 9500 });
    assert.equal(pl.ok, true, JSON.stringify(pl));
    assert.ok(E.heldCodes().has('005930'));
    const bad = await E.place({ code: '000660', name: 'SK하이닉스', side: 'sell', type: 'limit', price: 10000, qty: 1 });
    assert.equal(bad.ok, false, '보유 없는 종목 매도는 거부');
    if (kind === 'live') assert.equal(kx.posts.filter(x => x.tr === 'TTTC0011U').length, 0, 'KIS 로 매도가 나가지 않음');
    await c.close();
  });

  test(`동작[${kind}]: 긴급 정지 중 신규 매수 거부 · 매도는 허용(같은 규칙)`, async () => {
    const { c, settle } = await rig();
    const E = c.t[kind];
    await E.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'market', qty: 1 }); await settle(kind);
    await c.t.adminKill('test');
    const b = await E.place({ code: '005930', name: '삼성전자', side: 'buy', type: 'limit', price: 9000, qty: 1 });
    assert.equal(b.ok, false); assert.match(String(b.error), /halted/);
    const s = await E.place({ code: '005930', name: '삼성전자', side: 'sell', type: 'limit', price: 10000, qty: 1 });
    assert.equal(s.ok, true, `${kind}: 정지 중에도 매도 ${JSON.stringify(s)}`);
    await c.close();
  });
}
