const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const C=require(path.join(process.cwd(),'static/js/walk-steps-core.js'));
const W=require(path.join(process.cwd(),'static/js/walk-session-core.js'));
function wave({period=600,duration=12000,amplitude=2,rotate=false,spin=false,spacing=20,offset=0,detector=new C.Detector()}={}){
 let steps=0;const increments=[];
 for(let t=0;t<duration;t+=spacing){const magnitude=9.81+amplitude*Math.sin(2*Math.PI*t/period),angle=rotate?t/600:0;
  const result=detector.sample({accelerationIncludingGravity:{x:magnitude*Math.sin(angle),y:0,z:magnitude*Math.cos(angle)},rotationRate:{alpha:spin?400:0,beta:0,gamma:0}},t+offset);
  steps+=result.steps;if(result.steps)increments.push({time:t+offset,count:result.steps});
 }return {steps,increments,detector};
}
const hour=()=>new Date(2026,10,18,10).getTime();
const record=(id,source='gps',steps)=>({version:1,id,name:'Walk',source,date:new Date(hour()).toISOString(),distanceMeters:1000,durationSeconds:900,movingSeconds:600,weightKg:null,note:'',segments:[],...(steps?{steps}:{})});
test('stationary noise, orientation changes, constant gravity and invalid acceleration do not count',()=>{
 for(const options of [{amplitude:0},{amplitude:.12},{amplitude:0,rotate:true}])assert.equal(wave(options).steps,0);
 const d=new C.Detector();for(let n=0;n<1000;n++)assert.equal(d.sample({accelerationIncludingGravity:{x:null,y:0,z:9.81}},n*20).steps,0);
 assert.equal(d.sample({accelerationIncludingGravity:{x:0,y:0,z:Infinity}},30000).valid,false);
});
test('regular synthetic walking counts without depending on axis orientation',()=>{
 for(const period of [400,500,600,800,1200]){
  const normal=wave({period}),rotated=wave({period,rotate:true});
  assert.ok(normal.steps>=Math.floor((12000-2000)/period)-1,JSON.stringify({period,steps:normal.steps}));
  assert.ok(normal.steps<=Math.ceil(12000/period));assert.equal(rotated.steps,normal.steps);
  assert.equal(normal.increments[0].count,4,'wait for four consistent peaks');
  for(const increment of normal.increments.slice(1))assert.equal(increment.count,1);
 }
});
test('one-off pulses, high-frequency shaking, high amplitudes and fast rotations are suppressed',()=>{
 assert.equal(wave({duration:1100}).steps,0);
 for(const options of [{period:180},{period:200},{period:250},{amplitude:24},{spin:true}])assert.equal(wave(options).steps,0,JSON.stringify(options));
 const d=new C.Detector();let total=0;for(let t=0;t<10000;t+=20){total+=d.sample({accelerationIncludingGravity:{x:0,y:0,z:9.81+(t===2000?9:0)}},t).steps;}assert.equal(total,0);
});
test('missing or out-of-order samples restart rhythm without invented steps',()=>{
 const first=wave({duration:5000});assert.ok(first.steps>0);
 assert.equal(first.detector.sample({accelerationIncludingGravity:{x:0,y:0,z:10}},100).valid,false);
 assert.equal(wave({detector:first.detector,offset:20000,duration:1500}).steps,0);
 first.detector.reset();assert.equal(wave({detector:first.detector,offset:30000,duration:1500}).steps,0);
});
test('linear acceleration is accepted when gravity-inclusive data is unavailable',()=>{
 const d=new C.Detector();let count=0;
 for(let t=0;t<12000;t+=20)count+=d.sample({acceleration:{x:0,y:0,z:2+2*Math.sin(2*Math.PI*t/600)}},t).steps;
 assert.ok(count>=15&&count<=20,String(count));
});
test('sensor and distance steps never accumulate over the same interval',()=>{
 const c=new C.Counter();c.setMode('sensor',1000);assert.equal(c.sensor(10,2000),true);
 assert.equal(c.gps(7,1000,5000),false);assert.equal(c.total,10);
 c.setMode('gps',5000);assert.equal(c.gps(7,4000,6000),false,'skip interval spanning a switch');
 assert.equal(c.sensor(4,7000),false);assert.equal(c.gps(7,5000,15000),true);assert.equal(c.total,20);
 c.setMode('paused',16000);assert.equal(c.gps(7,15000,25000),false);assert.equal(c.sensor(4,20000),false);
 c.setMode('sensor',26000);assert.equal(c.gps(7,26000,36000),false);assert.equal(c.sensor(4,27000),true);
 assert.equal(c.data.sensorSteps,14);assert.equal(c.data.estimatedSteps,10);
});
test('fallback respects stride, fractional distance, pauses, stale fixes and GPS gaps',()=>{
 const c=new C.Counter(null,{strideCm:70,goal:5000});c.setMode('gps',1000);
 assert.equal(c.gps(.35,1000,2000),true);assert.equal(c.total,0);assert.equal(c.gps(.35,2000,3000),true);assert.equal(c.total,1);
 for(const args of [[100,3000,4000],[7,3000,40000],[7,3000,10000,30000],[7,3000,10000,0],[NaN,3000,10000]])assert.equal(c.gps(...args),false);
 c.setMode('paused',50000);c.setMode('gps',90000);assert.equal(c.gps(7,50000,95000),false);assert.equal(c.total,1);
 assert.equal(C.validSnapshot(c.snapshot()),true);
});
test('snapshots persist counts only; old records remain valid and restored measurement is paused',()=>{
 const c=new C.Counter();c.setMode('sensor',hour());c.sensor(32,hour()+1000);
 const saved=record('with-steps','gps',c.snapshot());W.validate(saved);const recorder=new W.Recorder(saved);
 assert.deepEqual(recorder.record().steps,c.snapshot());assert.equal(recorder.running,false);
 const restored=new C.Counter(recorder.steps);assert.equal(restored.total,32);assert.equal(restored.mode,'paused');
 recorder.steps.sensorSteps=99;assert.equal(saved.steps.sensorSteps,32,'defensive copy');
 W.validate(record('old'));assert.equal(new W.Recorder(record('old')).steps,undefined);
 assert.equal(Object.hasOwn(c.snapshot(),'acceleration'),false);
 assert.throws(()=>W.validate(record('plan','plan',c.snapshot())));
});
test('invalid or inconsistent step snapshots cannot overwrite saved data',()=>{
 const valid=new C.Counter().snapshot();
 for(const bad of [{...valid,sensorSteps:1},{...valid,strideCm:0},{...valid,goal:0},{...valid,remainderMeters:1},{...valid,estimatedSteps:-1},{...valid,buckets:[{hour:'bad',sensorSteps:0,estimatedSteps:0}]}]){
  assert.equal(C.validSnapshot(bad),false);assert.throws(()=>new C.Counter(bad));assert.throws(()=>W.validate(record('bad','gps',bad)));
 }
});
test('daily, weekly, monthly graphs omit plans and distinguish missing step records from zeros',()=>{
 const c=new C.Counter();c.setMode('sensor',hour());c.sensor(100,hour());c.setMode('gps',hour());c.gps(7,hour(),hour()+10000);
 const rows=[record('new','gps',c.snapshot()),record('old'),record('plan','plan')],before=JSON.stringify(rows);
 const day=C.statistics(rows,'day','2026-11-18');assert.equal(day.bars.length,24);assert.equal(day.bars[10].sensorSteps,100);assert.equal(day.estimatedSteps,10);
 assert.equal(day.count,2);assert.equal(day.missingSteps,1);assert.equal(day.distanceMeters,2000);assert.equal(day.durationSeconds,1800);
 const week=C.statistics(rows,'week','2026-11-18');assert.equal(week.start,'2026-11-16');assert.equal(week.end,'2026-11-22');assert.equal(week.bars.length,7);assert.equal(week.sensorSteps,100);
 const month=C.statistics(rows,'month','2026-11-18');assert.equal(month.bars.length,30);assert.equal(month.estimatedSteps,10);
 assert.equal(C.statistics(rows,'month','2026-12-18').count,0);assert.equal(JSON.stringify(rows),before);
 assert.throws(()=>C.statistics(rows,'day','2026-02-31'));
});
test('steps crossing midnight stay on the counted date, including month/year boundaries',()=>{
 const c=new C.Counter(),first=new Date(2026,11,31,23,59).getTime(),second=new Date(2027,0,1,0,1).getTime();
 c.setMode('sensor',first);c.sensor(10,first);c.sensor(20,second);const row={...record('midnight','gps',c.snapshot()),date:new Date(first).toISOString()};
 assert.equal(C.statistics([row],'day','2026-12-31').sensorSteps,10);assert.equal(C.statistics([row],'day','2027-01-01').sensorSteps,20);
 assert.equal(C.statistics([row],'month','2027-01-01').count,0);
});
