'use strict';
/* 자동매매 → 매매 엔진 연결부(broker) — 실거래 전환 1단계(2026-11-18)

   자동매매(auto.js · auto-exec.js · auto-eod.js · auto-journal.js)는 그동안 가상 엔진(paper.js)을 직접 불렀다.
   이제는 전략마다 broker.of(전략ID) 를 받아 쓰고, 그 전략의 실행 모드(가상/실전)에 맞는 엔진으로 연결된다.
   실행 모드를 고르는 설정은 2단계에서 붙인다 — 지금은 modeOf 가 없으면 모든 전략이 가상(지금과 똑같이 동작).

   두 엔진의 차이를 여기서 같은 모양으로 맞춘다.
   · 주문 상태: 실전의 pending(KIS 로 보내는 중)·unknown(응답 없음)은 둘 다 "접수 확인 중" → status 'unsure'(원래 값은 rawStatus).
     자동매매는 'unsure' 를 "아직 살아 있지만 정정·취소할 수 없는 주문"으로 다룬다(체결조회로 확인될 때까지 기다림).
   · 즉시 체결: 가상은 주문 응답에 fills 가 오지만 실전은 체결조회로 나중에 온다 → 실전 응답의 fills 는 항상 [].
   · 보유 종목: 엔진마다 Set 이 아니라 배열을 돌려주던 곳이 섞여 있어 항상 Set 으로. 실전은 잔고를 새로 읽은 뒤의 값(직접 산 종목 포함).
     실전 보유를 확인하지 못하면 예외 — 부르는 쪽이 "확인 못 함 = 사지 않음"으로 처리한다(빈 목록으로 착각하지 않게).
   · 주문 출처: 자동매매가 내는 주문에 origin='auto:<전략ID>' 를 붙인다(실제 계좌에서 직접 주문과 구분 · 3단계 대사에 사용).
   · 엔진이 없으면(실전 계좌 미설정 등) of() 의 메서드는 503 오류를 돌려준다 — 주문을 다른 엔진으로 돌리지 않는다. */

const UNSURE = new Set(['pending', 'unknown']);
const ACTIVE = new Set(['open', 'partial', 'unsure']);
const normOrder = o => (o && UNSURE.has(o.status) ? { ...o, status: 'unsure', rawStatus: o.status } : o);
const isActive = o => !!o && ACTIVE.has(o.status);
const KINDS = ['paper', 'live'];
const LABEL = { paper: '가상', live: '실전' };
const noEngine = kind => ({ ok: false, status: 503, error: `${LABEL[kind] || kind}매매 엔진을 쓸 수 없습니다` });

