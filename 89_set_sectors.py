# -*- coding: utf-8 -*-
"""업종 일괄 지정 — 미분류 종목에 업종을 한 번에 넣습니다 (sector_override 테이블, 28_sector_override.sql 참고).
입력(환경변수 ENTRIES): "종목=업종; 종목=업종 ..." (종목은 6자리 코드 또는 종목명, 구분자는 ; 또는 줄바꿈, 이름과 업종 사이는 = 또는 , 또는 :)
  예) 엑시콘=반도체; 지투지바이오=제약; 419530=오락·문화
입력이 비어 있으면 '목록 모드' — 지금 미분류인 종목과 쓸 수 있는 업종 이름만 보여줍니다(DB 변경 없음).
DRY_RUN=true(기본)면 검증·미리보기만 하고 저장하지 않습니다. false여야 실제로 저장.
sector_krx 원본은 건드리지 않고 sector_override만 씁니다(화면·업종 RS가 override를 우선 사용)."""
import os, re, sys, difflib, datetime, psycopg2

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
ENTRIES = os.environ.get("ENTRIES", "")
DRY = os.environ.get("DRY_RUN", "true").strip().lower() != "false"
lines = []
def log(m=""):
    print(m, flush=True); lines.append(m)

def parse_entries(text):
    out = []
    for raw in re.split(r"[;\n]+", text or ""):
        raw = raw.split("#")[0].strip()
        if not raw:
            continue
        parts = re.split(r"\s*[=,:\t]\s*", raw, maxsplit=1)
        if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
            out.append((raw, None)); continue
        out.append((parts[0].strip(), parts[1].strip()))
    return out

def main():
    if not DB_URL:
        raise SystemExit("SUPABASE_DB_URL 미설정")
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute("select distinct sector from v_stock_sector where sector is not null order by 1")
    sectors = [r[0] for r in cur.fetchall()]
    cur.execute("""select s.code, s.name, s.market from stocks s join v_stock_sector v on v.code = s.code
                   where s.security_type = 'STOCK' and v.sector is null order by s.name""")
    unclassified = cur.fetchall()
    entries = parse_entries(ENTRIES)

    log(f"# 업종 일괄 지정 ({datetime.datetime.now():%Y-%m-%d %H:%M} UTC) — {'미리보기(저장 안 함)' if DRY else '저장 모드'}")
    log(f"\n## 지금 미분류 종목 {len(unclassified)}개")
    for c, n, m in unclassified:
        log(f"- {n} ({c}, {m})")
    if not entries:
        log("\n## 쓸 수 있는 업종 이름 (정확히 이 이름으로 입력)\n" + " · ".join(sectors))
        log("\n입력(entries)이 비어 있어 목록만 표시했습니다.")
        return finish(conn)

    ok, bad = [], []
    for ident, sec in entries:
        if sec is None:
            bad.append(f"'{ident}' — '종목=업종' 형식이 아닙니다"); continue
        if re.fullmatch(r"\d{6}", ident):
            cur.execute("select code, name from stocks where code = %s and security_type = 'STOCK'", (ident,))
        else:
            cur.execute("select code, name from stocks where name = %s and security_type = 'STOCK'", (ident,))
        rows = cur.fetchall()
        if not rows:
            near = difflib.get_close_matches(ident, [n for _, n, _ in unclassified], n=3)
            bad.append(f"'{ident}' — 종목을 찾지 못했습니다" + (f" (비슷한 이름: {', '.join(near)})" if near else "")); continue
        if len(rows) > 1:
            bad.append(f"'{ident}' — 이름이 같은 종목이 여러 개입니다({', '.join(c for c, _ in rows)}) — 6자리 코드로 입력하세요"); continue
        if sec not in sectors:
            near = difflib.get_close_matches(sec, sectors, n=3, cutoff=0.4)
            bad.append(f"'{ident}' → 업종 '{sec}' 는 없는 이름입니다" + (f" (비슷한 업종: {', '.join(near)})" if near else "") + " — 목록 모드로 정확한 이름을 확인하세요"); continue
        ok.append((rows[0][0], rows[0][1], sec))

    log(f"\n## 검증 결과 — 저장 대상 {len(ok)}건 / 문제 {len(bad)}건")
    for c, n, sec in ok:
        log(f"- ✅ {n} ({c}) → {sec}")
    for b in bad:
        log(f"- ❌ {b}")
    if bad:
        log("\n문제가 있는 입력이 있어 아무것도 저장하지 않았습니다. 위 ❌를 고쳐 다시 실행하세요.")
        finish(conn); raise SystemExit(1)
    if DRY:
        log("\n미리보기입니다. 저장하려면 dry_run을 끄고(false) 같은 입력으로 다시 실행하세요.")
        return finish(conn)
    note = f"액션 일괄 지정 {datetime.date.today()}"
    for c, n, sec in ok:
        cur.execute("""insert into sector_override (code, sector_override, note) values (%s, %s, %s)
                       on conflict (code) do update set sector_override = excluded.sector_override, note = excluded.note""", (c, sec, note))
    conn.commit()
    log(f"\n✅ {len(ok)}건 저장 완료. 화면에는 바로 반영되고, 업종 RS 순위는 다음 수집·계산 실행부터 반영됩니다.")
    finish(conn)

def finish(conn):
    conn.close()
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        open(path, "a", encoding="utf-8").write("\n".join(lines) + "\n")

if __name__ == "__main__":
    main()
