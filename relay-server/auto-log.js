'use strict';
/* 자동매매 진행 기록(F1, 2026-11-16) — auto_runs.payload.log 에 단계별 사건을 시각순으로 쌓는다(화면 '진행 기록'·일지 복기용).
   payload.events 는 시장 일정(E2)이 쓰고 있어 이름을 log 로 한다. 한 실행당 최대 300건(오래된 것부터 버림) */
const MAX = 300;
function push(payload, k, text, extra, t) {
  if (!payload) return;
  payload.log = Array.isArray(payload.log) ? payload.log : [];
  payload.log.push({ t: new Date(t || Date.now()).toISOString(), k, text, ...(extra || {}) });
  if (payload.log.length > MAX) payload.log.splice(0, payload.log.length - MAX);
}
const sellReason = r => /^tp[1-5]$/.test(String(r || '')) ? `익절 ${String(r).slice(2)}단계` : r === 'stop' ? '손절' : r === 'manual' ? '매도(정리·직접)' : (r || '매도');
const PICK_KO = { q1: '매수 호가 10단계 중 잔량이 가장 많은 가격', bid1: '최우선 매수 호가', ask1: '최우선 매도 호가 기준 시장가', low: '가장 낮은 매수 호가', cur: '현재가(호가 없음)' };
const MODE_KO = { normal: '위쪽 매물대를 뚫을 수 있는 데까지 오른 뒤, 그 위 가장 큰 매물대 바로 아래', blocked: '바로 위 매물대가 커서 그 매물대 바로 아래', 'no-supply': '위쪽 매물대가 없어 손익비(손절폭×배수)와 전고점 중 높은 값' };
const modeKo = m => MODE_KO[m] || (/-none$/.test(String(m || '')) ? '목표가를 정하지 못함(익절 계획 없음)' : String(m || '–'));
module.exports = { MAX, push, sellReason, PICK_KO, modeKo };