function createBroker(deps = {}) {
  const engines = { paper: deps.paper || null, live: deps.live || null };
  const modeOf = sid => { try { const m = deps.modeOf ? deps.modeOf(sid) : 'paper'; return m === 'live' ? 'live' : 'paper'; } catch (_) { return 'paper'; } };
  /* 지금 쓰이는 엔진 종류(활성 전략들의 모드). 가상은 항상 포함(이월·직접 주문 화면이 가상 기준으로 돌기 때문) */
  const kindsInUse = () => {
    const s = new Set(['paper']);
    try { for (const k of (deps.kinds ? deps.kinds() : [])) if (k === 'live') s.add('live'); } catch (_) {}
    return KINDS.filter(k => s.has(k) && engines[k]);
  };

  async function heldOf(kind) {
    const e = engines[kind];
    if (!e || !e.heldCodes) return new Set();
    if (kind === 'live') {                                   // 실전: 잔고를 새로 읽은 뒤(30초 이내)의 보유 + 진행 중 매수. 못 읽으면 예외
      const S = await e.state();
      if (!S || !S.ok) throw new Error((S && S.error) || '실전 잔고를 확인하지 못했습니다');
      if (S.account === false) throw new Error('실전 계좌가 설정되지 않았습니다');
    }
    return new Set(e.heldCodes());
  }
  const tagged = (S, kind) => ({
    ...S, kind,
    orders: (S.orders || []).map(o => ({ ...normOrder(o), kind })),
    positions: (S.positions || []).map(p => ({ ...p, kind })),
    fills: (S.fills || []).map(f => ({ ...f, kind })),
  });

  /* 전략 하나의 연결부. 호출할 때마다 그 순간의 모드로 엔진을 고른다(모드를 바꾼 뒤 새로 만들 필요 없음).
     모드 전환은 그 전략의 진행 중 주문·보유가 없을 때만 허용해야 한다(2단계에서 설정 화면이 막음). */
  function of(sid) {
    const origin = sid ? `auto:${String(sid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}` : 'auto';
    const K = () => modeOf(sid), E = () => engines[K()];
    const res = r => (r && r.ok ? { ...r, ...(r.order ? { order: normOrder(r.order) } : {}), fills: r.fills || [] } : r);
    return {
      sid: sid || null, origin,
      get kind() { return K(); },
      get real() { return K() === 'live'; },
      get label() { return LABEL[K()]; },
      get available() { return !!E(); },
      async place(body) { const e = E(); if (!e) return noEngine(K()); return res(await e.place({ ...body, origin })); },
      async modify(body) { const e = E(); if (!e) return noEngine(K()); return res(await e.modify(body)); },
      async cancel(id) { const e = E(); if (!e) return noEngine(K()); return res(await e.cancel(id)); },
      async editPlan(body) { const e = E(); if (!e) return noEngine(K()); return e.editPlan(body); },
      async state() { const e = E(); if (!e) return noEngine(K()); const S = await e.state(); return S && S.ok ? tagged(S, K()) : S; },
      held: () => heldOf(K()),
    };
  }

  /* 전략을 가리지 않는 조회(후보 제외·노출액·화면·일지): 쓰이는 엔진 전부를 합친 보기. 각 행에 kind 가 붙는다.
     같은 종목을 가상·실전에서 동시에 보유하면 행이 둘이 된다(화면 분리는 2·3단계). */
  async function heldAll() {
    const out = new Set();
    for (const k of kindsInUse()) {
      let s;
      try { s = await heldOf(k); }
      catch (e) { if (k === 'live') throw e; s = new Set(); }   // 가상은 지금처럼 실패해도 빈 목록, 실전은 "확인 못 함"을 위로 알림
      for (const c of s) out.add(c);
    }
    return out;
  }
  async function stateAll() {
    const parts = [];
    for (const k of kindsInUse()) {
      const S = await engines[k].state();
      if (!S || !S.ok) { if (k === 'paper') return S; continue; }   // 가상 상태를 못 읽으면 지금처럼 실패로, 실전만 못 읽으면 가상만으로
      parts.push(tagged(S, k));
    }
    if (parts.length === 1) return parts[0];
    const [p0] = parts;
    return { ...p0, kind: 'all', positions: parts.flatMap(p => p.positions), orders: parts.flatMap(p => p.orders), fills: parts.flatMap(p => p.fills),
      realizedToday: parts.reduce((a, p) => a + (p.realizedToday || 0), 0) };
  }
  /* 아침 보류: fn(code, min, kind) — 엔진마다 자기 종류를 넘겨, 이월 종목을 넘긴 전략의 엔진에서만 보류하게 한다
     (가상 전략이 넘긴 종목과 같은 종목을 실제 계좌에 직접 갖고 있어도 실전 손절이 멈추지 않게) */
  function setPreHold(fn) { for (const k of KINDS) { const e = engines[k]; if (e && e.setPreHold) e.setPreHold((code, min) => fn(code, min, k)); } }

  return { of, heldAll, stateAll, setPreHold, kindsInUse, modeOf, has: !!(engines.paper || engines.live), engines };
}

module.exports = { createBroker, normOrder, isActive, UNSURE, ACTIVE };
