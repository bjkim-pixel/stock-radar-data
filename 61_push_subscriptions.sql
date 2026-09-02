-- ============================================================================
-- STOCK RADAR · PWA 웹푸시 구독 저장용 테이블
-- ============================================================================
-- 배경: 사이트를 PWA(홈화면 설치형 웹앱)로 만들면서, 지금까지 텔레그램으로만
-- 보내던 알림(신고가/신저가, 트레일링 손절, 목표가 도달, 오늘의 종목 요약)을
-- 앱 푸시로도 동시에 받을 수 있게 합니다. relay-server(Render)가 브라우저의
-- 푸시 구독 정보(endpoint + 공개키)를 이 테이블에 저장해두고, 알림이 발생할
-- 때마다 web-push로 발송합니다.
--
-- 조회/쓰기 모두 이 테이블은 공개할 필요가 없는 내부 데이터라 anon 권한을
-- 아예 주지 않습니다 — relay-server가 service_role 키로만 읽고 씁니다
-- (alert_targets 테이블과 동일한 패턴).
--
-- ⚠ 실행: Supabase SQL Editor에 붙여넣기 1회 실행.
-- ============================================================================

create table if not exists push_subscriptions (
  endpoint   text primary key,       -- 브라우저가 발급하는 구독 고유 URL
  p256dh     text not null,          -- 구독 공개키
  auth       text not null,          -- 구독 인증 시크릿
  created_at timestamptz not null default now()
);

comment on table push_subscriptions is
  'PWA 웹푸시 구독 정보. relay-server(Render)가 service_role 키로만 읽고 씀 — anon 접근 불가.';

alter table push_subscriptions enable row level security;
-- select/insert/update/delete 정책을 하나도 만들지 않음 = anon/authenticated는 완전히 접근 불가.
-- relay-server는 SUPABASE_SERVICE_KEY(service_role)로 RLS를 우회해서 읽고 씁니다.
