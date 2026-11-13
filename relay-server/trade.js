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
    sessionMaxMs: numEnv(env.TRADE_SESSION_MAX_HOURS, 4) * 3600000,
    maxSessions: 3,
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

  const state = { halted: false, pinFails: 0, pinLockUntil: 0 };
  const sessions = new Map();     // sid -> { uid, exp, abs }
  const nonces = new Map();       // nonce -> 만료시각
  const userCache = new Map();    // sha(token) -> { res, exp }
  const ipHits = new Map();       // ip -> [ts...]
  const auditThrottle = new Map();
  let pinChain = Promise.resolve();   // PIN 검사를 한 줄로 세워 동시 시도로 횟수 제한을 우회하지 못하게 함

  const sweep = () => {
    const t = now();
    for (const [k, v] of sessions) if (v.exp <= t || v.abs <= t) sessions.delete(k);
    for (const [k, v] of nonces) if (v <= t) nonces.delete(k);
    for (const [k, v] of userCache) if (v.exp <= t) userCache.delete(k);
    for (const [k, v] of ipHits) { const a = v.filter(x => t - x < 60000); if (a.length) ipHits.set(k, a); else ipHits.delete(k); }
    for (const [k, v] of auditThrottle) if (t - v > 60000) auditThrottle.delete(k);
  };
  const timer = setInterval(sweep, 60000); if (timer.unref) timer.unref();

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
    const row = { event, ok: !!ok, mode: mode || null, ip: req ? clientIp(req) : null, ua: req ? String(req.headers['user-agent'] || '').slice(0, 200) : null, detail: scrub(detail) };
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
        return;
      } catch (e) {
        lastErr = e;
        if (/42P01|PGRST205|does not exist/.test(String(e.message))) return;   // 감사 테이블 없음 = 아직 설정 전
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    state.halted = true;
    console.warn('[trade] 재시작 복구 실패 — 안전을 위해 신규 매수 정지로 시작:', lastErr && lastErr.message);
    alert('서버 재시작 후 매매 상태를 읽지 못해 신규 매수를 정지했습니다. 확인 후 해제하세요.');
  }
  if (deps.sbGet && !deps.skipRestore) ready = restore();
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
    sessions.set(sid, { uid, exp: t + cfg.sessionMs, abs: t + cfg.sessionMaxMs });
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

  /* ── 주문 전 점검(3단계 이후 주문 코드가 호출) ── */
  const inHours = () => {
    const d = new Date(now() + 9 * 3600e3), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return m >= cfg.hours[0] && m < cfg.hours[1];
  };
  /* kind: 'buy' | 'sell' | 'cancel'. 긴급 정지·시간대는 신규 매수에만 적용(보유 종목 매도·취소는 정지 중에도 허용) */
  function guard(kind, mode) {
    if (!cfg.enabled) return { ok: false, error: 'trading disabled' };
    if (mode === 'REAL' && !cfg.realEnabled) return { ok: false, error: 'real trading disabled' };
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
  function getQuote(code) {
    const t = now(), c = quoteCache.get(code);
    if (c && c.p) return c.p;                               // 같은 종목 동시 요청은 한 번만
    if (c && t - c.t < 1500 && c.v && c.v.sMin === kstMin()) return Promise.resolve(c.v);   // 1.5초 캐시(분이 바뀌면 세션이 바뀔 수 있어 새로)
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
      checkLimits: x => checkLimits(cfg.limits, x), limits: cfg.limits.VIRTUAL, enabled: () => cfg.enabled,
      fees: { buy: numEnv(env.PAPER_FEE_BUY_PCT, 0), sell: numEnv(env.PAPER_FEE_SELL_PCT, 0) }, ...extOpts,
    })
    : null;
  if (paper && !deps.skipLoop) paper.start();

  /* ── 실전매매(6단계) — REAL_TRADING_ENABLED=1 과 계좌 환경변수가 있어야 동작. 주문 코드는 kis-order.js 에만 있음 ── */
  const acctRaw = String(env.KIS_ACCOUNT_NO || '').replace(/\s/g, '');
  const account = { cano: acctRaw.split('-')[0], prdt: String(env.KIS_ACCOUNT_PRDT || acctRaw.split('-')[1] || '').trim() };
  const kisOrder = (deps.kisGet && deps.kisPost) ? createKisOrder({ kisGet: deps.kisGet, kisPost: deps.kisPost, account }) : null;
  const live = (paper && kisOrder)
    ? createLive({ now, sbGet: deps.sbGet, sbWrite: deps.sbWrite, getQuote, guard, alert, isOpenDay, kis: kisOrder,
      checkLimits: x => checkLimits(cfg.limits, x), limits: cfg.limits.REAL, enabled: () => cfg.enabled && cfg.realEnabled, ...extOpts })
    : null;
  if (live && !deps.skipLoop) live.start();

  /* ── HTTP ── */
  function cors(req, res) {
    const o = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', (o && allowedOrigins.includes(o)) ? o : (allowedOrigins[0] || ''));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-trade-session');
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
    enabled: cfg.enabled, realEnabled: cfg.realEnabled, halted: state.halted,
    pinConfigured: !!cfg.pinHash, pinLockedSec: Math.max(0, Math.ceil((state.pinLockUntil - now()) / 1000)),
    session: a.session ? { active: true, ttlSec: sessionTtlSec(a.session) } : { active: false },
    limits: cfg.limits, hours: cfg.hours, accountConfigured: !!(kisOrder && kisOrder.configured()),
  });

  async function run(req, res, path) {
    await ready;
    const ip = clientIp(req);
    if (!rate(ip)) return json(res, 429, { ok: false, error: 'too many requests' });
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !allowedOrigins.includes(origin)) return json(res, 403, { ok: false, error: 'forbidden origin' });

    const needSession = path === '/trade/resume' || path === '/trade/ping' || path.startsWith('/trade/paper/') || path.startsWith('/trade/live/');
    // 상태 조회는 세션이 있으면 그 정보도 함께 돌려줌(없어도 통과)
    const a = await authz(req, { session: needSession });
    if (!a.ok) {
      if (a.wrongUser) { if (auditOnce('login_wrong_user', { path }, req)) alert('허용되지 않은 계정이 매매 API에 접근했습니다.'); }
      else if (a.status === 401 && !needSession) auditOnce('login_invalid', { path }, req);
      return json(res, a.status, { ok: false, error: a.error });
    }
    if (path === '/trade/status' && req.method === 'GET') {
      const sess = getSession(req.headers['x-trade-session'], a.user.id);
      return json(res, 200, statusBody({ session: sess }));
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
    if (path.startsWith('/trade/live/') && req.method === 'GET') {
      if (!live) return json(res, 503, { ok: false, error: 'live unavailable' });
      const sp = new URL(req.url, 'http://x').searchParams;
      const r = path === '/trade/live/state' ? await live.state() : path === '/trade/live/report' ? await live.report(sp.get('from') || null, sp.get('to') || null) : path === '/trade/live/probe' ? await live.probe() : { ok: false, status: 404, error: 'not found' };
      return json(res, r.ok ? 200 : (r.status || 500), r);
    }
    if (path === '/trade/ping' && req.method === 'GET') {
      return json(res, 200, { ok: true, ttlSec: sessionTtlSec(a.session) });
    }
    if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });

    let body;
    try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: 'bad request' }); }
    const bad = checkReplay(body);
    if (bad) { auditOnce('replay_reject', { path, reason: bad }, req); return json(res, 400, { ok: false, error: bad }); }

    if (path === '/trade/session') {
      const r = await checkPin(body.pin);
      if (!r.ok) {
        await audit('pin_fail', false, { left: r.left, locked: !!r.locked }, req);
        if (r.locked) alert(`거래 PIN을 ${cfg.pinMaxFails}회 틀려 ${Math.round(cfg.pinLockMs / 60000)}분간 잠겼습니다.`);
        else if (r.status === 401) alert(`거래 PIN 오류 (남은 시도 ${r.left}회)`);
        return json(res, r.status, { ok: false, error: r.error, ...(r.left != null ? { left: r.left } : {}), ...(r.retrySec ? { retrySec: r.retrySec } : {}) });
      }
      const sid = openSession(a.user.id);
      await audit('session_open', true, {}, req);
      alert('거래 세션이 열렸습니다. 본인이 아니면 긴급 정지를 누르세요.', '매매 세션');
      return json(res, 200, { ok: true, session: sid, ttlSec: Math.round(cfg.sessionMs / 1000) });
    }
    if (path === '/trade/live/order' || path === '/trade/live/cancel' || path === '/trade/live/plan' || path === '/trade/live/modify') {
      if (!live) return json(res, 503, { ok: false, error: 'live unavailable' });
      const kind = path.slice('/trade/live/'.length);
      const r = kind === 'order' ? await live.place(body) : kind === 'cancel' ? await live.cancel(body.id) : kind === 'modify' ? await live.modify(body) : await live.editPlan(body);
      const detail = kind === 'order' ? { code: body.code, side: body.side, type: body.type, price: body.price, qty: body.qty, status: r.order && r.order.status, error: r.error }
        : kind === 'cancel' ? { id: body.id, error: r.error } : kind === 'modify' ? { id: body.id, price: body.price, qty: body.qty, error: r.error } : { code: body.code, stop: body.stop, error: r.error };
      audit(r.ok ? 'live_' + kind : 'live_reject', !!r.ok, detail, req, 'REAL');
      if (r.ok && kind === 'order') alert(`[실전] 주문 ${r.order.status === 'open' ? '접수' : '확인 중'}: ${body.code} ${body.side === 'buy' ? '매수' : '매도'} ${body.qty}주 ${body.type === 'market' ? '시장가' : body.price + '원'}`);
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error, order: r.order });
    }
    if (path === '/trade/paper/plan') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const r = await paper.editPlan(body);
      audit(r.ok ? 'paper_plan' : 'paper_reject', r.ok, { path, code: body.code, error: r.error, stop: body.stop, stopPct: body.stopPct, steps: Array.isArray(body.steps) ? body.steps.length : 0 }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/paper/modify') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const r = await paper.modify(body);
      audit(r.ok ? 'paper_modify' : 'paper_reject', !!r.ok, { path, id: body.id, price: body.price, qty: body.qty, error: r.error }, req, 'VIRTUAL');
      return json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { ok: false, error: r.error });
    }
    if (path === '/trade/paper/order' || path === '/trade/paper/cancel') {
      if (!paper) return json(res, 503, { ok: false, error: 'paper unavailable' });
      const isOrder = path === '/trade/paper/order';
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
      return json(res, 200, { ok: true });
    }
    if (path === '/trade/kill') {
      state.halted = true;
      const saved = await audit('kill', true, {}, req);
      alert('긴급 정지: 신규 매수가 막혔습니다. (보유 종목 매도·취소는 가능)' + (saved ? '' : ' ⚠ 기록 저장 실패 — 서버 재시작 시 Render 의 TRADING_ENABLED=0 으로 막으세요'));
      return json(res, 200, { ok: true, halted: true, saved });
    }
    if (path === '/trade/resume') {
      const saved = await audit('resume', true, {}, req);
      if (!saved) return json(res, 503, { ok: false, error: 'audit unavailable' });   // 해제 기록이 안 남으면 재시작 때 다시 정지되므로 해제하지 않음
      state.halted = false;
      alert('긴급 정지가 해제되었습니다.');
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

  return { handle, paper, live, getQuote, heldCodes: () => { const s = new Set(); for (const e of [paper, live]) { if (e && e.heldCodes) { try { for (const c of e.heldCodes()) s.add(c); } catch (_) {} } } return s; }, ready: () => ready, authz, guard, checkLimits: (x) => checkLimits(cfg.limits, x), checkReplay, audit, alert, cfg, state, _sessions: sessions };
}

module.exports = { createTrade, hashPin, verifyHash, checkLimits, loadConfig, scrub };
