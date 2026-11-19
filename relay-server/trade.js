'use strict';
/* ════════════════════════════════════════════════════════════════════════
   매매 보안 기반 (2026-11-12 · 매매 1단계)
   ────────────────────────────────────────────────────────────────────────
   브라우저는 KIS 키를 갖지 않고, 이 모듈이 요청마다 아래를 서버에서 강제합니다.
     1) 로그인 토큰   — Supabase /auth/v1/user 로 서명·만료를 검증하고, 이메일이 ALLOWED_EMAIL 과 같아야 통과
     2) 거래 PIN      — PBKDF2 해시와 비교(원문은 어디에도 저장 안 함). 5회 틀리면 30분 잠금. 통과하면 15분 거래 세션 발급
     3) 재전송 방어   — POST 마다 1회용 nonce + 시각(±30초). 같은 nonce 재사용·오래된 요청 거부
     4) 긴급 정지     — TRADING_ENABLED / REAL_TRADING_ENABLED 환경변수 + 화면의 정지 버튼(메모리 플래그)
     5) 한도          — 1회 금액 · 1일 누적 · 동시 보유 종목 수 · 매수 허용 시간대 (checkLimits / guard)
     6) 감사 기록     — 모든 요청(거부 포함)을 Supabase trade_audit 에 남기고, 중요 이벤트는 폰 알림
   KIS 주문 API 를 부르는 코드는 없습니다(실전 주문은 6단계). 가상 주문(paper.js)은 여기 authz/guard/checkLimits 를 거쳐야만 처리됩니다.
   ════════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { createPaper } = require('./paper');
const { createLive } = require('./live');
const SES = require('./session');
const { createKisOrder } = require('./kis-order');
const { guardKis } = require('./kis-allow');
const { promisify } = require('util');
const pbkdf2 = promisify(crypto.pbkdf2);

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const teq = (a, b) => {
  a = Buffer.from(String(a)); b = Buffer.from(String(b));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const numEnv = (v, d) => (v !== undefined && v !== '' && isFinite(+v)) ? +v : d;

/* ── PIN 해시: pbkdf2$반복수$salt(base64)$hash(base64) — web/pin-hash.html 과 같은 형식 ── */
async function hashPin(pin, iter = 210000) {
  const salt = crypto.randomBytes(16);
  const h = await pbkdf2(String(pin), salt, iter, 32, 'sha256');
  return `pbkdf2$${iter}$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function verifyHash(pin, stored) {
  const m = /^pbkdf2\$(\d{5,7})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || '').trim());
  if (!m) return false;
  const iter = +m[1];
  if (iter < 100000 || iter > 2000000) return false;
  const want = Buffer.from(m[3], 'base64');
  if (want.length < 16) return false;
  const got = await pbkdf2(String(pin), Buffer.from(m[2], 'base64'), iter, want.length, 'sha256');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function parseHours(s) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return [8 * 60, 20 * 60];
  return [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]];
}

function loadConfig(env) {
  return {
    supabaseUrl: env.SUPABASE_URL || 'https://frurnmrwuopvttoqdvgj.supabase.co',
    anonKey: env.SUPABASE_ANON_KEY || '',
    allowedEmail: String(env.ALLOWED_EMAIL || '').trim().toLowerCase(),
    pinHash: String(env.TRADE_PIN_HASH || '').trim(),
    enabled: env.TRADING_ENABLED === '1',
    realEnabled: env.REAL_TRADING_ENABLED === '1',
    sessionMs: numEnv(env.TRADE_SESSION_MIN, 15) * 60000,
    idleMs: numEnv(env.TRADE_IDLE_MIN, 5) * 60000,          // 무조작 자동 잠금(클라이언트가 조작 중일 때만 x-active 를 보냄)
    approval: env.TRADE_APPROVAL !== '0',                  // 새 기기·실전 스위치 ON 일 때 텔레그램 승인 요구(0 이면 끔 — 텔레그램 불능으로 잠겼을 때의 비상구)
    approvalMs: 3 * 60000,
    sessionMaxMs: numEnv(env.TRADE_SESSION_MAX_HOURS, 4) * 3600000,
    maxSessions: numEnv(env.TRADE_MAX_SESSIONS, 1),
    pinMaxFails: numEnv(env.PIN_MAX_FAILS, 5),
    pinLockMs: numEnv(env.PIN_LOCK_MIN, 30) * 60000,
    replayMs: numEnv(env.REPLAY_WINDOW_SEC, 30) * 1000,
    hours: parseHours(env.TRADE_HOURS || '08:00-20:00'),      // KST, 신규 매수 허용 시간대
    ntfyTopic: String(env.NTFY_TOPIC || '').trim(),
    limits: {
      REAL:    { order: numEnv(env.MAX_ORDER_KRW, 500000),     day: numEnv(env.MAX_DAILY_KRW, 2000000),     positions: numEnv(env.MAX_POSITIONS, 5) },
      VIRTUAL: { order: numEnv(env.VIRTUAL_MAX_ORDER_KRW, 5000000), day: numEnv(env.VIRTUAL_MAX_DAILY_KRW, 20000000), positions: numEnv(env.VIRTUAL_MAX_POSITIONS, 10) },
    },
  };
}

/* 한도 검사(순수 함수). mode: 'REAL'|'VIRTUAL', orderKrw: 이번 주문 금액, dayKrw: 오늘 이미 낸 매수 금액,
   positions: 현재 보유 종목 수, isNewPosition: 이번 주문이 새 종목인지 */
function checkLimits(limits, { mode, orderKrw, dayKrw = 0, positions = 0, isNewPosition = true }) {
  const L = limits[mode === 'REAL' ? 'REAL' : 'VIRTUAL'];
  if (!isFinite(orderKrw) || orderKrw <= 0) return { ok: false, error: 'invalid amount' };
  if (orderKrw > L.order) return { ok: false, error: `1회 주문 한도 초과 (${L.order.toLocaleString('ko-KR')}원)` };
  if (dayKrw + orderKrw > L.day) return { ok: false, error: `1일 누적 한도 초과 (${L.day.toLocaleString('ko-KR')}원)` };
  if (isNewPosition && positions >= L.positions) return { ok: false, error: `동시 보유 종목 한도 초과 (${L.positions}종목)` };
  return { ok: true };
}

const SECRET_KEY = /pin|token|secret|key|password|authorization|appkey|account/i;
function scrub(o, depth = 0) {
  if (o == null || depth > 3) return o == null ? null : String(o).slice(0, 100);
  if (typeof o === 'string') return o.slice(0, 300);
  if (typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.slice(0, 20).map(v => scrub(v, depth + 1));
  const out = {};
  for (const k of Object.keys(o).slice(0, 30)) out[k] = SECRET_KEY.test(k) ? '[숨김]' : scrub(o[k], depth + 1);
  return out;
}

function createTrade(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const doFetch = deps.fetch || fetch;
  // IP: Cloudflare 가 덮어쓰는 cf-connecting-ip 우선, 없으면 X-Forwarded-For 의 맨 오른쪽 값(프록시가 붙인 값).
  // X-Forwarded-For 맨 앞 값은 요청자가 마음대로 넣을 수 있어 IP별 제한 우회에 쓰일 수 있음
  const clientIp = deps.clientIp || (req => {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf.slice(0, 64);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    return String(xff.length ? xff[xff.length - 1] : ((req.socket && req.socket.remoteAddress) || '')).replace(/^::ffff:/, '').slice(0, 64);
  });
  const allowedOrigins = deps.allowedOrigins || [];
  const cfg = loadConfig(env);

  /* realOn = 사이트 "실전 주문" 스위치(2026-11-19). REAL_TRADING_ENABLED(환경변수)는 "실전 주문을 낼 수 있는 상한"이고,
     이 스위치가 꺼져 있으면 실전 신규 매수(직접·자동)만 막는다 — 손절·익절·이월 매도와 취소는 계속. 기본 꺼짐, 켜고 끈 기록(real_on/real_off)을 감사 기록에 남겨 재시작 뒤에도 유지 */
  const state = { halted: false, realOn: false, realSetAt: 0, pinFails: 0, pinLockUntil: 0 };
  const sessions = new Map();     // sid -> { uid, exp, abs, act }
  const pending = new Map();     // reqId -> { uid, code, c, exp, status:'wait'|'ok'|'deny', devId }
  const nonces = new Map();       // nonce -> 만료시각
  const userCache = new Map();    // sha(token) -> { res, exp }
  const ipHits = new Map();       // ip -> [ts...]
  const auditThrottle = new Map();
  let pinChain = Promise.resolve();   // PIN 검사를 한 줄로 세워 동시 시도로 횟수 제한을 우회하지 못하게 함

  const sweep = () => {
    const t = now();
    for (const [k, v] of sessions) if (v.exp <= t || v.abs <= t) sessions.delete(k);
    for (const [k, v] of pending) if (v.exp + 60000 <= t) pending.delete(k);
    for (const [k, v] of nonces) if (v <= t) nonces.delete(k);
    for (const [k, v] of userCache) if (v.exp <= t) userCache.delete(k);
    for (const [k, v] of ipHits) { const a = v.filter(x => t - x < 60000); if (a.length) ipHits.set(k, a); else ipHits.delete(k); }
    for (const [k, v] of auditThrottle) if (t - v > 60000) auditThrottle.delete(k);
  };
  const timer = setInterval(sweep, 60000); if (timer.unref) timer.unref();

  /* ── 접속 기기·IP 식별 (2026-11-15) ──
     브라우저가 보내는 x-device-id(무작위 ID)·x-device-info(이름·모델 등)를 기록하고, 처음 보는 기기·IP는 알림에 경고를 붙임.
     모델명은 Chrome 의 UA-CH(model)에서 오며 클라이언트가 보낸 값이라 참고용(위조 가능) — 기기 ID·IP 와 함께 봄. */
  const BUILD = String(env.RENDER_GIT_COMMIT || '').slice(0, 7);
  const known = { ips: new Set(), devs: new Map(), loaded: false };   // devs: id -> { ips:Set, name }
  const HOME_PREFIXES = String(env.HOME_IP_PREFIXES || '').split(',').map(x => x.trim()).filter(Boolean);
  const kst = () => new Date(now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
  const sameNet = (a, b) => String(a).split('.').slice(0, 2).join('.') === String(b).split('.').slice(0, 2).join('.');
  function friendlyModel(m) {
    m = String(m || '');
    if (/^SM-S948/i.test(m)) return '삼성 갤럭시 S26 울트라';
    if (/^SM-S938/i.test(m)) return '삼성 갤럭시 S25 울트라';
    if (/^SM-S928/i.test(m)) return '삼성 갤럭시 S24 울트라';
    if (/iplay/i.test(m)) return 'iPlay 태블릿';
    if (/^SM-/i.test(m)) return '삼성 ' + m;
    return m;
  }
  function devOf(req) {
    const id = String(req.headers['x-device-id'] || '').toLowerCase();
    let info = {};
    try { info = JSON.parse(decodeURIComponent(String(req.headers['x-device-info'] || '').slice(0, 1200))) || {}; } catch (_) {}
    const cl = v => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, 60);
    const d = { id: /^[0-9a-f-]{16,40}$/.test(id) ? id : '', name: cl(info.n), model: cl(info.m), brand: cl(info.b), plat: cl(info.p), pv: cl(info.pv) };
    d.label = d.name || friendlyModel(d.model) || (d.id ? '이름 없는 기기' : '기기 정보 없음');
    return d;
  }
  function classify(req) {
    const ip = clientIp(req), d = devOf(req), flags = [];
    const kd = d.id ? known.devs.get(d.id) : null;
    if (!d.id) flags.push('기기 정보 없음');
    else if (known.loaded && !kd) flags.push('새 기기');
    if (known.loaded && !known.ips.has(ip)) flags.push('새 IP');
    if (/iplay/i.test(d.name + ' ' + d.model)) {   // 태블릿은 집 Wi-Fi 에서만 씀
      const ok = HOME_PREFIXES.length ? HOME_PREFIXES.some(x => ip.startsWith(x)) : (kd ? [...kd.ips].some(x => sameNet(x, ip)) : true);
      if (!ok) flags.push('집 밖 접속(태블릿은 집 Wi-Fi 전용)');
    }
    return { ip, d, flags, danger: flags.some(f => /새 기기|집 밖|기기 정보 없음/.test(f)) };
  }
  function remember(c) {
    known.ips.add(c.ip);
    if (c.d.id) { const k = known.devs.get(c.d.id) || { ips: new Set(), name: c.d.label }; k.ips.add(c.ip); k.name = c.d.label; known.devs.set(c.d.id, k); }
  }
  const whoText = (c) => `📱 ${c.d.label}${c.d.model ? ` (${c.d.model})` : ''}\n🌐 ${c.ip}`;
  const warnText = (c) => c.flags.length ? (c.danger ? '🚨 ' : '⚠ ') + c.flags.join(' · ') + '\n' : '';
  async function loadKnown() {
    const since = new Date(now() - 90 * 864e5).toISOString();
    const rows = await deps.sbGet(`trade_audit?select=ip,detail&event=eq.session_open&ts=gte.${encodeURIComponent(since)}&limit=2000`);
    for (const r of rows) {
      if (r.ip) known.ips.add(r.ip);
      const id = r.detail && r.detail.dev && r.detail.dev.id;
      if (id) { const k = known.devs.get(id) || { ips: new Set(), name: (r.detail.dev.n || '') }; if (r.ip) k.ips.add(r.ip); known.devs.set(id, k); }
    }
    known.loaded = true;
  }

  /* ── 알림 · 감사 ── */
  async function alert(text, title = '매매 보안') {
    try { if (deps.notify) await deps.notify(text, { title, tag: 'trade-security' }); } catch (_) {}
    if (cfg.ntfyTopic) {
      try {
        await doFetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic: cfg.ntfyTopic, title, message: text, priority: 4, tags: ['warning'] }), signal: AbortSignal.timeout(4000) });
      } catch (_) {}
    }
  }
  async function audit(event, ok, detail, req, mode) {
    const det = { ...(detail || {}), real: cfg.realEnabled, build: BUILD };
    if (req) { const dv = devOf(req); det.dev = { id: dv.id, n: dv.name, m: dv.model, b: dv.brand, p: dv.plat }; }
    const row = { event, ok: !!ok, mode: mode || null, ip: req ? clientIp(req) : null, ua: req ? String(req.headers['user-agent'] || '').slice(0, 200) : null, detail: scrub(det) };
    console.log(`[trade] ${event} ${ok ? 'ok' : 'DENY'} ${row.ip || ''}`);
    try { if (deps.sbWrite) { await deps.sbWrite('trade_audit', 'POST', [row]); return true; } }
    catch (e) { if (!/42P01|PGRST205|does not exist/.test(String(e.message))) console.warn('[trade] 감사 기록 실패:', e.message); }
    return false;
  }

  /* ── 재시작 복구: 긴급 정지·PIN 잠금은 메모리에만 있으면 서버 재시작(배포·절전 해제) 때 풀려 버리므로
        감사 기록에서 되살린다. 기록을 못 읽으면 안전 쪽(신규 매수 정지)으로 시작하고 알림. ── */
  let ready = Promise.resolve();
  async function restore() {
    if (!deps.sbGet) return;
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const k = await deps.sbGet('trade_audit?select=event,ts&event=in.(kill,resume)&order=ts.desc&limit=1');
        state.halted = !!(k[0] && k[0].event === 'kill');
        const rk = await deps.sbGet('trade_audit?select=event,ts&event=in.(real_on,real_off)&order=ts.desc&limit=1');
        state.realOn = !!(rk[0] && rk[0].event === 'real_on');   // 기록이 없거나 못 읽으면 꺼짐(안전 쪽)
        const since = new Date(now() - cfg.pinLockMs).toISOString();
        const rows = await deps.sbGet(`trade_audit?select=event,ts&event=in.(pin_fail,session_open)&ts=gte.${encodeURIComponent(since)}&order=ts.asc&limit=500`);
        let fails = 0, lockUntil = 0;
        for (const r of rows) {
          if (r.event === 'session_open') { fails = 0; continue; }
          fails++;
          if (fails >= cfg.pinMaxFails) { fails = 0; lockUntil = Date.parse(r.ts) + cfg.pinLockMs; }
        }
        state.pinFails = fails; state.pinLockUntil = Math.max(state.pinLockUntil, lockUntil);
        if (state.halted) console.log('[trade] 재시작 복구: 긴급 정지 상태 유지');
        try { await loadKnown(); } catch (e) { console.warn('[trade] 접속 기기 이력 읽기 실패:', e && e.message); }
        return;
      } catch (e) {
        lastErr = e;
        if (/42P01|PGRST205|does not exist/.test(String(e.message))) return;   // 감사 테이블 없음 = 아직 설정 전
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    state.halted = true; state.realOn = false;
    console.warn('[trade] 재시작 복구 실패 — 안전을 위해 신규 매수 정지로 시작:', lastErr && lastErr.message);
    alert('서버 재시작 후 매매 상태를 읽지 못해 신규 매수를 정지했습니다. 확인 후 해제하세요.');
  }
  /* 검토 #7: 주문 권한을 새로 얻을 때 긴급 정지 상태를 감사 기록에서 다시 읽음(배포 겹침 중 옛 인스턴스가 받은 /정지 가 새 인스턴스에 전달되게).
     못 읽으면 안전 쪽(정지)으로 + 알림 */
  async function reloadKill(soft) {
    if (!deps.sbGet) return;
    try { const k = await deps.sbGet('trade_audit?select=event,ts&event=in.(kill,resume)&order=ts.desc&limit=1'); const h = !!(k[0] && k[0].event === 'kill'); if (k[0] && Date.parse(k[0].ts) < (state.haltSetAt || 0) - 1000) return; if (!k[0] && state.haltSetAt) return; /* 이 서버에서 방금 바꾼 상태(기록 저장 실패 포함)를 옛 기록으로 되돌리지 않음 */ if (h && !state.halted) console.log('[trade] 권한 획득 — 긴급 정지 상태를 이어받음'); state.halted = h; }
    catch (e) { if (soft || /42P01|PGRST205|does not exist/.test(String(e.message))) return; state.halted = true; alert('주문 권한을 넘겨받았지만 긴급 정지 상태를 읽지 못해 신규 매수를 정지했습니다. 확인 후 해제하세요.'); }
  }
  /* 사이트 "실전 주문" 스위치도 같은 방식으로 다시 읽음 — 다른 인스턴스(배포 겹침)가 받은 /실전정지·끄기가 따라오게. 못 읽으면 그대로 둠(이미 꺼져 있으면 꺼진 채) */
  async function reloadReal() {
    if (!deps.sbGet) return;
    try {
      const k = await deps.sbGet('trade_audit?select=event,ts&event=in.(real_on,real_off)&order=ts.desc&limit=1');
      if (k[0] && Date.parse(k[0].ts) < (state.realSetAt || 0) - 1000) return;   // 이 서버에서 방금 바꾼 상태를 옛 기록으로 되돌리지 않음
      if (!k[0] && state.realSetAt) return;
      const on = !!(k[0] && k[0].event === 'real_on');
      if (on !== state.realOn) console.log(`[trade] 실전 주문 스위치 ${on ? '켜짐' : '꺼짐'}(다른 인스턴스·기록에서 이어받음)`);
      state.realOn = on;
    } catch (_) {}
  }
  async function announce() {
    if (deps.skipLoop || !deps.notify) return;
    await alert(`🔁 서버 시작${BUILD ? ' (' + BUILD + ')' : ''}\n매매 ${cfg.enabled ? 'ON' : 'OFF'} · 실전 스위치(환경변수) ${cfg.realEnabled ? '🚨 ON' : 'OFF'} · 사이트 실전 주문 ${cfg.realEnabled ? (state.realOn ? '🚨 ON(유지)' : 'OFF') : '—'} · 긴급정지 ${state.halted ? 'ON(유지)' : '해제'}`, '서버 상태');
  }
  if (deps.sbGet && !deps.skipRestore) ready = restore().then(announce, announce);
  /* 다른 인스턴스(배포 겹침)가 받은 /정지·해제도 15초 안에 따라가도록 주기적으로 다시 읽음(읽기 실패는 그대로 둠) */
  if (deps.sbGet && !deps.skipRestore && !deps.skipLoop) { const kt = setInterval(() => { ready.then(() => Promise.all([reloadKill(true), reloadReal()])).catch(() => {}); }, 15000); if (kt.unref) kt.unref(); }
  /* 인증 실패처럼 반복될 수 있는 기록은 IP·사유별로 분당 1회만 */
  function auditOnce(event, detail, req) {
    const k = event + '|' + (req ? clientIp(req) : '');
    if (auditThrottle.has(k)) return false;
    auditThrottle.set(k, now());
    audit(event, false, detail, req);
    return true;
  }

  /* ── 로그인 토큰 검증 ── */
  async function verifyUser(req) {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(String(req.headers.authorization || ''));
    if (!m) return { ok: false, status: 401, error: 'unauthorized' };
    if (!cfg.allowedEmail || !cfg.anonKey) return { ok: false, status: 503, error: 'trading not configured' };
    const tok = m[1], key = sha(tok), c = userCache.get(key);
    if (c && c.exp > now()) return c.res;
    let r;
    try {
      r = await doFetch(`${cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(5000) });
    } catch (_) { return { ok: false, status: 503, error: 'auth service unavailable' }; }
    if (r.status === 401 || r.status === 403) return { ok: false, status: 401, error: 'unauthorized' };
    if (!r.ok) return { ok: false, status: 503, error: 'auth service unavailable' };
    let u; try { u = await r.json(); } catch (_) { return { ok: false, status: 503, error: 'auth service unavailable' }; }
    const email = String((u && u.email) || '').toLowerCase();
    if (!u || !u.id || !email || u.is_anonymous === true) return { ok: false, status: 401, error: 'unauthorized' };
    if (!teq(email, cfg.allowedEmail)) return { ok: false, status: 403, error: 'forbidden', wrongUser: true };
    const res = { ok: true, user: { id: String(u.id), email } };
    if (userCache.size > 200) userCache.clear();
    userCache.set(key, { res, exp: now() + 60000 });   // 최대 60초 캐시 — 로그아웃/폐기 반영은 최대 1분 늦을 수 있음
    return res;
  }

  /* ── 거래 세션 ── */
  function openSession(uid) {
    const t = now(), sid = crypto.randomBytes(32).toString('hex');
    sweep();
    while (sessions.size >= cfg.maxSessions) sessions.delete(sessions.keys().next().value);
    sessions.set(sid, { uid, exp: t + cfg.sessionMs, abs: t + cfg.sessionMaxMs, act: t });
    return sid;
  }
  function getSession(sid, uid) {
    if (!/^[0-9a-f]{64}$/.test(String(sid || ''))) return null;
    const s = sessions.get(sid), t = now();
    if (!s || s.exp <= t || s.abs <= t || s.uid !== uid) { if (s && (s.exp <= t || s.abs <= t)) sessions.delete(sid); return null; }
    s.exp = Math.min(t + cfg.sessionMs, s.abs);   // 쓸 때마다 15분 연장(최대 4시간)
    return s;
  }
  const sessionTtlSec = s => Math.max(0, Math.round((s.exp - now()) / 1000));

  /* 로그인(+선택: 거래 세션) 통과 여부. 주문 API는 반드시 session:true 로 호출 */
  async function authz(req, { session = false } = {}) {
    const u = await verifyUser(req);
    if (!u.ok) return u;
    if (session) {
      const s = getSession(req.headers['x-trade-session'], u.user.id);
      if (!s) return { ok: false, status: 401, error: 'pin required' };
      return { ...u, session: s };
    }
    return u;
  }

  /* ── PIN ── */
  function checkPin(pin) {
    const run = async () => {
      const t = now();
      if (t < state.pinLockUntil) return { ok: false, status: 423, error: 'pin locked', retrySec: Math.ceil((state.pinLockUntil - t) / 1000) };
      if (!cfg.pinHash) return { ok: false, status: 503, error: 'pin not configured' };
      const good = typeof pin === 'string' && pin.length >= 4 && pin.length <= 64 && await verifyHash(pin, cfg.pinHash);
      if (good) { state.pinFails = 0; return { ok: true }; }
      state.pinFails++;
      if (state.pinFails >= cfg.pinMaxFails) {
        state.pinFails = 0; state.pinLockUntil = now() + cfg.pinLockMs;
        return { ok: false, status: 423, error: 'pin locked', locked: true, retrySec: Math.round(cfg.pinLockMs / 1000) };
      }
      return { ok: false, status: 401, error: 'invalid pin', left: cfg.pinMaxFails - state.pinFails };
    };
    const p = pinChain.then(run, run);
    pinChain = p.catch(() => {});
    return p;
  }

  /* ── 재전송 방어: POST 본문에 nonce(12~64자) + ts(ms) 필수 ── */
  function checkReplay(body) {
    const nonce = String((body && body.nonce) || ''), ts = Number(body && body.ts);
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(nonce) || !isFinite(ts)) return 'bad request';
    if (Math.abs(now() - ts) > cfg.replayMs) return 'expired';
    if (nonces.has(nonce)) return 'replay';
    nonces.set(nonce, now() + cfg.replayMs * 2 + 1000);
    return null;
  }

  /* 주문 권한(engine-guard.js 의 잠금). 잠금을 안 쓰는 환경(시험·로컬)에서는 항상 true */
  const hasAuthority = () => { try { return deps.authority ? !!deps.authority() : true; } catch (_) { return false; } };
  /* ── 주문 전 점검(3단계 이후 주문 코드가 호출) ── */
  const inHours = () => {
    const d = new Date(now() + 9 * 3600e3), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return m >= cfg.hours[0] && m < cfg.hours[1];
  };
  /* kind: 'buy' | 'sell' | 'cancel'. 긴급 정지·시간대는 신규 매수에만 적용(보유 종목 매도·취소는 정지 중에도 허용) */
  function guard(kind, mode) {
    if (!cfg.enabled) return { ok: false, error: 'trading disabled' };
    if (!hasAuthority()) return { ok: false, error: 'not order authority holder' };   // 배포 중 옛·새 인스턴스가 겹치는 동안 한쪽만 주문
    if (mode === 'REAL' && !cfg.realEnabled) return { ok: false, error: 'real trading disabled' };
    if (mode === 'REAL' && kind === 'buy' && !state.realOn) return { ok: false, error: 'real orders switched off (site switch)' };   // 사이트 "실전 주문" 스위치: 꺼져 있으면 실전 신규 매수만 거부(매도·취소는 계속)
    if (kind === 'buy' && state.halted) return { ok: false, error: 'halted' };
    if (kind === 'buy' && !inHours()) return { ok: false, error: 'outside trading hours' };
    return { ok: true };
  }

  /* ── 시세·호가 조회(읽기 전용) — KIS 실전 시세 API. 응답 필드는 2026-11-12 실제 응답으로 확인(161_quote_probe.py) ── */
  const quoteCache = new Map();   // code -> { t, v, p }
  let strengthCache = new Map();  // code -> { t, v }
  const n = v => { const x = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
  const STAT_WARN = { '51': '관리종목', '52': '투자위험', '53': '투자경고', '54': '투자주의', '58': '거래정지', '59': '단기과열' };
  const MRKT_WARN = { '01': '투자주의', '02': '투자경고', '03': '투자위험' };
  function stockWarnings(o) {
    const w = new Set();
    if (o.temp_stop_yn === 'Y') w.add('거래정지');
    if (o.mang_issu_cls_code === 'Y') w.add('관리종목');
    if (o.sltr_yn === 'Y') w.add('정리매매');
    if (o.short_over_yn === 'Y') w.add('단기과열');
    if (o.invt_caful_yn === 'Y') w.add('투자유의');
    if (MRKT_WARN[o.mrkt_warn_cls_code]) w.add(MRKT_WARN[o.mrkt_warn_cls_code]);
    if (STAT_WARN[o.iscd_stat_cls_code]) w.add(STAT_WARN[o.iscd_stat_cls_code]);
    return [...w];
  }
  /* 종목 구분(8단계): NXT 거래 가능(stocks.nxt_ok) · ETF 등 주식이 아닌 종목. 6시간 캐시, 모르면 KRX 전용·애프터마켓 제외(보수적) */
  const infoCache = new Map();   // code -> { t, v }
  async function codeInfo(code) {
    const c = infoCache.get(code);
    if (c && now() - c.t < (c.v.known ? 6 * 3600e3 : 60000)) return c.v;
    let v = { nxt: null, etf: true, known: false };
    if (deps.sbGet) {
      try {
        const r = await deps.sbGet(`stocks?select=code,nxt_ok,security_type&code=eq.${code}&limit=1`);
        if (r && r[0]) v = { nxt: r[0].nxt_ok == null ? null : !!r[0].nxt_ok, etf: String(r[0].security_type || '') !== 'STOCK', known: true };
        else v = { nxt: null, etf: true, known: true };   // stocks 에 없는 종목(ETF·ETN 등)
      } catch (e) { console.warn('[trade] 종목 구분 조회 실패', code, e && e.message); }
    }
    /* DB 에 NXT 여부가 비어 있으면(아직 148_nxt_flag 미확인 종목) KIS 주식기본조회로 직접 확인 — 종가 판정이 정규장/NXT 를 잘못 나누지 않게 */
    if (v.nxt == null && !(v.known && v.etf) && deps.kisGet && /^\d{6}$/.test(code)) {
      try {
        const j = await deps.kisGet('/uapi/domestic-stock/v1/quotations/search-stock-info', 'CTPF1002R', { PRDT_TYPE_CD: '300', PDNO: code });
        const o = (j && j.output) || {}, yn = o.cptt_trad_tr_psbl_yn;
        if (yn === 'Y' || yn === 'N') v = { ...v, nxt: yn === 'Y' && o.nxt_tr_stop_yn !== 'Y', known: true };
      } catch (e) { console.warn('[trade] NXT 여부 KIS 조회 실패', code, e && e.message); }
    }
    infoCache.set(code, { t: now(), v });
    if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value);
    return v;
  }
  const kstMin = () => { const d = new Date(now() + 9 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  async function fetchQuote(code, mkt = 'J') {
    if (!deps.kisGet) throw new Error('kis unavailable');
    const P = { FID_COND_MRKT_DIV_CODE: mkt, FID_INPUT_ISCD: code };
    const base = '/uapi/domestic-stock/v1/quotations/';
    const [pr, ask] = await Promise.all([
      deps.kisGet(base + 'inquire-price', 'FHKST01010100', P),
      deps.kisGet(base + 'inquire-asking-price-exp-ccn', 'FHKST01010200', P),
    ]);
    const o = pr.output || {}, a = ask.output1 || {}, a2 = ask.output2 || {};
    const asks = [], bids = [];
    for (let i = 1; i <= 10; i++) {
      asks.push({ p: n(a['askp' + i]), q: n(a['askp_rsqn' + i]) });
      bids.push({ p: n(a['bidp' + i]), q: n(a['bidp_rsqn' + i]) });
    }
    const t = now();
    let st = strengthCache.get(code);
    if (!st || t - st.t > 5000) {       // 체결강도는 5초에 한 번만(KIS 호출 절약)
      let v = null;
      try {
        const c = await deps.kisGet(base + 'inquire-ccnl', 'FHKST01010300', P);
        const r0 = Array.isArray(c.output) ? c.output[0] : null;
        if (r0 && r0.tday_rltv != null && r0.tday_rltv !== '') v = n(r0.tday_rltv);
      } catch (_) {}
      st = { t, v }; strengthCache.set(code, st);
      if (strengthCache.size > 100) strengthCache = new Map([...strengthCache].slice(-50));
    }
    return {
      ok: true, code, ts: t,
      price: n(o.stck_prpr), change: n(o.prdy_vrss), changePct: n(o.prdy_ctrt), sign: String(o.prdy_vrss_sign || ''),
      open: n(o.stck_oprc), high: n(o.stck_hgpr), low: n(o.stck_lwpr), prevClose: n(o.stck_sdpr),
      upper: n(o.stck_mxpr), lower: n(o.stck_llam), vol: n(o.acml_vol), amt: n(o.acml_tr_pbmn),
      tick: n(o.aspr_unit) || null, strength: st.v,
      vi: (o.vi_cls_code === 'Y' || a2.vi_cls_code === 'Y'), warnings: stockWarnings(o),
      hour: String(a.aspr_acpt_hour || ''), asks, bids,
      totalAsk: n(a.total_askp_rsqn), totalBid: n(a.total_bidp_rsqn), mkt,
    };
  }
  /* 세션에 맞는 시장(J/NX/UN)으로 조회. 통합(UN) 응답이 비면 KRX(J)로 대신하고 표시(mktFallback) */
  async function sessionQuote(code) {
    const info = await codeInfo(code), s0 = SES.sessionOf(kstMin(), info);
    let q = await fetchQuote(code, s0.mkt), fb = false;
    if (s0.mkt === 'UN' && !(q.price > 0) && !q.asks.some(l => l.p > 0) && !q.bids.some(l => l.p > 0)) { q = await fetchQuote(code, 'J'); fb = true; }
    const full = { nxt: info.nxt, etf: info.etf, warnings: q.warnings };
    const s = SES.sessionOf(kstMin(), full);
    return { ...q, info: full, mktFallback: fb, session: { open: s.open, name: s.name, label: s.label, reason: s.reason, venue: s.venue, market: s.market } };
  }
  function getQuote(code, fresh) {                          // fresh: 틱 깨우기용 — 1.5초 캐시를 건너뜀(진행 중인 요청은 같이 씀)
    const t = now(), c = quoteCache.get(code);
    if (c && c.p) return c.p;                               // 같은 종목 동시 요청은 한 번만
    if (!fresh && c && t - c.t < 1500 && c.v && c.v.sMin === kstMin()) return Promise.resolve(c.v);   // 1.5초 캐시(분이 바뀌면 세션이 바뀔 수 있어 새로)
    const p = sessionQuote(code).then(v => { v.sMin = kstMin(); quoteCache.set(code, { t: now(), v, p: null }); return v; },
      e => { quoteCache.delete(code); throw e; });
    quoteCache.set(code, { t: c ? c.t : 0, v: c ? c.v : null, p });
    if (quoteCache.size > 100) quoteCache.clear();
    return p;
  }

  /* ── 휴장일 조회(KIS chk-holiday, 하루 한 번만 — 호출 부하를 줄이라는 KIS 안내). 모르면 null → 시세 갱신 여부로 판단 ── */
  const holidayCache = new Map();   // 'YYYY-MM-DD' -> { v: true|false|null, t }
  async function isOpenDay(day) {
    const c = holidayCache.get(day);
    if (c && (c.v !== null || now() - c.t < 600000)) return c.v;
    let v = null;
    try {
      if (deps.kisGet) {
        const d8 = day.replace(/-/g, '');
        const r = await deps.kisGet('/uapi/domestic-stock/v1/quotations/chk-holiday', 'CTCA0903R', { BASS_DT: d8, CTX_AREA_NK: '', CTX_AREA_FK: '' });
        const row = (r.output || []).find(x => x.bass_dt === d8);
        if (row && row.opnd_yn) v = row.opnd_yn === 'Y';
      }
    } catch (e) { console.warn('[trade] 휴장일 조회 실패:', e && e.message); }
    holidayCache.set(day, { v, t: now() });
    if (holidayCache.size > 10) holidayCache.delete(holidayCache.keys().next().value);
    return v;
  }

  /* 8단계(시간외) 공통 설정: 손절 지정가 호가 수·재주문 간격, SOR 대신 거래소 직접 지정(TRADE_NO_SOR=1) */
  const extOpts = { stopTicks: Math.round(numEnv(env.STOP_LIMIT_TICKS, 5)), stopRetrySec: numEnv(env.STOP_RETRY_SEC, 20), noSor: env.TRADE_NO_SOR === '1', tpTrail: numEnv(env.TP_TRAIL_PCT, 2) };
  /* ── 가상매매(자체 체결 시뮬레이터) ── */
  const paper = (deps.sbGet && deps.sbWrite)
    ? createPaper({
      now, sbGet: deps.sbGet, sbWrite: deps.sbWrite, getQuote, guard, alert, isOpenDay,
      checkLimits: x => checkLimits(cfg.limits, x), limits: cfg.limits.VIRTUAL, enabled: () => cfg.enabled, authority: hasAuthority,
      fees: { buy: numEnv(env.PAPER_FEE_BUY_PCT, 0), sell: numEnv(env.PAPER_FEE_SELL_PCT, 0) }, ...extOpts,
    })
    : null;
  if (paper && !deps.skipLoop) paper.start();
  /* ── 드라이런 장부(2026-11-19, 실전 탭 자동매매): 가상과 같은 체결 시뮬레이터를 별도 테이블(dry_*)로 하나 더 띄움.
     드라이런 전략의 주문만 여기로 온다 — 가상 전략과 같은 종목을 각자 보유할 수 있게(가상 엔진은 종목당 보유 1개).
     한도는 실전 기준(1회·1일·종목 수)으로 점검하고 수수료·세금도 실전 추정치로 계산해 "실전이었다면"을 가깝게 재현. 사람이 직접 주문하는 화면은 없음 */
  const dry = paper && env.DRYRUN_ENGINE !== '0'
    ? createPaper({
      now, sbGet: deps.sbGet, sbWrite: deps.sbWrite, getQuote, guard, alert, isOpenDay, table: 'dry', label: '드라이런', snaps: false, limitMode: 'REAL',
      checkLimits: x => checkLimits(cfg.limits, x), limits: cfg.limits.REAL, enabled: () => cfg.enabled, authority: hasAuthority,
      fees: { buy: numEnv(env.LIVE_FEE_BUY_PCT, 0.015), sell: numEnv(env.LIVE_FEE_SELL_PCT, 0.215) }, ...extOpts,
    })
    : null;
  if (dry && !deps.skipLoop) dry.start();

  /* ── 실전매매(6단계) — REAL_TRADING_ENABLED=1 과 계좌 환경변수가 있어야 동작. 주문 코드는 kis-order.js 에만 있음 ── */
  const acctRaw = String(env.KIS_ACCOUNT_NO || '').replace(/\s/g, '');
  const account = { cano: acctRaw.split('-')[0], prdt: String(env.KIS_ACCOUNT_PRDT || acctRaw.split('-')[1] || '').trim() };
  const kisOrder = (deps.kisGet && deps.kisPost) ? createKisOrder({ ...guardKis({ kisGet: deps.kisGet, kisPost: deps.kisPost }), account }) : null;
  const live = (paper && kisOrder)
    ? createLive({ now, sbGet: deps.sbGet, sbWrite: deps.sbWrite, getQuote, guard, alert, isOpenDay, kis: kisOrder,
      checkLimits: x => checkLimits(cfg.limits, x), limits: cfg.limits.REAL, enabled: () => cfg.enabled && cfg.realEnabled, authority: hasAuthority, ...extOpts,
      fees: { buy: numEnv(env.LIVE_FEE_BUY_PCT, 0.015), sell: numEnv(env.LIVE_FEE_SELL_PCT, 0.215) } })   // 실전 수수료·세금 추정 %(매도 = 수수료 + 거래세·농특세, 환경변수로 조정)
    : null;
  if (live && !deps.skipLoop) live.start();

  /* ── HTTP ── */
  function cors(req, res) {
    const o = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', (o && allowedOrigins.includes(o)) ? o : (allowedOrigins[0] || ''));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-trade-session, x-device-id, x-device-info, x-active');
    res.setHeader('Vary', 'Origin');
  }
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  function readJson(req, max = 8192) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }
  function rate(ip) {
    const t = now(), a = (ipHits.get(ip) || []).filter(x => t - x < 60000);
    if (a.length >= 120) { ipHits.set(ip, a); return false; }
    a.push(t); ipHits.set(ip, a); return true;
  }
  const statusBody = (a) => ({
    ok: true, now: now(),
    enabled: cfg.enabled, realEnabled: cfg.realEnabled, realOn: cfg.realEnabled && state.realOn, halted: state.halted,
    pinConfigured: !!cfg.pinHash, pinLockedSec: Math.max(0, Math.ceil((state.pinLockUntil - now()) / 1000)),
    session: a.session ? { active: true, ttlSec: sessionTtlSec(a.session) } : { active: false },
    limits: cfg.limits, hours: cfg.hours, accountConfigured: !!(kisOrder && kisOrder.configured()),
  });

  async function finishOpen(req, res, uid, c) {
    sweep();
    const kicked = sessions.size >= cfg.maxSessions;
    const sid = openSession(uid);
    await audit('session_open', true, { flags: c.flags.length ? c.flags : undefined, kicked: kicked || undefined }, req);
    remember(c);
    alert(`${warnText(c)}🔓 거래 세션 열림 · ${kst()}\n${whoText(c)}\n실전 스위치 ${cfg.realEnabled ? 'ON 🔴' : 'OFF'}${cfg.realEnabled ? ' · 사이트 실전 주문 ' + (state.realOn ? 'ON 🔴' : 'OFF') : ''} · 긴급정지 ${state.halted ? 'ON' : '해제'}${kicked ? '\n(기존에 열려 있던 세션은 종료됨)' : ''}\n본인이 아니면 /kill`, '매매 세션');
    return json(res, 200, { ok: true, session: sid, ttlSec: Math.round(cfg.sessionMs / 1000), idleSec: Math.round(cfg.idleMs / 1000) });
  }

  async function run(req, res, path) {
    await ready;
    const ip = clientIp(req);
    if (!rate(ip)) return json(res, 429, { ok: false, error: 'too many requests' });
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !allowedOrigins.includes(origin)) return json(res, 403, { ok: false, error: 'forbidden origin' });

    { const sidH = String(req.headers['x-trade-session'] || ''), ss = sessions.get(sidH);   // 무조작 자동 잠금: 조작(POST 또는 x-active)이 있을 때만 활동으로 침
      if (ss) { const t = now(); if (cfg.idleMs && t - (ss.act || 0) > cfg.idleMs) { sessions.delete(sidH); audit('session_idle_lock', true, {}, req); } else if (req.method !== 'GET' || req.headers['x-active'] === '1') ss.act = t; } }
    const needSession = path === '/trade/resume' || path === '/trade/ping' || path.startsWith('/trade/paper/') || path.startsWith('/trade/live/') || path.startsWith('/trade/auto/');
    // 상태 조회는 세션이 있으면 그 정보도 함께 돌려줌(없어도 통과)
    const a = await authz(req, { session: needSession });
    if (!a.ok) {
      if (a.wrongUser) { if (auditOnce('login_wrong_user', { path }, req)) { const c = classify(req); alert(`🚨 허용되지 않은 계정이 매매 API에 접근했습니다.\n${whoText(c)}`); } }
      else if (a.status === 401 && !needSession) auditOnce('login_invalid', { path }, req);
      return json(res, a.status, { ok: false, error: a.error });
    }
    if (path === '/trade/status' && req.method === 'GET') {
      const sess = getSession(req.headers['x-trade-session'], a.user.id);
      return json(res, 200, statusBody({ session: sess }));
    }
    if (path === '/trade/audit' && req.method === 'GET') {   // 보안 로그 화면용(로그인한 주인만)
      if (!deps.sbGet) return json(res, 503, { ok: false, error: 'audit unavailable' });
      const days = Math.min(90, Math.max(1, +new URL(req.url, 'http://x').searchParams.get('days') || 7));
      try {
        const since = new Date(now() - days * 864e5).toISOString();
        const rows = await deps.sbGet(`trade_audit?select=ts,event,ok,mode,ip,detail&ts=gte.${encodeURIComponent(since)}&event=not.in.(paper_plan,live_plan)&order=ts.desc&limit=800`);
        return json(res, 200, { ok: true, rows, realEnabled: cfg.realEnabled, enabled: cfg.enabled, halted: state.halted, build: BUILD, now: now() });
      } catch (e) { return json(res, 502, { ok: false, error: 'audit read failed' }); }
    }
    if (path === '/trade/quote' && req.method === 'GET') {
      const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
      if (!/^\d{6}$/.test(code)) return json(res, 400, { ok: false, error: 'bad code' });
      try { return json(res, 200, await getQuote(code)); }
      catch (e) { console.warn('[trade] 시세 조회 실패', code, e && e.message); return json(res, 502, { ok: false, error: 'quote unavailable' }); }
    }
    if (path === '/trade/quote-probe' && req.method === 'GET') {   // 시세 출처 점검(8단계): KRX·NXT·통합 응답을 나란히(세션 필요)
      if (!getSession(req.headers['x-trade-session'], a.user.id)) return json(res, 401, { ok: false, error: 'pin required' });
      const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
      if (!/^\d{6}$/.test(code)) return json(res, 400, { ok: false, error: 'bad code' });
      const info = await codeInfo(code), out = { ok: true, code, at: now(), info, session: SES.sessionOf(kstMin(), info), mkts: {} };
      for (const m of ['J', 'NX', 'UN']) {
        try {
          const q = await fetchQuote(code, m);
          out.mkts[m] = { ok: true, price: q.price, vol: q.vol, hour: q.hour, ask1: (q.asks[0] || {}).p || 0, bid1: (q.bids[0] || {}).p || 0,
            askLevels: q.asks.filter(l => l.p > 0).length, bidLevels: q.bids.filter(l => l.p > 0).length, totalAsk: q.totalAsk, totalBid: q.totalBid };
        } catch (e) { out.mkts[m] = { ok: false, error: String(e && e.message).slice(0, 120) }; }
      }
      return json(res, 200, out);
    }
    if (path === '/trade/paper/state' && req.method === 'GET') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const r = await paper.state();
      return json(res, r.ok ? 200 : (r.status || 500), r);
    }
    if (path === '/trade/paper/report' && req.method === 'GET') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const sp = new URL(req.url, 'http://x').searchParams;
      const r = await paper.report(sp.get('from') || null, sp.get('to') || null);
      return json(res, r.ok ? 200 : (r.status || 500), r);
    }
    if (path === '/trade/auto/state' && req.method === 'GET') {   // 자동매매 카드: 설정·오늘 후보·보유·일별 성과 — 세션 필요. ?side=real 이면 실전 탭(드라이런·실전 전략)
      if (!autoRef) return json(res, 503, { ok: false, error: 'auto unavailable' });
      try { const sp = new URL(req.url, 'http://x').searchParams; return json(res, 200, await autoRef.uiState(null, sp.get('side') === 'real' ? 'real' : 'paper')); }
      catch (e) { console.warn('[trade] 자동매매 상태 조회 실패', e && e.message); return json(res, 502, { ok: false, error: 'auto state failed' }); }
    }
    if (path === '/trade/auto/daylog' && req.method === 'GET') {   // 오늘 탭 일지: 목록(가벼운 요약) 또는 하루 상세(?date)
      if (!autoRef || !autoRef.daylogList) return json(res, 503, { ok: false, error: 'auto unavailable' });
      try {
        const sp = new URL(req.url, 'http://x').searchParams;
        const side = sp.get('side') === 'real' ? 'real' : 'paper';
        const r = sp.get('date') ? await autoRef.daylogGet(sp.get('date'), side) : await autoRef.daylogList(sp.get('limit'), side);
        return json(res, r.ok ? 200 : (r.status || 400), r);
      } catch (e) { console.warn('[trade] 일지 조회 실패', e && e.message); return json(res, 502, { ok: false, error: 'daylog read failed' }); }
    }
    if (path === '/trade/auto/journal' && req.method === 'GET') {   // 자동 일지: 목록+성과(?sid&from&to) 또는 하루 상세(?date&sid)
      if (!autoRef || !autoRef.journalList) return json(res, 503, { ok: false, error: 'auto unavailable' });
      try {
        const sp = new URL(req.url, 'http://x').searchParams;
        const eng = ['paper', 'dry', 'live'].includes(sp.get('engine')) ? sp.get('engine') : null, side = ['paper', 'real'].includes(sp.get('side')) ? sp.get('side') : null;
        const r = sp.get('date') ? await autoRef.journalGet(sp.get('date'), sp.get('sid') || null)
          : sp.get('compare') && autoRef.journalCompare ? await autoRef.journalCompare({ sid: sp.get('sid'), src: sp.get('compare'), from: sp.get('from'), to: sp.get('to'), engine: eng })   // 실전 탭 전략 ↔ 가상 원본 비교
            : await autoRef.journalList({ sid: sp.get('sid'), from: sp.get('from'), to: sp.get('to'), limit: sp.get('limit'), side, engine: eng });
        return json(res, r.ok ? 200 : (r.status || 400), r);
      } catch (e) { console.warn('[trade] 일지 조회 실패', e && e.message); return json(res, 502, { ok: false, error: 'journal read failed' }); }
    }
    if ((path === '/trade/auto/strategies' || path === '/trade/auto/strategy-versions' || path === '/trade/auto/strategy-source') && req.method === 'GET') {   // 컨트롤 타워: 전략 목록·스키마 / 버전 이력 / 원본 변경 미리 보기
      if (!autoRef || !autoRef.strategies) return json(res, 503, { ok: false, error: 'auto unavailable' });
      try {
        if (path === '/trade/auto/strategies') return json(res, 200, await autoRef.strategies());
        if (path === '/trade/auto/strategy-source') { const r = await autoRef.sourceDiff(new URL(req.url, 'http://x').searchParams.get('id')); return json(res, r.ok ? 200 : (r.status || 400), r); }
        return json(res, 200, await autoRef.strategyVersions(new URL(req.url, 'http://x').searchParams.get('id')));
      } catch (e) { console.warn('[trade] 전략 조회 실패', e && e.message); return json(res, 502, { ok: false, error: 'strategy read failed' }); }
    }
    if (path.startsWith('/trade/live/') && req.method === 'GET') {
      if (!live) return json(res, 503, { ok: false, error: 'live unavailable' });
      const sp = new URL(req.url, 'http://x').searchParams;
      const r = path === '/trade/live/state' ? await live.state() : path === '/trade/live/report' ? await live.report(sp.get('from') || null, sp.get('to') || null) : path === '/trade/live/probe' ? await live.probe() : path === '/trade/live/account' ? await (async () => { const a = await live.account(); if (a && a.ok && reconRef) a.recon = await reconRef.state().catch(() => null); return a; })() : { ok: false, status: 404, error: 'not found' };
      return json(res, r.ok ? 200 : (r.status || 500), r);
    }
    if (path === '/trade/ping' && req.method === 'GET') {
      return json(res, 200, { ok: true, ttlSec: sessionTtlSec(a.session) });
    }
    if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });

    let body;
    try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: 'bad request' }); }
    if (body && typeof body === 'object') delete body.origin;   // 주문 출처(auto:<전략>)는 서버 안의 자동매매만 붙인다 — 화면에서 온 주문은 항상 직접 주문
    const bad = checkReplay(body);
    if (bad) { auditOnce('replay_reject', { path, reason: bad }, req); return json(res, 400, { ok: false, error: bad }); }
    /* 섞임 방지(2026-11-19): 화면이 보낸 쪽(desk: real·paper)과 주소·전략의 쪽이 다르면 거부. desk 가 없으면(예전 화면) 주소대로 처리 */
    const desk = body && body.desk != null ? String(body.desk) : null;
    if (body && typeof body === 'object') delete body.desk;
    if (desk !== null && desk !== 'real' && desk !== 'paper') return json(res, 400, { ok: false, error: 'bad desk' });
    if (desk) {
      const deskErr = msg => { audit('desk_mismatch', false, { path, desk, why: msg }, req, desk === 'real' ? 'REAL' : 'VIRTUAL'); return json(res, 409, { ok: false, error: msg + ' — 화면을 새로고침하세요' }); };
      if (path.startsWith('/trade/live/') && desk !== 'real') return deskErr('가상매매 화면에서 실전 주문을 보낼 수 없습니다');
      if (path.startsWith('/trade/paper/') && desk !== 'paper') return deskErr('실전매매 화면에서 가상 주문을 보낼 수 없습니다');
      if (path === '/trade/auto/config' && ((desk === 'paper' && body.liveOn !== undefined) || (desk === 'real' && body.on !== undefined))) return deskErr('다른 쪽 자동매매 스위치입니다');
      const sidOfReq = { '/trade/auto/approve': body.strategy, '/trade/auto/eod': body.strategy, '/trade/auto/stage': body.strategy, '/trade/auto/strategy': body.id, '/trade/auto/strategy-source': body.id, '/trade/auto/strategy-delete': body.id, '/trade/auto/journal-memo': body.sid }[path];
      if (sidOfReq != null && autoRef && autoRef.deskOk && !(await autoRef.deskOk(String(sidOfReq), desk).catch(() => false))) return deskErr(desk === 'real' ? '가상 탭 전략은 실전매매 화면에서 다룰 수 없습니다' : '실전 탭 전략은 가상매매 화면에서 다룰 수 없습니다');
      if (path === '/trade/auto/order-edit' && body.engine && ((desk === 'paper') !== (body.engine === 'paper'))) return deskErr('다른 쪽 장부의 자동 주문입니다');
    }

    if (path === '/trade/session') {
      const r = await checkPin(body.pin);
      if (!r.ok) {
        await audit('pin_fail', false, { left: r.left, locked: !!r.locked }, req);
        const c = classify(req);
        if (r.locked) alert(`🚨 거래 PIN을 ${cfg.pinMaxFails}회 틀려 ${Math.round(cfg.pinLockMs / 60000)}분간 잠겼습니다.\n${warnText(c)}${whoText(c)}`);
        else if (r.status === 401) alert(`${warnText(c)}⚠ 거래 PIN 오류 (남은 시도 ${r.left}회)\n${whoText(c)}`);
        return json(res, r.status, { ok: false, error: r.error, ...(r.left != null ? { left: r.left } : {}), ...(r.retrySec ? { retrySec: r.retrySec } : {}) });
      }
      const c = classify(req);
      const kd = c.d.id ? known.devs.get(c.d.id) : null;
      const reasons = [];
      if (cfg.realEnabled) reasons.push('실전 스위치 ON');
      if (!c.d.id) reasons.push('기기 정보 없음'); else if (!kd) reasons.push('등록되지 않은 새 기기');
      if (c.flags.some(f => /집 밖/.test(f))) reasons.push('집 밖 접속');
      if (cfg.approval && deps.notify && reasons.length) {   // 텔레그램 승인 대기
        sweep();
        for (const [k, v] of pending) if (v.uid === a.user.id && v.status === 'wait') pending.delete(k);
        const reqId = crypto.randomBytes(16).toString('hex'), code = String(crypto.randomInt(1000, 10000));
        pending.set(reqId, { uid: a.user.id, code, c, exp: now() + cfg.approvalMs, status: 'wait', devId: c.d.id });
        await audit('session_pending', true, { reasons, flags: c.flags.length ? c.flags : undefined }, req);
        alert(`${warnText(c)}🔐 거래 세션 승인 요청 · ${kst()}\n${whoText(c)}\n사유: ${reasons.join(', ')}\n\n본인이 맞으면  /승인 ${code}\n아니면  /거부 ${code}  (${Math.round(cfg.approvalMs / 60000)}분 안에)`, '매매 세션');
        return json(res, 202, { ok: false, pending: true, reqId, ttlSec: Math.round(cfg.approvalMs / 1000) });
      }
      return finishOpen(req, res, a.user.id, c);
    }
    if (path === '/trade/session/poll') {   // 텔레그램 승인 결과 확인(같은 로그인·같은 기기만)
      const p = pending.get(String(body.reqId || ''));
      if (!p || p.uid !== a.user.id || p.devId !== devOf(req).id) return json(res, 404, { ok: false, error: 'not found' });
      if (p.status === 'wait') {
        if (p.exp <= now()) { pending.delete(String(body.reqId)); audit('session_pending_expired', false, {}, req); return json(res, 403, { ok: false, error: 'expired' }); }
        return json(res, 202, { ok: false, pending: true, leftSec: Math.round((p.exp - now()) / 1000) });
      }
      pending.delete(String(body.reqId));
      if (p.status === 'deny') return json(res, 403, { ok: false, error: 'denied' });
      return finishOpen(req, res, a.user.id, p.c);
    }
    if (path === '/trade/live/switch') {   // 사이트 "실전 주문" 스위치. 켜기 = PIN 필수(+텔레그램 알림·감사 기록), 끄기 = PIN 없이 바로. 환경변수 REAL_TRADING_ENABLED=1 이어야 켤 수 있음
      if (typeof body.on !== 'boolean') return json(res, 400, { ok: false, error: 'bad request' });
      if (!body.on) {
        const r = await setRealOn(false, req, 'site');
        return json(res, 200, { ok: true, realOn: false, saved: r.saved });
      }
      if (!cfg.enabled || !cfg.realEnabled) { audit('real_on_reject', false, { why: 'env' }, req, 'REAL'); return json(res, 409, { ok: false, error: '서버 설정(Render 환경변수 TRADING_ENABLED·REAL_TRADING_ENABLED = 1)이 꺼져 있어 켤 수 없어요' }); }
      if (state.halted) return json(res, 409, { ok: false, error: '긴급 정지 중이에요. 먼저 긴급 정지를 해제하세요' });
      const pr = await checkPin(String(body.pin == null ? '' : body.pin));
      if (!pr.ok) { audit('real_on_pin_fail', false, {}, req, 'REAL'); return json(res, pr.status === 423 ? 423 : 403, { ok: false, needPin: true, error: pr.status === 423 ? `PIN 이 잠겼습니다(${pr.retrySec || ''}초 뒤 다시)` : 'PIN 이 맞지 않습니다' }); }
      const r = await setRealOn(true, req, 'site');
      if (!r.saved) return json(res, 503, { ok: false, error: '켠 기록을 저장하지 못해 켜지 않았어요(감사 기록 사용 불가)' });
      return json(res, 200, { ok: true, realOn: true, saved: true });
    }
    if (path === '/trade/live/order' || path === '/trade/live/cancel' || path === '/trade/live/plan' || path === '/trade/live/modify') {
      if (!live) return json(res, 503, { ok: false, error: 'live unavailable' });
      const kind = path.slice('/trade/live/'.length);
      /* 3단계: 자동매매가 낸 실전 매수 주문도 가상과 똑같이 — 별도 매수는 막고, 정정·취소는 자동매매 기록과 함께 처리 */
      if (kind === 'order' && body.side === 'buy' && autoRef && autoRef.pendingAutoBuy) {
        const pid = await autoRef.pendingAutoBuy(String(body.code || ''), 'live').catch(() => null);
        if (pid) return json(res, 409, { ok: false, error: '이 종목은 자동매매 매수 주문이 체결 대기 중입니다. 별도 주문 대신 "자동 주문 수정"으로 가격·수량을 바꾸거나 취소하세요.' });
      }
      if ((kind === 'modify' || kind === 'cancel') && autoRef && autoRef.autoOrderCode) {
        const ac = await autoRef.autoOrderCode(String(body.id || ''), 'live').catch(() => null);
        if (ac) {
          const r2 = await autoRef.siteOrderEdit(kind === 'cancel' ? { code: ac, engine: 'live', orderId: String(body.id), action: 'cancel' } : { code: ac, engine: 'live', orderId: String(body.id), action: 'modify', price: body.price, qty: body.qty });
          audit('auto_order_edit', !!r2.ok, { code: ac, action: kind, price: body.price, qty: body.qty, error: r2.error }, req, 'REAL');
          return json(res, r2.ok ? 200 : (r2.status || 400), r2.ok ? (kind === 'cancel' ? { ok: true, order: { id: body.id } } : r2) : { ok: false, error: r2.error });
        }
      }
      const r = kind === 'order' ? await live.place(body) : kind === 'cancel' ? await live.cancel(body.id) : kind === 'modify' ? await live.modify(body) : await live.editPlan(body);
      const detail = kind === 'order' ? { code: body.code, side: body.side, type: body.type, price: body.price, qty: body.qty, status: r.order && r.order.status, error: r.error }
        : kind === 'cancel' ? { id: body.id, error: r.error } : kind === 'modify' ? { id: body.id, price: body.price, qty: body.qty, error: r.error } : { code: body.code, stop: body.stop, error: r.error };
      audit(r.ok ? 'live_' + kind : 'live_reject', !!r.ok, detail, req, 'REAL');
      if (r.ok && kind === 'order') alert(`[실전] 주문 ${r.order.status === 'open' ? '접수' : '확인 중'}: ${body.code} ${body.side === 'buy' ? '매수' : '매도'} ${body.qty}주 ${body.type === 'market' ? '시장가' : body.price + '원'}`);
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error, order: r.order });
    }
    if (path === '/trade/auto/approve' || path === '/trade/auto/eod') {   // 사이트 승인(매수/패스) · 15:10 정리(정리/유지) — 텔레그램 명령과 같은 처리
      const fn = path === '/trade/auto/approve' ? 'siteApprove' : 'siteEod';
      if (!autoRef || !autoRef[fn]) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const kinds = path === '/trade/auto/approve' ? ['buy', 'pass'] : ['sell', 'keep'];
      const kind = String(body.kind || ''), nums = Array.isArray(body.nums) ? [...new Set(body.nums.map(Number))] : [];
      if (!kinds.includes(kind)) return json(res, 400, { ok: false, error: 'bad kind' });
      if ((kind === 'buy' || kind === 'sell') && (!nums.length || nums.length > 20 || nums.some(n => !Number.isInteger(n) || n < 1 || n > 20))) return json(res, 400, { ok: false, error: '번호를 골라 주세요' });
      const sid = body.strategy == null ? null : String(body.strategy);
      if (sid && !/^[a-z]+-[a-z0-9]{1,20}$/.test(sid)) return json(res, 400, { ok: false, error: 'bad strategy' });
      const r = await (fn === 'siteApprove' ? autoRef.siteApprove(kind, nums, sid, desk || 'paper') : autoRef.siteEod(kind, nums, sid, body.phase === 'nxt' || body.phase === 'reg' ? body.phase : undefined, desk || 'paper')).catch(e => ({ ok: false, reply: String((e && e.message) || e).slice(0, 200) }));
      audit(path === '/trade/auto/approve' ? 'auto_approve' : 'auto_eod', !!r.ok, { kind, nums, strategy: sid }, req, 'VIRTUAL');
      return json(res, 200, r);
    }
    if (path === '/trade/auto/order-edit') {   // 체결 대기 중인 자동 매수 주문 정정·취소 (주문 화면). 장부(engine)+주문번호(orderId)로만 찾음
      if (!autoRef || !autoRef.siteOrderEdit) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const r = await autoRef.siteOrderEdit(body).catch(e => ({ ok: false, status: 500, error: String((e && e.message) || e).slice(0, 200) }));
      audit('auto_order_edit', !!r.ok, { code: body.code, engine: body.engine, orderId: body.orderId, action: body.action, price: body.price, qty: body.qty, error: r.error }, req, r.real || body.engine === 'live' ? 'REAL' : 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/auto/stage') {   // 단계 버튼: 예정 시각과 무관하게 지금 실행(후보 선정→알림 · 알림 · 종가 판정 · 이월 전환)
      if (!autoRef || !autoRef.siteStage) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const stage = String(body.stage || ''), sid = body.strategy == null ? null : String(body.strategy);
      if (!['select', 'notice', 'judge', 'judgeN', 'convert'].includes(stage)) return json(res, 400, { ok: false, error: 'bad stage' });
      if (!sid || !/^[a-z]+-[a-z0-9]{1,20}$/.test(sid)) return json(res, 400, { ok: false, error: 'bad strategy' });
      const r = await autoRef.siteStage(stage, sid).catch(e => ({ ok: false, reply: String((e && e.message) || e).slice(0, 200) }));
      audit('auto_stage', !!r.ok, { stage, strategy: sid }, req, 'VIRTUAL');
      return json(res, 200, r);
    }
    if (path === '/trade/auto/daylog-memo' || path === '/trade/auto/daylog-save') {   // 일지 메모 저장 · 오늘 일지 지금 저장
      const isMemo = path === '/trade/auto/daylog-memo';
      if (!autoRef || !autoRef.daylogMemo) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const r = await (isMemo ? autoRef.daylogMemo(String(body.date || ''), body.memo) : autoRef.daylogSave(String(body.date || ''))).catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 120) }));
      audit(isMemo ? 'auto_daylog_memo' : 'auto_daylog_save', !!r.ok, { date: body.date, len: isMemo && typeof body.memo === 'string' ? body.memo.length : undefined, error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/auto/journal-memo' || path === '/trade/auto/journal-run') {   // 일지 메모 저장 · 하루치 일지 다시 만들기(텔레그램 없음)
      const isMemo = path === '/trade/auto/journal-memo';
      if (!autoRef || !autoRef.journalMemo) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const r = await (isMemo ? autoRef.journalMemo(String(body.date || ''), String(body.sid || ''), body.memo) : autoRef.journalRun(String(body.date || ''))).catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 200) }));
      audit(isMemo ? 'auto_journal_memo' : 'auto_journal_run', !!r.ok, { date: body.date, sid: body.sid, len: isMemo && typeof body.memo === 'string' ? body.memo.length : undefined, error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/auto/strategy-new' || path === '/trade/auto/strategy-delete') {   // 전략 추가(기본값/복제) · 삭제(보관)
      const isNew = path === '/trade/auto/strategy-new', fn = isNew ? 'createStrategy' : 'deleteStrategy';
      if (!autoRef || !autoRef[fn]) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const arg = isNew ? { kind: body.kind, name: body.name, desc: body.desc, from: body.from, asLive: body.asLive === true } : String(body.id || '');
      const r = await autoRef[fn](arg, 'site').catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 200) }));
      audit(isNew ? 'auto_strategy_new' : 'auto_strategy_delete', !!r.ok, isNew ? { kind: body.kind, from: body.from, id: r.strategy && r.strategy.id, error: r.error } : { id: arg, error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/auto/strategy') {   // 전략 조건값·켜기/끄기·이름 저장(버전 +1, 바뀐 항목 기록). 가상매매 전용
      if (!autoRef || !autoRef.saveStrategy) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const patch = {}; for (const k of ['params', 'enabled', 'name', 'desc']) if (body[k] !== undefined) patch[k] = body[k];
      /* 2단계: 실행 모드를 실전으로 바꿀 때는 거래 PIN 을 한 번 더(틀리면 PIN 실패 횟수에 들어감·잠금 규칙 그대로). 확인은 여기서, 바꿀 수 있는지는 auto 가 판단 */
      let pinOk = false;
      if (body.params && (body.params.execMode === 'live' || body.params.liveAutoOk === true) && body.pin != null) {   // 실전 자동 승인 켜기도 PIN(검토 #14)
        const pr = await checkPin(String(body.pin));
        if (!pr.ok) { audit('auto_exec_mode_pin_fail', false, { id: body.id }, req, 'REAL'); return json(res, pr.status === 423 ? 423 : 403, { ok: false, needPin: true, error: pr.status === 423 ? `PIN 이 잠겼습니다(${pr.retrySec || ''}초 뒤 다시)` : 'PIN 이 맞지 않습니다' }); }
        pinOk = true;
      }
      const r = await autoRef.saveStrategy(body.id, patch, 'site', { confirm: body.confirm === true, pinOk }).catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 200) }));
      const modeCh = (r.changed || []).find(c => c.key === 'execMode');
      if (modeCh) audit('auto_exec_mode', true, { id: body.id, from: modeCh.from, to: modeCh.to }, req, modeCh.to === '실전(실제 계좌로 주문)' ? 'REAL' : 'VIRTUAL');
      audit(r.ok ? 'auto_strategy' : 'auto_strategy_reject', !!r.ok, { id: body.id, version: r.strategy && r.strategy.version, changed: (r.changed || []).map(c => `${c.key}:${c.from}→${c.to}`).slice(0, 20), error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error, errs: r.errs, needConfirm: r.needConfirm || undefined, warnings: r.warnings || undefined, needPin: r.needPin || undefined });
    }
    if (path === '/trade/auto/halt') {   // 2단계 정지 단계: buy(자동매매 신규 매수만 정지) · all(자동매매 전체 정지, 손절·익절 감시는 계속) · none(해제). 긴급 정지는 /trade/kill
      if (!autoRef || !autoRef.setHalt) return json(res, 503, { ok: false, error: 'auto unavailable' });
      const level = String(body.level || '');
      if (!['buy', 'all', 'none'].includes(level)) return json(res, 400, { ok: false, error: 'bad level' });
      const r = await autoRef.setHalt(level === 'none' ? null : level, 'site').catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 200) }));
      audit('auto_halt', !!r.ok, { level }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r);
    }
    if (path === '/trade/auto/config') {   // 자동매매 켜기/끄기(가상 탭 on · 실전 탭 liveOn)·종목당 금액(auto_config 'main'). 실전 탭을 켤 때는 거래 PIN 한 번 더
      if (!autoRef) return json(res, 503, { ok: false, error: 'auto unavailable' });
      let pinOk = false;
      if (body.liveOn === true && body.pin != null) {
        const pr = await checkPin(String(body.pin));
        if (!pr.ok) { audit('auto_live_on_pin_fail', false, {}, req, 'REAL'); return json(res, pr.status === 423 ? 423 : 403, { ok: false, needPin: true, error: pr.status === 423 ? `PIN 이 잠겼습니다(${pr.retrySec || ''}초 뒤 다시)` : 'PIN 이 맞지 않습니다' }); }
        pinOk = true;
      }
      const cfgBody = {}; for (const k of ['on', 'liveOn', 'perStockKrw']) if (body[k] !== undefined) cfgBody[k] = body[k];
      const r = await autoRef.setConfig(cfgBody, { pinOk }).catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 200) }));
      audit(r.ok ? 'auto_config' : 'auto_config_reject', !!r.ok, { on: body.on, liveOn: body.liveOn, perStockKrw: body.perStockKrw, error: r.error }, req, body.liveOn !== undefined ? 'REAL' : 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error, needPin: r.needPin || undefined });
    }
    if (path === '/trade/auto/strategy-source') {   // 원본 변경 반영(POST): 가상 원본의 매수·매도·선정 조건을 실전 탭 전략으로 가져옴. 실전 모드 전략이면 PIN
      if (!autoRef || !autoRef.applySource) return json(res, 503, { ok: false, error: 'auto unavailable' });
      let pinOk = false;
      if (body.pin != null) {
        const pr = await checkPin(String(body.pin));
        if (!pr.ok) { audit('auto_source_pin_fail', false, { id: body.id }, req, 'REAL'); return json(res, pr.status === 423 ? 423 : 403, { ok: false, needPin: true, error: pr.status === 423 ? `PIN 이 잠겼습니다(${pr.retrySec || ''}초 뒤 다시)` : 'PIN 이 맞지 않습니다' }); }
        pinOk = true;
      }
      const r = await autoRef.applySource(String(body.id || ''), 'site', { pinOk, confirm: body.confirm === true }).catch(e => ({ ok: false, status: 502, error: String((e && e.message) || e).slice(0, 200) }));
      audit(r.ok ? 'auto_source_apply' : 'auto_source_reject', !!r.ok, { id: body.id, from: r.from, changed: (r.applied || []).map(c => c.key).slice(0, 30), error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error, errs: r.errs, needPin: r.needPin || undefined, needConfirm: r.needConfirm || undefined, warnings: r.warnings || undefined });
    }
    if (path === '/trade/paper/plan') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const r = await paper.editPlan(body);
      audit(r.ok ? 'paper_plan' : 'paper_reject', r.ok, { path, code: body.code, error: r.error, stop: body.stop, stopPct: body.stopPct, steps: Array.isArray(body.steps) ? body.steps.length : 0 }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/paper/modify') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      { const ac = autoRef && autoRef.autoOrderCode ? await autoRef.autoOrderCode(String(body.id || ''), 'paper').catch(() => null) : null;
        if (ac) { const r2 = await autoRef.siteOrderEdit({ code: ac, engine: 'paper', orderId: String(body.id), action: 'modify', price: body.price, qty: body.qty }); audit('auto_order_edit', !!r2.ok, { code: ac, action: 'modify', price: body.price, qty: body.qty, error: r2.error }, req, 'VIRTUAL'); return json(res, r2.ok ? 200 : (r2.status || 400), r2.ok ? r2 : { ok: false, error: r2.error }); } }
      const r = await paper.modify(body);
      audit(r.ok ? 'paper_modify' : 'paper_reject', !!r.ok, { path, id: body.id, price: body.price, qty: body.qty, error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/paper/order' || path === '/trade/paper/cancel') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const isOrder = path === '/trade/paper/order';
      if (isOrder && body.side === 'buy' && autoRef && autoRef.pendingAutoBuy) {   // 자동 매수가 체결 대기 중인 종목은 별도 매수 대신 그 주문을 정정하게 함
        const pid = await autoRef.pendingAutoBuy(String(body.code || ''), 'paper').catch(() => null);
        if (pid) return json(res, 409, { ok: false, error: '이 종목은 자동매매 매수 주문이 체결 대기 중입니다. 별도 주문 대신 "자동 주문 수정"으로 가격·수량을 바꾸거나 취소하세요.' });
      }
      if (!isOrder && autoRef && autoRef.autoOrderCode) {   // 자동 매수 주문의 취소는 자동매매 기록에도 '직접 취소'로 남김
        const ac = await autoRef.autoOrderCode(String(body.id || ''), 'paper').catch(() => null);
        if (ac) { const r2 = await autoRef.siteOrderEdit({ code: ac, engine: 'paper', orderId: String(body.id), action: 'cancel' }); audit('auto_order_edit', !!r2.ok, { code: ac, action: 'cancel', error: r2.error }, req, 'VIRTUAL'); return json(res, r2.ok ? 200 : (r2.status || 400), r2.ok ? { ok: true, order: { id: body.id } } : { ok: false, error: r2.error }); }
      }
      const r = isOrder ? await paper.place(body, req) : await paper.cancel(body.id);
      if (!r.ok) {
        audit('paper_reject', false, { path, error: r.error, code: body.code, side: body.side, type: body.type, qty: body.qty, price: body.price }, req, 'VIRTUAL');
        return json(res, r.status || 400, { ok: false, error: r.error });
      }
      audit(isOrder ? 'paper_order' : 'paper_cancel', true, isOrder ? { code: r.order.code, side: r.order.side, type: r.order.type, price: r.order.price, qty: r.order.qty, filled: r.order.filled } : { id: r.order.id }, req, 'VIRTUAL');
      return json(res, 200, r);
    }
    if (path === '/trade/lock') {
      sessions.delete(String(req.headers['x-trade-session'] || ''));
      audit('session_close', true, {}, req);
      { const c = classify(req); alert(`🔒 거래 세션 잠금 · ${kst()}\n${whoText(c)}`, '매매 세션'); }
      return json(res, 200, { ok: true });
    }
    if (path === '/trade/kill') {
      state.halted = true; state.haltSetAt = now();
      const saved = await audit('kill', true, {}, req);
      alert(`🛑 긴급 정지: 신규 매수가 막혔습니다. (보유 종목 매도·취소는 가능)\n${whoText(classify(req))}` + (saved ? '' : ' ⚠ 기록 저장 실패 — 서버 재시작 시 Render 의 TRADING_ENABLED=0 으로 막으세요'));
      return json(res, 200, { ok: true, halted: true, saved });
    }
    if (path === '/trade/resume') {
      const saved = await audit('resume', true, {}, req);
      if (!saved) return json(res, 503, { ok: false, error: 'audit unavailable' });   // 해제 기록이 안 남으면 재시작 때 다시 정지되므로 해제하지 않음
      state.halted = false; state.haltSetAt = now();
      alert(`▶ 긴급 정지가 해제되었습니다.\n${whoText(classify(req))}`);
      return json(res, 200, { ok: true, halted: false });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  function handle(req, res) {
    const path = (req.url || '').split('?')[0];
    if (!path.startsWith('/trade/')) return false;
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    run(req, res, path).catch(e => {
      console.error('[trade] 처리 오류:', e && e.message);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'server error' });
    });
    return true;
  }

  if (!cfg.allowedEmail) console.warn('[trade] ALLOWED_EMAIL 미설정 — 매매 API는 모든 요청을 거부합니다.');
  if (!cfg.pinHash) console.warn('[trade] TRADE_PIN_HASH 미설정 — 거래 세션을 열 수 없습니다.');

  /* ── 텔레그램 관리 명령(채팅 ID 확인은 server.js) ── */
  const adminStatus = () => `📊 매매 상태 · ${kst()}\n매매 ${cfg.enabled ? 'ON' : 'OFF'} · 실전 스위치(환경변수) ${cfg.realEnabled ? '🚨 ON' : 'OFF'} · 사이트 실전 주문 ${cfg.realEnabled ? (state.realOn ? '🚨 ON' : 'OFF') : '—'} · 긴급정지 ${state.halted ? 'ON' : '해제'}\n열린 거래 세션 ${[...sessions.values()].filter(x => x.exp > now() && x.abs > now()).length}개 · PIN 잠금 ${state.pinLockUntil > now() ? Math.ceil((state.pinLockUntil - now()) / 60000) + '분 남음' : '없음'}${BUILD ? '\n빌드 ' + BUILD : ''}`;
  async function adminDecide(code, ok) {
    const t = now();
    for (const v of pending.values()) {
      if (v.status === 'wait' && v.exp > t && v.code === String(code).trim()) {
        v.status = ok ? 'ok' : 'deny';
        if (ok) remember(v.c);   // 승인한 기기는 등록 기기가 됨
        await audit(ok ? 'session_approved' : 'session_denied', ok, { via: 'telegram', dev: v.c.d.label }, null);
        return `${ok ? '✅ 승인했어요' : '⛔ 거부했어요'} — ${v.c.d.label} (${v.c.ip})`;
      }
    }
    return '해당 코드의 대기 중인 요청이 없어요 (만료됐거나 이미 처리됨).';
  }
  async function adminLock(via) { const n = sessions.size; sessions.clear(); await audit('session_close_all', true, { via, n }, null); return n; }
  async function adminKill(via) { state.halted = true; state.haltSetAt = now(); return audit('kill', true, { via }, null); }
  /* 사이트 "실전 주문" 스위치 켜기/끄기. 끄기는 먼저 메모리에서 끄고 기록(기록이 실패해도 꺼진 채 — 안전 쪽), 켜기는 기록이 남은 뒤에만 켬 */
  async function setRealOn(on, req, via) {
    const was = state.realOn;
    state.realSetAt = now();
    if (!on) state.realOn = false;
    const saved = await audit(on ? 'real_on' : 'real_off', true, { via }, req || null, 'REAL');
    if (on && saved) state.realOn = true;
    if (on ? saved : was) alert(on ? `🚨 사이트 "실전 주문" 스위치를 켰습니다 — 실전 신규 매수가 가능해집니다.\n${req ? whoText(classify(req)) : '(' + via + ')'}`
      : `⏸ 사이트 "실전 주문" 스위치를 껐습니다 — 실전 신규 매수만 멈춥니다(손절·익절·이월 매도·취소는 계속).\n${req ? whoText(classify(req)) : '(' + via + ')'}${saved ? '' : '\n⚠ 기록 저장 실패 — 서버가 재시작되면 다시 켜질 수 있어요. 켜져 있나 확인하세요(Render 환경변수 REAL_TRADING_ENABLED=0 으로도 막을 수 있어요).'}`);
    return { saved };
  }
  async function securitySummary(hours = 24) {
    const since = new Date(now() - hours * 3600e3).toISOString(), q = encodeURIComponent(since);
    const rows = await deps.sbGet(`trade_audit?select=ts,event,ok,mode,ip,detail&ts=gte.${q}&order=ts.asc&limit=2000`);
    let auth = [];
    try { auth = await deps.sbGet(`auth_audit?select=ts,action,ip&ts=gte.${q}&order=ts.asc&limit=2000`); } catch (_) { auth = null; }
    const cnt = {}, devs = new Map(), ips = new Set(), warn = [];
    for (const r of rows) {
      cnt[r.event] = (cnt[r.event] || 0) + 1;
      const d = r.detail && r.detail.dev;
      if (r.event === 'session_open') { ips.add(r.ip); const k = (d && (d.n || d.m)) || '기기 정보 없음'; devs.set(k, (devs.get(k) || 0) + 1); }
      if (r.detail && r.detail.flags) warn.push(`${String(r.ts).slice(5, 16).replace('T', ' ')} ${r.detail.flags.join('·')}`);
    }
    const fail = (cnt.pin_fail || 0) + (cnt.login_invalid || 0) + (cnt.login_wrong_user || 0) + (cnt.replay_reject || 0);
    const live = Object.keys(cnt).filter(k => k.startsWith('live_')).reduce((a, k) => a + cnt[k], 0);
    const L = [`🛡 보안 요약 (최근 ${hours}시간) · 실전 스위치 ${cfg.realEnabled ? '🚨 ON' : 'OFF'}`,
      `세션 열림 ${cnt.session_open || 0}회 · 기기 ${devs.size ? [...devs].map(([k, v]) => `${k} ${v}`).join(', ') : '없음'}`,
      `접속 IP ${ips.size}개 · 실패/거부 ${fail}건 · 긴급정지 ${cnt.kill || 0}회 · 실전 주문 이벤트 ${live}건`];
    if (auth) { const li = auth.filter(a => a.action === 'login'); L.push(`사이트 로그인 ${li.length}회 · IP ${new Set(li.map(a => a.ip)).size}개${auth.some(a => /password|recover|user_modified/.test(a.action)) ? ' · ⚠ 계정/비밀번호 변경 기록 있음' : ''}`); }
    else L.push('사이트 로그인 기록: 아직 수집 전');
    if (warn.length) L.push('⚠ 경고 ' + warn.slice(-5).join(' / '));
    return L.join('\n');
  }
  let autoRef = null;   // 자동매매는 trade 보다 나중에 만들어지므로 server.js 가 만든 뒤 붙임
  const attachAuto = a => { autoRef = a; };
  let reconRef = null;   // 일일 대사(recon.js) — 계좌 현황 화면에 마지막 결과를 붙임
  const attachRecon = r => { reconRef = r; };
  const ENG = () => [['paper', paper], ['dry', dry], ['live', live]].filter(([, e]) => e);
  const dryInUse = () => { try { return !!(dry && autoRef && autoRef.kindsInUse && autoRef.kindsInUse().includes('dry')); } catch (_) { return !!dry; } };
  return { handle, attachAuto, attachRecon, paper, dry, live, getQuote, adminStatus, adminLock, adminDecide, adminKill, securitySummary,
    realOrdersOn: () => !!(cfg.enabled && cfg.realEnabled && state.realOn), setRealOn, reloadReal,   // 사이트 "실전 주문" 스위치(자동매매가 실전 전략 매수를 건너뛸 때도 봄)
    // 체결 틱 깨우기(2026-11-13): 엔진별 감시선 · 깨우기(판정은 엔진이 REST 시세로)
    watchLines: code => ENG().filter(([, e]) => e.watchLines).map(([k, e]) => { try { return [k, e.watchLines(code)]; } catch (_) { return [k, null]; } }).filter(([, L]) => L),
    kick: (eng, code) => { const e = eng === 'live' ? live : eng === 'dry' ? dry : paper; return e && e.kick ? e.kick(code) : Promise.resolve(false); },
    /* 외부 감시·재시작 복구용(0단계): 엔진별 마지막 점검 시각 / 재시작 뒤 손절 점검을 한 바퀴 마쳤는지 / 권한을 새로 얻었을 때 기록 다시 읽기 */
    engineHealth: () => ({ paper: paper && paper.health ? paper.health() : null, live: live && live.health ? live.health() : null, ...(dry && dry.health ? { dry: dry.health() } : {}) }),
    /* 드라이런 장부는 드라이런 전략이 있을 때만(자동매매가 알려 줌) 재시작 손절 점검 완료를 기다림 */
    sweepReady: () => hasAuthority() && [paper, dryInUse() ? dry : null, live].every(e => !e || !e.health || e.health().swept),
    hasAuthority, reloadEngines: () => { for (const e of [paper, dry, live]) { try { e && e.reload && e.reload(); } catch (_) {} } reloadKill().catch(() => {}); }, reloadKill,
    heldCodes: () => { const s = new Set(); for (const e of [paper, dry, live]) { if (e && e.heldCodes) { try { for (const c of e.heldCodes()) s.add(c); } catch (_) {} } } return s; }, ready: () => ready, authz, guard, checkLimits: (x) => checkLimits(cfg.limits, x), checkReplay, audit, alert, cfg, state, _sessions: sessions };
}

module.exports = { createTrade, hashPin, verifyHash, checkLimits, loadConfig, scrub };
