#!/usr/bin/env python3
"""
72_kis_token.py — KIS 접근토큰을 "공유 캐시에서 가져오거나, 없으면 발급해서 저장"

KIS는 접근토큰 발급을 앱키당 1분 1회로 제한합니다. 워크플로마다 매번 새로
발급받으면 스케줄이 겹치는 순간 한쪽이 403 EGW00133으로 막힙니다. 토큰은
24시간 유효하므로 Supabase의 kis_token 테이블에 넣어 두고 모두가 나눠 씁니다.

동작
  1) kis_token 행을 **행 잠금(SELECT ... FOR UPDATE)** 으로 읽는다.
     → 같은 순간에 두 러너가 들어와도 한 명씩 차례로 통과한다.
  2) 남은 유효시간이 TOKEN_MIN_REMAIN_SEC 이상이면 그대로 돌려준다.
     (두 번째 러너는 첫 번째가 방금 저장한 토큰을 그대로 받게 된다 = 발급 0회)
  3) 아니면 KIS에 발급 요청 → 저장 → 돌려준다.

출력: 토큰 문자열 한 줄을 stdout으로 출력합니다. 로그는 전부 stderr로 갑니다
      (워크플로에서 `TOKEN=$(python 72_kis_token.py)` 로 받기 위함).

사용 전 준비: 71_kis_token_cache.sql 을 Supabase SQL Editor에서 실행하세요.
              테이블이 없으면 이 스크립트는 캐시를 포기하고 직접 발급합니다
              (= 기존 동작과 동일 — 마이그레이션 전에도 깨지지 않습니다).

환경변수: KIS_APP_KEY, KIS_APP_SECRET, SUPABASE_DB_URL
선택    : KIS_TOKEN_ISSUER (로그용 이름, 기본 'github-actions')
"""
import os
import sys
import time
import datetime

import requests

KIS_BASE = "https://openapi.koreainvestment.com:9443"
KEY_NAME = "default"

# 남은 유효시간이 이보다 짧으면 새로 발급한다. 수집 한 번이 10분 안쪽이므로
# 30분이면 "쓰는 도중에 만료"될 일이 없다.
TOKEN_MIN_REMAIN_SEC = 30 * 60

APP_KEY    = os.environ.get("KIS_APP_KEY", "")
APP_SECRET = os.environ.get("KIS_APP_SECRET", "")
DB_URL     = os.environ.get("SUPABASE_DB_URL", "")
ISSUER     = os.environ.get("KIS_TOKEN_ISSUER", "github-actions")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def issue_from_kis():
    """KIS에서 새 토큰 발급. (token, expires_in) 반환."""
    last_err = ""
    for attempt in range(1, 4):
        try:
            r = requests.post(
                f"{KIS_BASE}/oauth2/tokenP",
                json={"grant_type": "client_credentials",
                      "appkey": APP_KEY, "appsecret": APP_SECRET},
                headers={"content-type": "application/json"},
                timeout=(8, 20),
            )
            j = r.json()
            tok = j.get("access_token")
            if tok:
                return tok, int(j.get("expires_in") or 86400)
            last_err = f"{r.status_code} {str(j)[:200]}"
            # EGW00133 = "1분 1회" 제한. 다른 소비자가 방금 발급받았다는 뜻이므로
            # 조금 기다렸다가 다시 시도하면 대개 통과한다.
            wait = 65 if "EGW00133" in str(j) else 5
            log(f"  토큰 발급 재시도 {attempt}/3 — {wait}초 후: {last_err}")
            time.sleep(wait)
        except Exception as ex:                       # noqa: BLE001
            last_err = str(ex)[:200]
            log(f"  토큰 발급 재시도 {attempt}/3 — 5초 후: {last_err}")
            time.sleep(5)
    raise SystemExit(f"❌ KIS 토큰 발급 실패: {last_err}")


def get_token_cached():
    """공유 캐시에서 토큰을 얻거나 발급해서 저장한 뒤 토큰 문자열을 반환.

    다른 파이썬 스크립트에서 `import 72_kis_token` 후 직접 호출할 수 있게
    분리해 둔 함수입니다(04_backfill.py 등). 실패 시 예외 대신 직접 발급으로
    폴백하므로, 이 함수는 토큰을 반환하거나 SystemExit을 던집니다.
    """
    if not APP_KEY or not APP_SECRET:
        raise SystemExit("❌ KIS_APP_KEY / KIS_APP_SECRET 미설정")

    if not DB_URL:
        log("⚠ SUPABASE_DB_URL 미설정 — 공유 캐시 없이 직접 발급합니다")
        return issue_from_kis()[0]

    try:
        import psycopg2
    except ImportError:
        log("⚠ psycopg2 미설치 — 공유 캐시 없이 직접 발급합니다")
        return issue_from_kis()[0]

    conn = None
    try:
        conn = psycopg2.connect(DB_URL)
        conn.autocommit = False
        with conn.cursor() as cur:
            # 행 잠금으로 동시 접근을 직렬화한다. 행이 없으면 잠글 것도 없으므로
            # 아래 UPSERT가 경합을 해결한다(ON CONFLICT).
            cur.execute(
                "SELECT access_token, expires_at FROM kis_token "
                "WHERE key_name = %s FOR UPDATE", (KEY_NAME,))
            row = cur.fetchone()
            now = datetime.datetime.now(datetime.timezone.utc)
            if row:
                token, expires_at = row
                remain = (expires_at - now).total_seconds()
                if token and remain >= TOKEN_MIN_REMAIN_SEC:
                    log(f"✅ 공유 캐시 재사용 (남은 유효시간 {remain/3600:.1f}시간) — 발급 안 함")
                    conn.rollback()
                    return token
                log(f"↻ 캐시 토큰 만료 임박/만료 (남은 {remain/60:.0f}분) — 새로 발급")
            else:
                log("↻ 캐시 비어 있음 — 새로 발급")

            tok, expires_in = issue_from_kis()
            expires_at = now + datetime.timedelta(seconds=expires_in)
            cur.execute("""
                INSERT INTO kis_token (key_name, access_token, expires_at, issued_at, issued_by, updated_at)
                VALUES (%s, %s, %s, %s, %s, now())
                ON CONFLICT (key_name) DO UPDATE SET
                  access_token = EXCLUDED.access_token,
                  expires_at   = EXCLUDED.expires_at,
                  issued_at    = EXCLUDED.issued_at,
                  issued_by    = EXCLUDED.issued_by,
                  updated_at   = now()
            """, (KEY_NAME, tok, expires_at, now, ISSUER))
        conn.commit()
        log(f"✅ 새 토큰 발급 + 공유 캐시 저장 (유효 {expires_in/3600:.0f}시간)")
        return tok
    except Exception as ex:                           # noqa: BLE001
        # 테이블이 아직 없거나(마이그레이션 전) DB가 일시적으로 막혀도
        # 수집 자체는 굴러가야 하므로 캐시를 포기하고 직접 발급한다.
        if conn:
            try:
                conn.rollback()
            except Exception:                         # noqa: BLE001
                pass
        log(f"⚠ 공유 캐시 사용 실패({str(ex)[:150]}) — 캐시 없이 직접 발급합니다")
        return issue_from_kis()[0]
    finally:
        if conn:
            try:
                conn.close()
            except Exception:                         # noqa: BLE001
                pass


if __name__ == "__main__":
    # 워크플로에서 `TOKEN=$(python 72_kis_token.py)` 로 받기 위해
    # 토큰만 stdout으로, 나머지 로그는 전부 stderr로 내보낸다.
    print(get_token_cached())
