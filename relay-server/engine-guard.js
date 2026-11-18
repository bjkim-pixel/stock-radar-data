'use strict';
/* 서버 감시 · 주문 권한 (실거래 전환 0단계, 2026-11-18)

   ① createOrderLock — "지금 주문·손절을 내는 인스턴스는 하나뿐"을 Supabase 한 줄(engine_lock)로 보장.
      Render 는 배포할 때 새 인스턴스를 먼저 띄우고 옛 인스턴스를 나중에 끄므로, 잠깐 둘이 같이 돈다.
      그대로 두면 같은 손절·익절 주문이 두 번 나갈 수 있다. 잠금은 30초짜리 임대(lease)이고 5초마다 연장하며,
      종료(SIGTERM) 때 스스로 반납해서 새 인스턴스가 바로 이어받는다. 비정상 종료면 30초 뒤 자동 만료.
      · 테이블이 아직 없으면(DB 설정 전) 잠금 없이 동작(단일 인스턴스 가정) + 알림 1회 — 기존 운영을 멈추지 않는다.
      · 잠금을 일시적으로 못 읽는 네트워크 오류는 임대 만료 시각까지만 권한을 유지한다(그 뒤엔 주문 중단 = 안전 쪽).
   ② evalHealth — 외부 크론(cron-job.org)이 1분마다 부르는 /health/engine 의 판정 규칙(순수 함수). */

const MISSING = /42P01|PGRST205|PGRST204|does not exist|Could not find the table/;
const safeId = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'x';

