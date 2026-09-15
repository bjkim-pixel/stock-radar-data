-- ============================================================================
-- 71_kis_token_cache.sql — KIS 접근토큰 공유 캐시 (2026-09-15)
--
-- 왜 필요한가
--   KIS는 접근토큰 발급을 **앱키당 1분에 1회**로 제한합니다(공식 문서 명시).
--   그동안은 GitHub Actions 워크플로 5개가 각자 실행할 때마다 새로 발급받고,
--   릴레이 서버(Render)도 재시작할 때마다 따로 발급받아서 하루 20회 이상
--   발급이 일어났습니다. 스케줄이 같은 분에 겹치면 한쪽이 403 EGW00133으로
--   막힙니다(실제로 nxt_collect ↔ intraday_collect가 하루 4회 겹쳤음).
--
--   토큰 자체는 24시간 유효하므로, 한 곳에 저장해 두고 모두가 나눠 쓰면
--   발급은 하루 1~2회면 충분합니다.
--
-- ⚠ 보안 — 반드시 읽어주세요
--   access_token은 이 계좌의 KIS API를 호출할 수 있는 자격증명입니다.
--   웹 프론트엔드가 쓰는 anon 키로는 **절대** 읽히면 안 됩니다.
--   아래처럼 RLS를 켜고 정책을 하나도 만들지 않으면 anon·authenticated는
--   전부 거부되고, service_role만 RLS를 우회해 접근합니다.
--   (service_role 키는 GitHub Actions secrets와 Render 환경변수에만 있습니다.)
--
-- 실행 방법: Supabase 대시보드 → SQL Editor에 붙여넣고 Run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kis_token (
  -- 앱키가 여러 개가 될 수도 있으니 키 이름으로 행을 구분합니다.
  -- 현재는 'default' 한 행만 씁니다.
  key_name    text        PRIMARY KEY,
  access_token text       NOT NULL,
  expires_at  timestamptz NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  issued_by   text,                    -- 누가 발급했는지 (디버깅용: 'github-actions', 'relay-server')
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  kis_token IS 'KIS 접근토큰 공유 캐시 — 앱키당 1분 1회 발급 제한 회피용. service_role 전용.';
COMMENT ON COLUMN kis_token.expires_at IS 'KIS가 준 expires_in을 발급 시각에 더한 값. 소비자는 만료 30분 전부터 재발급을 시도한다.';

-- RLS: 켜기만 하고 정책은 만들지 않는다 → anon/authenticated 전면 차단,
-- service_role만 접근(service_role은 RLS를 우회함).
ALTER TABLE kis_token ENABLE ROW LEVEL SECURITY;

-- 혹시 이전에 만들어 둔 정책이 있으면 제거 (재실행 안전)
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'kis_token'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.kis_token', p.policyname);
  END LOOP;
END $$;

-- PostgREST가 anon에게 테이블 자체를 노출하지 않도록 권한도 회수합니다
-- (RLS와 별개인 이중 잠금 — RLS 설정을 실수로 풀어도 여전히 막힙니다).
REVOKE ALL ON TABLE kis_token FROM anon, authenticated;

-- 확인용
SELECT 'kis_token 생성 완료 — RLS 활성, 정책 0개(service_role 전용)' AS result;
