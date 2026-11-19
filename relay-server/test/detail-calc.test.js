const fs=require('fs'),assert=require('assert');
const html=fs.readFileSync(require('path').join(__dirname,'../../web/index.html'),'utf8');
const src=html.slice(html.indexOf('/*DET-CALC-START*/'),html.indexOf('/*DET-CALC-END*/'));assert.ok(src.length>400,'calc block');
const m=new Function(src+';return {DET_PER,DET_PER_DEF,detPeriodStart,detDayNet,detWtTop};')();
const t=(n,f)=>{try{f();console.log('PASS',n);}catch(e){console.log('FAIL',n,e.message);process.exitCode=1;}};
// 거래일 N개짜리 가짜 이력: 날짜는 2026-01-01부터 1일씩(주말 무관), 종가 100씩 증가
const mk=(n,fn)=>Array.from({length:n},(_,i)=>{const d=new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);
  const base={trade_date:d,close:1000+i*10,volume:1000,trade_amount:1000*(1000+i*10),market_cap:1e12,weight_per_share:0,
    foreign_cum:0,inst_cum:0,fin_inv_cum:0,inv_trust_cum:0,pension_cum:0,pe_cum:0,corp_other_cum:0,individual_cum:0};
  return Object.assign(base,fn?fn(i):{});});

t('기본 기간은 6개월(126)',()=>{assert.equal(m.DET_PER_DEF,'126');assert.deepEqual(m.DET_PER.map(x=>x[0]),['21','63','126','all']);});
t('기간 시작일: 최근 N거래일, 전체는 첫날, 이력 부족하면 첫날',()=>{
  const r=mk(200);
  assert.equal(m.detPeriodStart(r,'21'),r[179].trade_date);
  assert.equal(m.detPeriodStart(r,'63'),r[137].trade_date);
  assert.equal(m.detPeriodStart(r,'126'),r[74].trade_date);
  assert.equal(m.detPeriodStart(r,'all'),r[0].trade_date);
  const s=mk(30);assert.equal(m.detPeriodStart(s,'126'),s[0].trade_date);
  assert.equal(m.detPeriodStart([],'126'),null);
});
t('일별 순매수 = 누적 전일 차이, 기타기관 = 기관 − 세부',()=>{
  const r=mk(3,i=>({foreign_cum:i*100,inst_cum:i*50,fin_inv_cum:i*10,inv_trust_cum:i*5,pension_cum:i*3,pe_cum:i*2,individual_cum:-i*150}));
  const d=m.detDayNet(r,2);
  assert.equal(d['외국인'],100);assert.equal(d['기관합계'],50);assert.equal(d['외+기 합계'],150);
  assert.equal(d['기타기관'],50-10-5-3-2);assert.equal(d['개인'],-150);
  assert.equal(m.detDayNet(r,0),null);
});
t('무게 1·2위일: 구간 안 양수만, 큰 순서',()=>{
  const w=[0,0.01,0.05,-0.2,0.03,0.04,0.02];
  const r=mk(7,i=>({weight_per_share:w[i],foreign_cum:i*1e8,inst_cum:i*5e7}));
  const top=m.detWtTop(r,r[0].trade_date,r[6].trade_date,2);
  assert.equal(top.length,2);assert.equal(top[0].i,2);assert.equal(top[1].i,5);
  assert.equal(top[0].rank,1);assert.ok(Math.abs(top[0].w-5)<1e-9);
  // 기간을 좁히면 구간 밖 날짜는 빠진다(2번째 날 제외 → 1위가 5번 날)
  const t2=m.detWtTop(r,r[3].trade_date,r[6].trade_date,2);
  assert.deepEqual(t2.map(x=>x.i),[5,6]);
  // 2위는 1위일 '이후' 날짜 중 가장 큰 날 — 1위가 앞쪽이면 뒤쪽 최대, 1위가 마지막이면 2위 없음
  const w2=[0.04,0.09,0.01,0.03,0.02];const r2=mk(5,i=>({weight_per_share:w2[i],foreign_cum:i*1e8,inst_cum:i*5e7}));
  assert.deepEqual(m.detWtTop(r2,r2[0].trade_date,r2[4].trade_date,2).map(x=>x.i),[1,3]);
  const w3=[0.04,0.01,0.09];const r3=mk(3,i=>({weight_per_share:w3[i],foreign_cum:i*1e8,inst_cum:i*5e7}));
  assert.deepEqual(m.detWtTop(r3,r3[0].trade_date,r3[2].trade_date,2).map(x=>x.i),[2]);
  assert.equal(m.detWtTop(r,'2099-01-01','2099-12-31',2).length,0);
});
t('주체별 평균 단가 = 순매수대금 ÷ (순매수대금×거래량÷거래대금) = 거래대금÷거래량',()=>{
  const r=mk(4,i=>({weight_per_share:i===2?0.05:0,volume:2000,trade_amount:2000*1234,foreign_cum:i*6e9,inst_cum:i*4e9,individual_cum:-i*1e10}));
  const x=m.detWtTop(r,r[0].trade_date,r[3].trade_date,1)[0];
  assert.equal(x.i,2);assert.equal(x.amt,2000*1234);assert.equal(x.vwap,1234);
  const fi=x.subj.find(s=>s.nm==='외+기 합계'),fo=x.subj.find(s=>s.nm==='외국인');
  assert.equal(fi.net,1e10);assert.ok(Math.abs(fi.sh-1e10*2000/(2000*1234))<1e-6);
  assert.ok(Math.abs(fi.avg-1234)<1e-6);assert.ok(Math.abs(fo.avg-1234)<1e-6);
  assert.ok(Math.abs(fi.pct-1e10/(2000*1234)*100)<1e-6);
});
t('순매도 주체는 평균단가 없음(null), 거래대금 0이면 주식수·단가 없음',()=>{
  const r=mk(3,i=>({weight_per_share:i===2?0.05:0,foreign_cum:i*1e9,inst_cum:i*1e9,individual_cum:-i*5e9}));
  const x=m.detWtTop(r,r[0].trade_date,r[2].trade_date,1)[0],ind=x.subj.find(s=>s.nm==='개인');
  assert.ok(ind.net<0);assert.equal(ind.avg,null);
  const z=mk(3,i=>({weight_per_share:i===2?0.05:0,trade_amount:0,foreign_cum:i*1e9}));
  const y=m.detWtTop(z,z[0].trade_date,z[2].trade_date,1)[0];
  assert.equal(y.vwap,null);assert.equal(y.amt,null);assert.ok(y.subj.every(s=>s.sh==null&&s.avg==null));
});
t('첫 행이 1위여도(전일 없음) 죽지 않는다',()=>{
  const r=mk(3,i=>({weight_per_share:i===0?0.09:0}));
  const x=m.detWtTop(r,r[0].trade_date,r[2].trade_date,1)[0];
  assert.equal(x.i,0);assert.deepEqual(x.subj,[]);
});