function createOrderLock(deps = {}) {
  const now = deps.now || Date.now;
  const rest = deps.rest;                                     // (path, method, body, prefer) => rows[] — 없으면 잠금 끔
  const id = safeId(deps.instanceId);
  const name = safeId(deps.name || 'order');
  const ttl = deps.ttlMs || 30000, renewMs = deps.renewMs || 5000, SAFETY = 5000;
  const log = deps.log || (() => {}), notify = deps.notify || (() => {});
  let mode = rest ? 'init' : 'disabled';                      // init(첫 확인 전) · ok · unavailable(테이블 없음) · disabled
  let heldUntil = 0, otherHolder = null, lastErr = null, lastAttemptAt = 0, timer = null, busy = false, warned = false, acquiredAt = 0, errs = 0, lostWarned = false;
  const strict = () => { try { return !!(deps.strict && deps.strict()); } catch (_) { return true; } };   // 실전 스위치가 켜져 있으면 잠금 테이블 없이 주문하지 않음(검토 #12)

  const held = () => now() < heldUntil;
  function hasAuthority() { return mode === 'disabled' ? true : mode === 'unavailable' ? !strict() : held(); }

  async function attempt() {
    if (!rest || busy) return;
    busy = true;
    const t0 = now();
    lastAttemptAt = t0;
    try {
      const nowIso = new Date(t0).toISOString(), exp = new Date(t0 + ttl).toISOString();
      const filter = `engine_lock?name=eq.${name}&or=(holder.eq.${id},expires_at.lt.${encodeURIComponent(nowIso)})`;
      let rows = await rest(filter, 'PATCH', { holder: id, expires_at: exp, beat_at: nowIso }, 'return=representation');
      if (!rows || !rows.length) rows = await rest('engine_lock', 'POST', [{ name, holder: id, expires_at: exp, beat_at: nowIso }], 'resolution=ignore-duplicates,return=representation');
      const wasHeld = mode === 'ok' && held();
      if (mode === 'unavailable') { mode = 'ok'; warned = false; }
      mode = 'ok'; lastErr = null; errs = 0;
      if (lostWarned) { lostWarned = false; notify('✅ 주문 권한 잠금 갱신이 다시 됩니다.'); }
      if (rows && rows.length) {
        heldUntil = t0 + ttl - SAFETY; otherHolder = null;
        if (!wasHeld) { acquiredAt = t0; log(`[주문권한] 획득 (${id})`); try { deps.onAcquire && deps.onAcquire(); } catch (e) { log('[주문권한] onAcquire 오류: ' + e.message); } }
      } else {
        heldUntil = 0;
        try { const r = await rest(`engine_lock?name=eq.${name}&select=holder,expires_at`, 'GET'); otherHolder = r && r[0] ? r[0].holder : null; } catch (_) { otherHolder = null; }
        if (wasHeld) { log(`[주문권한] 잃음 → ${otherHolder}`); notify('주문 권한을 다른 인스턴스에 넘겼습니다(배포·교체). 이 인스턴스는 주문·손절을 내지 않습니다.'); try { deps.onLose && deps.onLose(); } catch (_) {} }
      }
    } catch (e) {
      const msg = String(e && e.message || e);
      if (MISSING.test(msg)) {
        mode = 'unavailable'; lastErr = '잠금 테이블 없음';
        if (!warned) { warned = true; log('[주문권한] engine_lock 테이블 없음 — 잠금 없이 동작(단일 인스턴스 가정)'); notify('⚠ 주문 권한 잠금 테이블(engine_lock)이 없습니다. [수시] DB 테이블·뷰 생성 → engine_lock 을 실행해 주세요. 그 전까지는 배포 중 두 인스턴스가 동시에 주문할 수 있습니다.'); }
      } else {
        lastErr = msg.slice(0, 160);   // 네트워크 오류: 임대 만료 시각까지는 권한 유지, 그 뒤엔 자동으로 false
        log('[주문권한] 갱신 실패: ' + lastErr);
        errs++;
        if (!held() && errs >= 2 && !lostWarned) { lostWarned = true; notify(`🚨 주문 권한 잠금을 갱신하지 못해(${lastErr.slice(0, 60)}) 이 서버가 주문·손절 감시를 멈췄습니다. 보유 종목은 한국투자증권 앱에서 확인하세요.`); }   // 검토 #6
      }
    } finally { busy = false; }
  }

  function start() {
    if (!rest || timer) return;
    attempt();
    timer = setInterval(() => { attempt(); }, renewMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  /* 종료 직전 반납 — 새 인스턴스가 만료를 기다리지 않고 바로 이어받게 함 */
  async function release() {
    stop();
    const was = held(); heldUntil = 0;
    if (!rest || mode !== 'ok' || !was) return false;
    try { await rest(`engine_lock?name=eq.${name}&holder=eq.${id}`, 'PATCH', { expires_at: new Date(now() - 1000).toISOString() }, 'return=minimal'); return true; }
    catch (_) { return false; }
  }
  const status = () => ({ mode, held: hasAuthority(), holder: mode === 'ok' && held() ? id : otherHolder, me: id, lastErr, heldForSec: held() && acquiredAt ? Math.round((now() - acquiredAt) / 1000) : null, lastAttemptAt: lastAttemptAt || null });
  return { start, stop, attempt, release, hasAuthority, status };
}

/* ── /health/engine 판정 ──
   입력: now(ms) · min(KST 분) · tradingDay · bootAt · engines {paper, live} 각 { enabled, lastTick, closedToday } · token {ok} · held(보유·미체결 종목 수) · authority(status())
   규칙: 거래일 08:00~20:00 에만 감시 루프를 요구한다(07:50~08:00 은 깨우기용 'pre', 그 밖은 'closed' = 정상).
         켜진 엔진의 마지막 점검이 staleMs(기본 60초)보다 오래됐거나 시작 후 한 번도 없으면 실패.
         다른 인스턴스가 주문 권한을 쥐고 있으면 'standby'(정상) — 이 인스턴스가 감시 못 하는 게 아니다.
         보유 종목이 있는데 KIS 토큰이 없거나 만료면 실패(손절 시세를 못 받는다). */
function evalHealth(i) {
  const staleMs = i.staleMs || 60000, graceMs = i.graceMs || 90000;
  const act = !!i.tradingDay && i.min >= 480 && i.min < 1200;
  const pre = !!i.tradingDay && i.min >= 470 && i.min < 480;
  const phase = act ? 'active' : pre ? 'pre' : 'closed';
  const reasons = [];
  const auth = i.authority || { mode: 'disabled', held: true };
  const out = { phase, reasons, uptimeSec: Math.round((i.now - i.bootAt) / 1000) };
  const eng = {};
  for (const [k, label] of [['paper', '가상매매'], ['live', '실전매매']]) {
    const e = i.engines && i.engines[k]; if (!e) continue;
    const age = e.lastTick ? i.now - e.lastTick : null;
    eng[k] = { enabled: !!e.enabled, lastTickAgeSec: age == null ? null : Math.round(age / 1000), closedToday: !!e.closedToday };
    if (!act || !e.enabled || e.closedToday || !auth.held) continue;
    if (age == null) reasons.push(`${label} 감시 루프가 시작 후 아직 한 번도 돌지 않았습니다`);
    else if (age > staleMs) reasons.push(`${label} 감시 루프가 ${Math.round(age / 1000)}초째 멈춰 있습니다`);
  }
  out.engines = eng;
  out.authority = { mode: auth.mode, held: !!auth.held, holder: auth.holder || null };
  out.token = { ok: !!(i.token && i.token.ok) };
  out.held = i.held || 0;
  if (act && auth.held && out.held > 0 && !out.token.ok) reasons.push(`KIS 접속 토큰이 없거나 만료 — 보유·미체결 ${out.held}종목의 시세를 못 받을 수 있습니다`);
  if (auth.mode === 'unavailable') out.warning = auth.held ? '주문 권한 잠금 테이블이 없어 잠금 없이 동작 중' : '주문 권한 잠금 테이블이 없어 실전 주문을 멈춤';
  /* 검토 #6: 주문 권한을 아무도 확실히 쥐고 있지 않으면(잠금 갱신 오류·보유자 모름·테이블 없음+실전) 장중엔 실패 — "대기(standby)"로 덮지 않음 */
  if (act && !auth.held && (auth.lastErr || !auth.holder || auth.mode === 'unavailable')) reasons.push(`주문 권한을 가진 서버가 확인되지 않습니다${auth.lastErr ? ' — ' + String(auth.lastErr).slice(0, 80) : auth.mode === 'unavailable' ? ' — engine_lock 테이블 없음' : ''}`);
  if (reasons.length) { out.ok = false; out.status = (act && out.uptimeSec * 1000 < graceMs) ? 'warming' : 'down'; }
  else { out.ok = true; out.status = !auth.held ? 'standby' : act ? 'ok' : 'idle'; }
  return out;
}

module.exports = { createOrderLock, evalHealth, MISSING };
