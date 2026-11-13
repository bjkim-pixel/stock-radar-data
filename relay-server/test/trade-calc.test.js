const fs=require('fs'),assert=require('assert');
const html=fs.readFileSync(require('path').join(__dirname,'../../web/index.html'),'utf8');const src=html.slice(html.indexOf('/*TRD-CALC-START*/'),html.indexOf('/*TRD-CALC-END*/'));assert.ok(src.length>200,'calc block');
const N=(v)=>String(v);
const m=new Function('N',src+';return {trdTick,trdFloor,trdCeil,trdBelow,trdRecBids,trdTarget,trdStopRefs,trdStopPrice,trdPlan,trdCalc,trdCheckOrder};')(N);
const t=(n,f)=>{try{f();console.log('PASS',n);}catch(e){console.log('FAIL',n,e.message);process.exitCode=1;}};
t('호가단위',()=>{[[1999,1],[2000,5],[4999,5],[5000,10],[19999,10],[20000,50],[49999,50],[50000,100],[199999,100],[200000,500],[499999,500],[500000,1000]].forEach(([p,e])=>assert.equal(m.trdTick(p),e,p));});
t('floor/ceil',()=>{assert.equal(m.trdFloor(52345),52300);assert.equal(m.trdCeil(52345),52400);assert.equal(m.trdFloor(206700),206500);assert.equal(m.trdFloor(206500),206500);assert.equal(m.trdFloor(19999),19990);});
t('below',()=>{assert.equal(m.trdBelow(50000),49950);assert.equal(m.trdBelow(2000),1999);assert.equal(m.trdBelow(96500),96400);assert.equal(m.trdBelow(96450),96400);assert.equal(m.trdBelow(200000),199900);assert.equal(m.trdBelow(500000),499500);});
t('추천 매수가',()=>{
  const bids=[{p:85000,q:560},{p:84900,q:720},{p:84800,q:980},{p:84700,q:3120},{p:84500,q:1480},{p:84000,q:100}];
  const r=m.trdRecBids(bids,85000);assert.deepEqual(r.map(x=>x.k),['q1','q2','low']);assert.equal(r[0].p,84700);assert.equal(r[1].p,84500);assert.equal(r[2].p,84000);
  assert.equal(r[0].amt,84700*3120);assert.ok(Math.abs(r[0].dist-(84700/85000-1)*100)<1e-9);
  const tie=m.trdRecBids([{p:100,q:5},{p:90,q:5},{p:80,q:1}],100);assert.equal(tie[0].p,100);assert.equal(tie[1].p,90);   // 잔량 같으면 높은 가격 우선
  assert.deepEqual(m.trdRecBids([{p:0,q:0}],100),[]);
});
const prof=(...a)=>a.map(([lo,hi,v])=>({lo,hi,v}));   // 높은 가격대부터가 정상이지만 함수가 정렬함
t('목표가 정상',()=>{
  // 현재 85,000. 위: 86000~88500 52억, 88500~91000 66억, 91000~94000 77억, 94000~96500 41억, 96500~99000 212억, 99000~101500 58억
  const p=prof([99000,101500,58],[96500,99000,212],[94000,96500,41],[91000,94000,77],[88500,91000,66],[86000,88500,52],[80000,86000,300]);
  const r=m.trdTarget({cur:85000,prof:p,capEok:145});   // 52+66=118 ≤145, +77=195>145 → 돌파 가능 91,000까지
  assert.equal(r.mode,'normal');assert.equal(r.cum,118);assert.equal(r.reach,91000);assert.equal(r.top.lo,96500);assert.equal(r.target,96400);
});
t('목표가 계수',()=>{
  const p=prof([96500,99000,212],[91000,94000,77],[86000,88500,52]);
  const r1=m.trdTarget({cur:85000,prof:p,capEok:100,coef:1});const r2=m.trdTarget({cur:85000,prof:p,capEok:100,coef:2});
  assert.equal(r1.reach,88500);assert.equal(r2.reach,94000);
});
t('목표가 대체: 첫 매물대부터 여력 초과',()=>{
  const p=prof([86000,88500,500],[88500,91000,10]);
  const r=m.trdTarget({cur:85000,prof:p,capEok:50});assert.equal(r.mode,'blocked');assert.equal(r.target,85900);   // 86,000 바로 아래(100원 단위)
});
t('목표가 대체: 위쪽 매물대 없음→손익비 1:3(손절 5% × 3 = +15%), 전고점이 더 높으면 전고점',()=>{
  const r=m.trdTarget({cur:85000,prof:prof([86000,88500,0],[80000,85000,50]),capEok:10,prevHigh:92345});assert.equal(r.mode,'no-supply');assert.equal(r.target,97700);   // 85,000 × 1.15 = 97,750 → 호가 내림
  assert.ok(r.top.rr&&r.top.stopPct===5&&r.top.rrN===3);
  const r2=m.trdTarget({cur:85000,prof:[],capEok:10,prevHigh:80000});assert.equal(r2.target,97700);
  const r3=m.trdTarget({cur:85000,prof:[],capEok:10,prevHigh:120000});assert.equal(r3.target,120000);   // 전고점이 더 높으면 전고점
  const r4=m.trdTarget({cur:68800,prof:[],capEok:10,prevHigh:69700,stopPct:5,rr:3});assert.equal(r4.target,79100);   // 삼성E&A 예: 68,800 신고가
  const r5=m.trdTarget({cur:68800,prof:[],capEok:10,prevHigh:69700,stopPct:4,rr:3});assert.equal(r5.target,77000);
  const r6=m.trdTarget({cur:68800,prof:[],capEok:10,prevHigh:69700,upper:75000});assert.equal(r6.target,75000);   // 상한가 제한
});
t('목표가: 상한가 제한·현재가 이하는 없음',()=>{
  const r=m.trdTarget({cur:85000,prof:prof([96500,99000,10]),capEok:1000,prevHigh:120000,upper:110500});assert.equal(r.mode,'no-supply');assert.equal(r.target,110500);
  const r2=m.trdTarget({cur:85000,prof:prof([85000,85100,50]),capEok:1});assert.equal(r2.target,null);assert.ok(/none/.test(r2.mode));
});
t('손절',()=>{
  assert.equal(m.trdStopPrice(50000,5),47500);assert.equal(m.trdStopPrice(84700,5),80400);assert.equal(m.trdStopPrice(10000,5),9500);
  const rows=[{close:50,low:48},{close:51,low:49},{close:52,low:0},{close:49,low:47.5},{close:50,low:49}];
  const r=m.trdStopRefs(rows,50);assert.equal(r.avg,50);assert.equal(r.low,47.5);assert.ok(Math.abs(r.lowPct+5)<1e-9);
});
t('익절 5단계(예시: 50,000→60,000, 100주)',()=>{
  const r=m.trdPlan(50000,60000,100);assert.deepEqual(r.steps.map(s=>s.p),[52000,54000,56000,58000,60000]);assert.deepEqual(r.steps.map(s=>s.q),[20,20,20,20,20]);assert.equal(r.note,'');
});
t('익절 1단계는 최소 +3%: 68,800 → 79,100',()=>{
  const r=m.trdPlan(68800,79100,10);assert.equal(r.steps[0].p,70900);assert.ok(r.steps[0].p>=68800*1.03);assert.equal(r.steps.at(-1).p,79100);
  assert.ok(r.steps.every((x,i)=>!i||x.p>r.steps[i-1].p));assert.ok(/최소 \+3%/.test(r.note));
  const lo=m.trdPlan(10350,11000,10);assert.ok(lo.steps[0].p>=10350*1.03);assert.equal(lo.steps.at(-1).p,11000);   // 단계 간격이 좁아도 1단계 하한
  const near=m.trdPlan(10000,10200,10);assert.equal(near.steps[0].p,10040);   // 목표가가 +3% 미만이면 하한을 못 씀 → 기존 등분
});
t('익절: 나머지 수량은 마지막 단계, 5주 미만은 단계 축소',()=>{
  const r=m.trdPlan(50000,60000,103);assert.deepEqual(r.steps.map(s=>s.q),[20,20,20,20,23]);
  const r2=m.trdPlan(50000,60000,3);assert.equal(r2.n,5);assert.deepEqual(r2.steps.map(s=>s.q),[1,1,1,0,0]);assert.ok(/1주씩/.test(r2.note));   // 낮은 단계부터 1주씩
  assert.equal(m.trdPlan(50000,50000,10).n,0);assert.equal(m.trdPlan(50000,60000,0).n,0);
  const r3=m.trdPlan(1000,1002,5,5,0);assert.ok(/같은 단계/.test(r3.note));   // 1원 단위: 1000.8→1000
});
t('익절 가격은 호가 단위 내림',()=>{const r=m.trdPlan(84700,96400,5);r.steps.forEach(s=>assert.equal(s.p,m.trdFloor(s.p)));assert.equal(r.steps.at(-1).p,96400);assert.equal(r.steps.reduce((a,s)=>a+s.q,0),5);});
t('손익 계산',()=>{
  const pl=m.trdPlan(50000,60000,100),c=m.trdCalc({buy:50000,qty:100,stop:47500,steps:pl.steps});
  assert.equal(c.buyAmt,5000000);assert.equal(c.loss,-250000);assert.equal(Math.round(c.lossPct*10)/10,-5);
  assert.equal(c.profit,20*(2000+4000+6000+8000+10000));assert.equal(c.ratio,600000/250000);assert.equal(c.weak,false);
  const w=m.trdCalc({buy:50000,qty:100,stop:47500,steps:m.trdPlan(50000,52000,100).steps});assert.equal(w.weak,true);
});
t('주문 검사',()=>{
  assert.deepEqual(m.trdCheckOrder({price:84700,qty:5,upper:110000,lower:60000}),[]);
  assert.ok(m.trdCheckOrder({price:84750,qty:5}).some(x=>/호가 단위/.test(x)));
  assert.ok(m.trdCheckOrder({price:120000,qty:5,upper:110000}).some(x=>/상한가/.test(x)));
  assert.ok(m.trdCheckOrder({price:50000,qty:0,lower:60000}).length===2);
});
