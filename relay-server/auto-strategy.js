'use strict';
/* 자동매매 컨트롤 타워 A단계(2026-11-15) — 전략 = 엔진 유형(intraday 장중매매 | closing 종가베팅) + 조건값(params)
   · SCHEMA 하나가 기본값·조정 범위·검증·화면 표시(라벨·묶음·설명)의 기준. 서버 검증과 사이트 편집 화면이 같은 정의를 쓴다
   · 기본값 = 1~3단계에서 확정해 코드에 박혀 있던 값 그대로 → 기본 전략으로 돌리면 지금과 같은 동작
   · 저장할 때마다 버전을 올리고(auto_strategy_versions) 바뀐 항목을 남긴다
   · 테이블이 아직 없으면(165 SQL 실행 전) 기본 전략 2개를 메모리에서 써서 기존처럼 동작한다 */

const tmin = s => { const m = /^(\d{2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : NaN; };
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const ENUM = {
  flow: { req: '필수', bonus: '가점만', ignore: '무시' },
  smx: { cont_stall: '매집 지속·정체', cont: '매집 지속만', off: '보지 않음' },
  buyPick: { q1: '잔량 최다 매수 호가', bid1: '최우선 매수 호가', low: '가장 낮은 매수 호가' },
  eodWeak: { ask: '알림 후 승인 시 정리', auto_sell: '자동 정리', keep: '정리하지 않고 유지' },
  eodTimeout: { keep: '유지', sell: '정리' },
  approval: { manual: '텔레그램 승인 필수', auto: '알림 후 자동 매수' },
  carryFlow: { any: '외국인·기관 중 하나', both: '외국인·기관 둘 다', ignore: '보지 않음' },
};

/* type: num | time | times | bool | enum | weights. group 순서 = 화면 순서 */
const F = (key, group, label, type, def, more = {}) => ({ key, group, label, type, def, ...more });
const SCHEMA = {
  intraday: [
    F('selectAt', '적용 시간', '후보 선정 시각', 'time', '10:05', { min: '09:10', max: '14:00' }),
    F('noticeAfter', '적용 시간', '선정 후 알림까지', 'num', 10, { min: 0, max: 30, step: 1, unit: '분' }),
    F('approveWindow', '적용 시간', '알림 후 승인 마감까지', 'num', 15, { min: 5, max: 60, step: 1, unit: '분' }),
    F('capMinEok', '대상', '시가총액 하한', 'num', 10000, { min: 1000, max: 100000, step: 1000, unit: '억원' }),
    F('maTrend', '대상', '종가 > 60일선 > 120일선', 'bool', true),
    F('smx', '대상', '스마트머니 상태', 'enum', 'cont_stall', { opts: ENUM.smx }),
    F('flowForeign', '매수 조건', '외국인 순매수', 'enum', 'req', { opts: ENUM.flow }),
    F('flowInst', '매수 조건', '기관 순매수', 'enum', 'req', { opts: ENUM.flow }),
    F('flowProgram', '매수 조건', '프로그램 순매수', 'enum', 'req', { opts: ENUM.flow }),
    F('cttrMin', '매수 조건', '체결강도 하한', 'num', 100, { min: 80, max: 200, step: 1, unit: '%' }),
    F('openRiseMax', '매수 조건', '시가 대비 상승률 상한', 'num', 8, { min: 2, max: 15, step: 0.5, unit: '%' }),
    F('poolTop', '후보 수', '점수 상위 후보 수', 'num', 10, { min: 1, max: 20, step: 1, unit: '개' }),
    F('notifyTop', '후보 수', '알림에 싣는 수', 'num', 5, { min: 1, max: 10, step: 1, unit: '개' }),
    F('sectorMax', '후보 수', '같은 업종 최대', 'num', 2, { min: 1, max: 5, step: 1, unit: '개' }),
    F('weights', '점수', '배점(합계 100)', 'weights', { flow: 40, cttr: 15, rise: 15, amt: 15, trend: 15 }, { parts: { flow: '수급', cttr: '체결강도', rise: '상승률', amt: '거래대금', trend: '추세' } }),
    F('perStockKrw', '매수 주문', '종목당 금액', 'num', 1000000, { min: 100000, max: 50000000, step: 10000, unit: '원' }),
    F('buyPick', '매수 주문', '매수가', 'enum', 'q1', { opts: ENUM.buyPick }),
    F('recheckPct', '매수 주문', '승인 후 재확인 허용 변동', 'num', 1.5, { min: 0.5, max: 5, step: 0.1, unit: '%' }),
    F('fillWaitMin', '매수 주문', '미체결 정정·취소 대기', 'num', 3, { min: 1, max: 10, step: 1, unit: '분' }),
    F('approval', '매수 주문', '승인 방식', 'enum', 'manual', { opts: ENUM.approval }),
    F('stopPct', '매도', '손절', 'num', 5, { min: 2, max: 10, step: 0.5, unit: '%' }),
    F('rr', '매도', '손익비(매물대 없을 때 목표)', 'num', 3, { min: 1, max: 5, step: 0.5, unit: '배' }),
    F('split', '매도', '익절 분할 수', 'num', 5, { min: 1, max: 5, step: 1, unit: '회' }),
    F('minPct', '매도', '1단계 익절 최소', 'num', 3, { min: 1, max: 10, step: 0.5, unit: '%' }),
    F('trail', '매도', '트레일링', 'num', 2, { min: 0.5, max: 5, step: 0.1, unit: '%' }),
    F('eodWeak', '매도', '15:10 약한 종목 처리', 'enum', 'ask', { opts: ENUM.eodWeak }),
    F('eodTimeout', '매도', '정리 질문 무응답 시', 'enum', 'keep', { opts: ENUM.eodTimeout }),
  ],
  closing: [
    F('judgeAt', '적용 시간', '종가 판정 시각', 'time', '15:10', { min: '14:50', max: '15:15' }),
    F('replyMin', '적용 시간', '정리 답 마감까지', 'num', 8, { min: 3, max: 10, step: 1, unit: '분' }),
    F('convertAt', '적용 시간', '오버나잇 전환 시각', 'time', '20:00', { min: '15:30', max: '20:00' }),
    F('needAboveAvg', '넘길 자격', '현재가 > 매수 평균가', 'bool', true),
    F('highNearPct', '넘길 자격', '당일 고가 대비 이내', 'num', 2, { min: 0.5, max: 5, step: 0.5, unit: '%' }),
    F('carryFlow', '넘길 자격', '수급', 'enum', 'any', { opts: ENUM.carryFlow }),
    F('idxFloor', '넘길 자격', '지수 하한(코스피·코스닥)', 'num', -1, { min: -3, max: 0, step: 0.1, unit: '%' }),
    F('overnightStopPct', '오버나잇', '밤새 유지할 손절', 'num', 5, { min: 2, max: 10, step: 0.5, unit: '%' }),
    F('gapCut', '다음 날 매도', '갭 하락 즉시 전량', 'num', -3, { min: -10, max: -1, step: 0.5, unit: '%' }),
    F('slices', '다음 날 매도', '분할 매도 시각', 'times', ['09:05', '09:10', '09:15'], { min: '09:01', max: '10:00', maxLen: 5 }),
  ],
};
const KINDS = { intraday: '장중매매', closing: '종가베팅' };
const MAX_ACTIVE = { intraday: 3, closing: 1 };   // 동시에 켤 수 있는 수(종가베팅은 장중 보유분을 넘겨받는 방식이라 하나만)
const LETTERS = ['A', 'B', 'C'];

const defaults = kind => Object.fromEntries((SCHEMA[kind] || []).map(f => [f.key, JSON.parse(JSON.stringify(f.def))]));

/* 검증: 모르는 키는 버리고, 빠진 키는 base(없으면 기본값)로 채움 → { val } | { errs:[{key,msg}] } */
function validate(kind, input, base) {
  const S = SCHEMA[kind];
  if (!S) return { errs: [{ key: 'kind', msg: '전략 유형이 올바르지 않습니다' }] };
  const src = input && typeof input === 'object' ? input : {}, b = { ...defaults(kind), ...(base || {}) }, val = {}, errs = [];
  const bad = (f, msg) => errs.push({ key: f.key, msg: `${f.label}: ${msg}` });
  for (const f of S) {
    const v = src[f.key] === undefined ? b[f.key] : src[f.key];
    if (f.type === 'num') {
      const n = typeof v === 'string' && v.trim() !== '' ? +v : v;
      if (typeof n !== 'number' || !isFinite(n)) { bad(f, '숫자가 아닙니다'); continue; }
      if (n < f.min || n > f.max) { bad(f, `${f.min}~${f.max}${f.unit || ''} 사이여야 합니다`); continue; }
      const k = Math.round(n / f.step);
      if (Math.abs(k * f.step - n) > 1e-9) { bad(f, `${f.step}${f.unit || ''} 단위여야 합니다`); continue; }
      val[f.key] = Math.round(k * f.step * 1e6) / 1e6;
    } else if (f.type === 'time') {
      const m = tmin(v);
      if (isNaN(m) || m < tmin(f.min) || m > tmin(f.max)) { bad(f, `${f.min}~${f.max} 사이 HH:MM`); continue; }
      val[f.key] = hhmm(m);
    } else if (f.type === 'times') {
      const a = Array.isArray(v) ? v.map(tmin) : [];
      if (!a.length || a.length > f.maxLen || a.some(m => isNaN(m) || m < tmin(f.min) || m > tmin(f.max))) { bad(f, `1~${f.maxLen}개, ${f.min}~${f.max} 사이`); continue; }
      if (a.some((m, i) => i && m <= a[i - 1])) { bad(f, '시각이 앞에서부터 늘어나야 합니다'); continue; }
      val[f.key] = a.map(hhmm);
    } else if (f.type === 'bool') {
      if (typeof v !== 'boolean') { bad(f, '켜기/끄기 값이 아닙니다'); continue; }
      val[f.key] = v;
    } else if (f.type === 'enum') {
      if (!Object.prototype.hasOwnProperty.call(f.opts, v)) { bad(f, '선택지에 없는 값입니다'); continue; }
      val[f.key] = v;
    } else if (f.type === 'weights') {
      const o = v && typeof v === 'object' ? v : {}, out = {};
      let ok = true;
      for (const p of Object.keys(f.parts)) { const n = +o[p]; if (!Number.isInteger(n) || n < 0 || n > 100) ok = false; out[p] = n; }
      if (!ok) { bad(f, '각 배점은 0~100 정수'); continue; }
      const sum = Object.values(out).reduce((a, x) => a + x, 0);
      if (sum !== 100) { bad(f, `합계가 ${sum}입니다(100이어야 함)`); continue; }
      val[f.key] = out;
    }
  }
  if (!errs.length && kind === 'intraday') {
    if (val.notifyTop > val.poolTop) errs.push({ key: 'notifyTop', msg: '알림에 싣는 수는 점수 상위 후보 수보다 클 수 없습니다' });
    const dl = tmin(val.selectAt) + val.noticeAfter + val.approveWindow;
    if (dl > 14 * 60 + 30) errs.push({ key: 'approveWindow', msg: `승인 마감이 ${hhmm(dl)}입니다(14:30 이전이어야 함)` });
  }
  if (!errs.length && kind === 'closing' && tmin(val.slices[val.slices.length - 1]) >= 15 * 60 + 20) errs.push({ key: 'slices', msg: '분할 매도 시각이 너무 늦습니다' });
  return errs.length ? { errs } : { val };
}

const show = (f, v) => {
  if (v == null) return '–';
  if (f.type === 'bool') return v ? '켜기' : '끄기';
  if (f.type === 'enum') return f.opts[v] || String(v);
  if (f.type === 'times') return v.join('·');
  if (f.type === 'weights') return Object.keys(f.parts).map(p => `${f.parts[p]} ${v[p]}`).join(' · ');
  if (f.type === 'num') return `${f.key === 'perStockKrw' ? v.toLocaleString('ko-KR') : v}${f.unit || ''}`;
  return String(v);
};
/* 변경점: [{key,label,from,to}] (표시용 문자열) */
function diff(kind, a, b) {
  const out = [];
  for (const f of SCHEMA[kind] || []) if (JSON.stringify(a && a[f.key]) !== JSON.stringify(b && b[f.key])) out.push({ key: f.key, label: f.label, from: show(f, a && a[f.key]), to: show(f, b && b[f.key]) });
  return out;
}

/* 엔진이 쓰는 형태로 풀어 줌(시각 → 분) */
function timesOf(I, C) {
  const sel = tmin(I.selectAt), notice = sel + I.noticeAfter, deadline = notice + I.approveWindow;
  const judge = tmin(C.judgeAt), reply = judge + C.replyMin;
  return { sel, notice, deadline, selEnd: deadline + 30, judge, reply, convert: tmin(C.convertAt), slices: C.slices.map(tmin) };
}

const BUILTIN = [
  { id: 'intraday-default', name: '수급 돌파 장중', kind: 'intraday', builtin: true, desc: '오전 외국인·기관·프로그램 동시 순매수 + 체결강도 강세 종목을 사서 당일 손절·5분할 익절' },
  { id: 'closing-default', name: '장중 강세 이월', kind: 'closing', builtin: true, desc: '15:10까지 강한 장중 보유 종목을 들고 가서 다음 날 아침 3분할 매도' },
];
const builtinRow = b => ({ ...b, enabled: true, archived: false, version: 1, params: defaults(b.kind), updated_at: null });

/* 저장소: auto_strategies · auto_strategy_versions. 30초 캐시, 테이블이 없으면 기본 전략으로 동작 */
function createStore({ sbGet, sbWrite, now = Date.now, cacheMs = 30000 }) {
  let cache = null, at = 0, missing = false;
  let chain = Promise.resolve();
  const lock = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const norm = r => {
    const v = validate(r.kind, r.params || {});
    return { id: r.id, name: r.name, kind: r.kind, desc: r.desc || '', enabled: !!r.enabled, archived: !!r.archived, builtin: !!r.builtin, version: +r.version || 1,
      params: v.val || defaults(r.kind), invalid: v.errs ? v.errs.map(e => e.msg) : null, updatedAt: r.updated_at || null };
  };
  async function list(fresh) {
    if (!fresh && cache && now() - at < cacheMs) return cache;
    let rows;
    try { rows = await sbGet('auto_strategies?select=*&order=created_at.asc&limit=100'); missing = false; }
    catch (e) {
      if (/404|PGRST205|does not exist/.test(String(e && e.message))) { missing = true; rows = []; }
      else if (cache) return cache; else throw e;
    }
    const out = rows.map(norm);
    for (const b of BUILTIN) if (!out.some(r => r.id === b.id)) out.push(norm(builtinRow(b)));   // 기본 전략은 항상 있음
    cache = out; at = now();
    return out;
  }
  /* 유형별로 지금 쓰는 전략(A단계: 켜진 것 중 첫 번째, 없으면 기본 전략을 '꺼짐'으로) */
  async function active(kind) {
    const L = (await list()).filter(r => r.kind === kind && !r.archived);
    return L.find(r => r.enabled) || { ...(L.find(r => r.builtin) || norm(builtinRow(BUILTIN.find(b => b.kind === kind)))), enabled: false };
  }
  async function pair() { const [I, C] = await Promise.all([active('intraday'), active('closing')]); return { I, C, T: timesOf(I.params, C.params) }; }
  /* 켜진 장중 전략 전부(최대 3, 만든 순서) + 종가 전략 하나. 각 장중 전략의 시각 T 와 글자(A·B·C) */
  async function actives() {
    const L = await list(), C = await active('closing');
    const Is = L.filter(r => r.kind === 'intraday' && r.enabled && !r.archived).slice(0, MAX_ACTIVE.intraday)
      .map((I, i) => ({ ...I, letter: LETTERS[i], T: timesOf(I.params, C.params) }));
    return { Is, C };
  }
  async function byId(id) {
    const L = await list(), r = L.find(x => x.id === id);
    return r || null;
  }
  /* 저장: patch = { params?(일부만 와도 됨), enabled?, name?, desc? } → 버전 +1 */
  function save(id, patch, who) {
    return lock(async () => {
      if (missing) await list(true);
      if (missing) return { ok: false, status: 503, error: '전략 테이블이 아직 없습니다. DB 설정에서 auto_strategy 를 실행하세요' };
      const cur = (await list(true)).find(r => r.id === id);
      if (!cur) return { ok: false, status: 404, error: '전략을 찾을 수 없습니다' };
      const p = patch || {}, next = { ...cur };
      if (p.params !== undefined) {
        const v = validate(cur.kind, p.params, cur.params);
        if (v.errs) return { ok: false, status: 400, error: v.errs.map(e => e.msg).join(' / '), errs: v.errs };
        next.params = v.val;
      }
      if (p.enabled !== undefined) { if (typeof p.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled 값이 올바르지 않습니다' }; next.enabled = p.enabled; }
      if (next.archived) return { ok: false, status: 400, error: '보관된 전략은 고칠 수 없습니다' };
      let others = [];
      if (next.enabled && !cur.enabled) {
        const on = (await list()).filter(r => r.kind === cur.kind && r.enabled && !r.archived && r.id !== cur.id);
        if (cur.kind === 'intraday' && on.length >= MAX_ACTIVE.intraday) return { ok: false, status: 400, error: `장중 전략은 최대 ${MAX_ACTIVE.intraday}개까지 켤 수 있습니다. 다른 전략을 먼저 끄세요` };
        if (cur.kind === 'closing') others = on;   // 종가베팅은 하나만: 다른 종가 전략은 끔
      }
      if (p.name !== undefined) { const n = String(p.name).trim(); if (!n || n.length > 30) return { ok: false, status: 400, error: '이름은 1~30자' }; next.name = n; }
      if (p.desc !== undefined) next.desc = String(p.desc).slice(0, 200);
      const changed = diff(cur.kind, cur.params, next.params);
      const meta = ['enabled', 'name', 'desc'].filter(k => next[k] !== cur[k]).map(k => ({ key: k, label: { enabled: '켜기/끄기', name: '이름', desc: '설명' }[k], from: String(cur[k]), to: String(next[k]) }));
      if (!changed.length && !meta.length) return { ok: true, strategy: cur, changed: [], unchanged: true };
      next.version = cur.version + 1;
      const ts = new Date(now()).toISOString();
      await sbWrite('auto_strategies?on_conflict=id', 'POST', [{ id: next.id, name: next.name, kind: next.kind, desc: next.desc, enabled: next.enabled, archived: next.archived, builtin: next.builtin, version: next.version, params: next.params, updated_at: ts }]);
      await sbWrite('auto_strategy_versions', 'POST', [{ strategy_id: next.id, version: next.version, params: next.params, changed: [...changed, ...meta], who: who || null, at: ts }]);
      for (const o of others) await writeRow({ ...o, enabled: false, version: o.version + 1 }, [{ key: 'enabled', label: '켜기/끄기', from: 'true', to: 'false' }, { key: 'auto', label: '사유', from: '', to: `${next.name} 켜짐(종가베팅은 하나만)` }], who, ts);
      cache = null;
      return { ok: true, strategy: { ...next, updatedAt: ts }, changed: [...changed, ...meta], turnedOff: others.map(o => o.name) };
    });
  }
  async function writeRow(r, changed, who, ts) {
    await sbWrite('auto_strategies?on_conflict=id', 'POST', [{ id: r.id, name: r.name, kind: r.kind, desc: r.desc || '', enabled: !!r.enabled, archived: !!r.archived, builtin: !!r.builtin, version: r.version, params: r.params, updated_at: ts }]);
    await sbWrite('auto_strategy_versions', 'POST', [{ strategy_id: r.id, version: r.version, params: r.params, changed, who: who || null, at: ts }]);
  }
  /* 새 전략: 기본값 또는 기존 전략 복제. 꺼진 상태로 만든다 */
  function create({ kind, name, desc, from } = {}, who) {
    return lock(async () => {
      await list(true);
      if (missing) return { ok: false, status: 503, error: '전략 테이블이 아직 없습니다' };
      const L = await list(true), src = from ? L.find(r => r.id === from) : null;
      if (from && !src) return { ok: false, status: 404, error: '복제할 전략을 찾을 수 없습니다' };
      const k = src ? src.kind : kind;
      if (!SCHEMA[k]) return { ok: false, status: 400, error: '전략 유형이 올바르지 않습니다' };
      const n = String(name || (src ? src.name + ' 복사본' : KINDS[k] + ' 새 전략')).trim().slice(0, 30);
      if (!n) return { ok: false, status: 400, error: '이름을 입력하세요' };
      if (L.filter(r => !r.archived).length >= 12) return { ok: false, status: 400, error: '전략은 최대 12개까지 만들 수 있습니다(보관 제외)' };
      const id = `${k}-${now().toString(36)}`, ts = new Date(now()).toISOString();
      const row = { id, name: n, kind: k, desc: String(desc != null ? desc : (src ? src.desc : '')).slice(0, 200), enabled: false, archived: false, builtin: false, version: 1, params: src ? JSON.parse(JSON.stringify(src.params)) : defaults(k) };
      await writeRow(row, [{ key: 'init', label: '처음 만듦', from: '', to: src ? `복제: ${src.name} v${src.version}` : '기본값' }], who, ts);
      cache = null;
      return { ok: true, strategy: { ...row, updatedAt: ts } };
    });
  }
  /* 보관(삭제): 기본 전략·켜진 전략은 안 됨. 기록은 남는다 */
  function archive(id, who) {
    return lock(async () => {
      const cur = (await list(true)).find(r => r.id === id);
      if (!cur) return { ok: false, status: 404, error: '전략을 찾을 수 없습니다' };
      if (cur.builtin) return { ok: false, status: 400, error: '기본 전략은 삭제할 수 없습니다. 끄기만 할 수 있어요' };
      if (cur.enabled) return { ok: false, status: 400, error: '켜진 전략은 삭제할 수 없습니다. 먼저 끄세요' };
      if (cur.archived) return { ok: true, unchanged: true };
      const ts = new Date(now()).toISOString();
      await writeRow({ ...cur, archived: true, version: cur.version + 1 }, [{ key: 'archived', label: '삭제(보관)', from: '', to: '보관함' }], who, ts);
      cache = null;
      return { ok: true };
    });
  }
  async function versions(id) {
    if (missing) return [];
    return sbGet(`auto_strategy_versions?select=version,changed,who,at&strategy_id=eq.${encodeURIComponent(id)}&order=version.desc&limit=50`).catch(() => []);
  }
  return { list, active, pair, actives, byId, save, create, archive, versions, isMissing: () => missing, invalidate: () => { cache = null; } };
}

/* 화면용 스키마(JSON 그대로 보냄) */
const publicSchema = () => ({ kinds: KINDS, fields: SCHEMA, maxActive: MAX_ACTIVE });

module.exports = { SCHEMA, KINDS, ENUM, BUILTIN, MAX_ACTIVE, LETTERS, defaults, validate, diff, timesOf, tmin, hhmm, createStore, publicSchema };
