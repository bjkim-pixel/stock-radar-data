'use strict';
/* 자동매매 보강 E2-2(2026-11-16): 이벤트 날 표시 — 후보 종목의 실적·IR 공시, 오늘·내일 시장 일정(만기일·FOMC 등).
   표시만 한다: 매수에서 제외하거나 금액을 바꾸지 않는다(결정: 실적 발표 종목은 표시만).
   데이터는 market_events(169 — DART 수집 + 규칙 계산 + 수동 파일). 테이블이 없거나 읽기 실패면 빈 목록 */

const KIND_KO = { earnings: '실적', ir: 'IR', expiry: '만기일', index: '지수 변경', fomc: 'FOMC', other: '일정' };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

/* date 기준 [-back, +fwd]일 이벤트 읽기 */
async function loadEvents(sbGet, date, back = 3, fwd = 8) {
  try {
    const r = await sbGet(`market_events?select=event_date,kind,code,name,title,detail&event_date=gte.${addDays(date, -back)}&event_date=lte.${addDays(date, fwd)}&order=event_date.asc&limit=600`);
    return Array.isArray(r) ? r : [];
  } catch (_) { return []; }
}

const dayWord = (ev, date) => { const d = Math.round((Date.parse(ev + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400e3); return d === 0 ? '오늘' : d === -1 ? '어제' : d === 1 ? '내일' : d < 0 ? `${-d}일 전` : `${d}일 뒤`; };

/* 종목 배지: 오늘·어제(장 마감 뒤 공시는 다음 날 아침에 보임) 올라온 실적·IR 공시 */
function stockBadges(events, code, date) {
  const prev = addDays(date, -1), out = [];
  for (const e of events || []) {
    if (e.code !== code || (e.kind !== 'earnings' && e.kind !== 'ir')) continue;
    if (e.event_date !== date && e.event_date !== prev) continue;
    out.push(`${e.kind === 'earnings' ? '실적 공시' : 'IR 공시'}(${dayWord(e.event_date, date)})`);
  }
  return [...new Set(out)];
}

/* 시장 일정: 오늘·내일(주말이 끼면 다음 거래일까지는 호출하는 쪽이 fwd 로 조절) */
function marketNotes(events, date, fwd = 1) {
  const end = addDays(date, fwd), out = [];
  for (const e of events || []) {
    if (e.code) continue;
    if (e.event_date < date || e.event_date > end) continue;
    out.push({ date: e.event_date, kind: e.kind, title: e.title, text: `${dayWord(e.event_date, date)} ${e.title}` });
  }
  return out;
}

/* 이번 주(앞으로 days일) 시장 일정 — 시황 화면·요약용 */
function upcoming(events, date, days = 7) {
  const end = addDays(date, days);
  return (events || []).filter(e => !e.code && e.event_date >= date && e.event_date <= end).map(e => ({ date: e.event_date, kind: e.kind, title: e.title, detail: e.detail || null, when: dayWord(e.event_date, date) }));
}

/* 텔레그램 한 줄 */
function marketLine(notes) {
  return notes && notes.length ? `📅 ${notes.map(n => n.text).join(' · ')} — 변동이 커질 수 있어요(표시만)` : null;
}

module.exports = { KIND_KO, loadEvents, stockBadges, marketNotes, upcoming, marketLine, addDays };
