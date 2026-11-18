-- 주문 출처(2026-11-18, 실거래 전환 1단계): 자동매매가 낸 주문에 'auto:<전략ID>' 를 남긴다(사람이 낸 주문은 비움).
-- 같은 실제 계좌 안에서 직접 주문과 자동매매 주문을 구분하고, 대사(3단계)에서 전략별로 맞춰 보는 데 쓴다.
-- 컬럼이 없어도 릴레이 서버는 그냥 기록 없이 동작한다(opt-col.js). 여러 번 실행해도 안전.
alter table public.paper_orders add column if not exists origin text;
alter table public.live_orders  add column if not exists origin text;
notify pgrst, 'reload schema';
