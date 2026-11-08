# -*- coding: utf-8 -*-
"""v_stock_flow_periods 속도 개선 적용 — 새 정의를 임시 뷰로 만들어 기존 뷰와 결과가 완전히 같고 더 빠를 때만 교체.
결과가 하나라도 다르면 아무것도 바꾸지 않고 롤백."""
import os,re,time,psycopg2
sql=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"129_flow_periods_fast.sql"),encoding="utf-8").read()
body=sql[sql.index("create or replace view v_stock_flow_periods"):]
body=body[body.index(" as\n")+4:].rstrip().rstrip(";")
conn=psycopg2.connect(os.environ["SUPABASE_DB_URL"]); conn.autocommit=False; cur=conn.cursor()
rep=["# v_stock_flow_periods 속도 개선"]
def tm(q):
    t=time.time(); cur.execute(q); r=cur.fetchall(); return (time.time()-t)*1000,r
try:
    cur.execute("create temporary view tmp_sfp_new as "+body)
    # 컬럼 이름·순서·타입 동일?
    cur.execute("select attname, format_type(atttypid,atttypmod) from pg_attribute where attrelid='v_stock_flow_periods'::regclass and attnum>0 and not attisdropped order by attnum"); a=cur.fetchall()
    cur.execute("select attname, format_type(atttypid,atttypmod) from pg_attribute where attrelid='tmp_sfp_new'::regclass and attnum>0 and not attisdropped order by attnum"); b=cur.fetchall()
    rep.append(f"- 컬럼 수: 기존 {len(a)} / 새 {len(b)} / 동일 {a==b}")
    t_old,r_old=tm("select * from v_stock_flow_periods")
    t_new,r_new=tm("select * from tmp_sfp_new")
    _,d1=tm("select count(*) from (select * from v_stock_flow_periods except all select * from tmp_sfp_new) x")
    _,d2=tm("select count(*) from (select * from tmp_sfp_new except all select * from v_stock_flow_periods) x")
    _,o1=tm("select count(*) from (select * from v_stock_flow_periods where code='000660' except all select * from tmp_sfp_new where code='000660') x")
    t1o,_=tm("select * from v_stock_flow_periods where code='000660'"); t1n,_=tm("select * from tmp_sfp_new where code='000660'")
    rep+= [f"- 행수: 기존 {len(r_old)} / 새 {len(r_new)}", f"- 결과 차이: 기존-새 {d1[0][0]}행, 새-기존 {d2[0][0]}행, 1종목 {o1[0][0]}행",
           f"- 전체 조회: 기존 {t_old:.0f}ms → 새 {t_new:.0f}ms", f"- 1종목 조회: 기존 {t1o:.0f}ms → 새 {t1n:.0f}ms"]
    ok = a==b and len(r_old)==len(r_new) and d1[0][0]==0 and d2[0][0]==0 and o1[0][0]==0 and len(r_old)>0 and t_new<t_old
    cur.execute("drop view tmp_sfp_new")
    if ok:
        cur.execute(sql); conn.commit()
        t2,_=tm("select * from v_stock_flow_periods"); conn.rollback()
        rep.append(f"- ✅ 적용 완료 (적용 후 전체 조회 {t2:.0f}ms)")
    else:
        conn.rollback(); rep.append("- ❌ 결과가 다르거나 빨라지지 않아 적용하지 않음(변경 없음)")
except Exception as e:
    conn.rollback(); rep.append(f"- ❌ 오류로 롤백(변경 없음): {e}")
open("flow_periods_fast_report.md","w",encoding="utf-8").write("\n".join(rep)+"\n"); print("\n".join(rep))
