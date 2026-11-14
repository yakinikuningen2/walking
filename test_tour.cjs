const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('./static/js/tour-core.js');
const start={lat:35.681,lng:139.767,name:'Start'};
const config={minutes:120,speed:4,count:3,theme:'any',returnToStart:true,direction:'any'};
const pool=[[.005,0],[.003,.005],[-.002,.004],[-.004,-.002],[.004,-.004],[.007,.001]]
  .map(([lat,lng],i)=>({lat:start.lat+lat,lng:start.lng+lng,name:`Place ${i}`,key:`place/${i}`,kindId:i%2?'shrine':'park',kindLabel:i%2?'Shrine':'Park'}));
const leg=(a,b,custom={})=>({points:[[a.lat,a.lng],[b.lat,b.lng]],distance:1250,duration:1200,...custom});
function setup(options={}){
  const calls=[],progress=[];
  const engine=core.createEngine({search:options.search||(async()=>pool),progress:text=>progress.push(text),route:async(a,b,speed,signal,routeOptions)=>{
    calls.push({a,b,speed,signal,routeOptions});return options.route?options.route(a,b,speed,signal,routeOptions):leg(a,b);
  }});
  return {engine,calls,progress};
}
test('tour settings enforce speed, stop count, duration and known themes without new services',()=>{
  assert.equal(Object.keys(core.THEMES).length,6);
  for(const change of [{speed:2},{speed:7},{count:0},{count:6},{minutes:14},{minutes:15.5},{theme:'fictional'},{returnToStart:'yes'},{direction:'ne'},{direction:null}])assert.throws(()=>core.settings({...config,...change}),{code:'INPUT'});
  assert.deepEqual(core.settings(config),config);
});
test('closed tour uses fetched leg metrics, reaches each unique stop, and includes the return leg',async()=>{
  const {engine,calls}=setup();const result=await engine.generate(config,start,{seed:0});
  assert.equal(result.course.distance,5000);assert.equal(result.course.duration,4800);assert.equal(calls.length,4);
  assert.deepEqual(calls[0].a,start);assert.deepEqual(calls.at(-1).b,start);
  assert.equal(new Set(result.course.stops.map(p=>p.key)).size,3);assert.equal(result.course.visited.length,0);
  assert.equal(core.complete(result.course),false);assert.ok(result.course.duration<=config.minutes*60);
});
test('open tour ends at its last stop instead of adding an unrequested return',async()=>{
  const {engine,calls}=setup();const {course}=await engine.generate({...config,returnToStart:false},start);
  assert.equal(calls.length,3);assert.equal(course.distance,3750);assert.equal(course.duration,3600);
  assert.equal(calls.at(-1).b.key,course.stops.at(-1).key);
});
test('duplicate IDs, duplicate nearby names, invalid points and the departure facility cannot make up missing stops',async()=>{
  const duplicate={...pool[0]},nearby={...duplicate,key:'other-id',lat:duplicate.lat+.00001};
  const {engine,calls}=setup({search:async()=>[duplicate,duplicate,nearby,{...pool[1],lat:NaN},{...start,key:'start'}]});
  await assert.rejects(engine.generate(config,start),{code:'INSUFFICIENT'});assert.equal(calls.length,0);
});
test('unfamiliar theme uses explicit visit records, rather than assuming real-world first visits',async()=>{
  const {engine}=setup();const {course}=await engine.generate({...config,theme:'unfamiliar',count:2},start,{visits:pool.slice(0,3)});
  assert.ok(course.stops.every(p=>!pool.slice(0,3).some(v=>core.meters(v,p)<100)));
  await assert.rejects(engine.generate({...config,theme:'unfamiliar'},start,{visits:pool}),{code:'INSUFFICIENT'});
});
test('actual walking time over budget produces a reason, never a straight-line substitute or fewer stops',async()=>{
  const {engine,calls}=setup({route:async(a,b)=>leg(a,b,{duration:5000})});
  await assert.rejects(engine.generate({...config,minutes:30},start),{code:'OVER_BUDGET'});
  assert.ok(calls.length<=core.LIMITS.routeCalls);
});
test('API failures stop promptly and failed leg responses never become reusable cache entries',async()=>{
  let fail=true;const {engine,calls}=setup({route:async(a,b)=>{if(fail)throw new core.TourError('ROUTE_API','provider unavailable');return leg(a,b);}});
  await assert.rejects(engine.generate(config,start),{code:'ROUTE_API'});assert.equal(calls.length,1);
  fail=false;await engine.generate(config,start);assert.equal(calls.length,5);
});
test('unreachable locations are distinct from busy or unavailable route providers',()=>{
  for(const routeCode of ['NoRoute',170,171,441,442,'171'])assert.equal(core.routeFailure({routeCode}).code,'NO_ROUTE');
  assert.equal(core.routeFailure({httpStatus:503}).code,'ROUTE_API');
  assert.equal(core.routeFailure(new TypeError('network')).code,'ROUTE_API');
  assert.equal(core.routeFailure({userMessage:'Paid passage blocked'}).message,'Paid passage blocked');
  const own=new core.TourError('TIMEOUT','Timeout');assert.equal(core.routeFailure(own),own);
});
test('invalid or distant route geometry cannot be represented as access to a facility',async()=>{
  const {engine}=setup({route:async(a,b)=>leg(a,b,{points:[[a.lat,a.lng],[0,0]]})});
  await assert.rejects(engine.generate(config,start),{code:'NO_ROUTE'});
  assert.equal(core.validLeg(leg(start,pool[0],{distance:NaN}),start,pool[0]),false);
});
test('unchanged routes reuse directed leg caches, while walking speed remains part of the key',async()=>{
  const {engine,calls}=setup();await engine.generate(config,start,{seed:0});const initial=calls.length;
  const repeated=await engine.generate(config,start,{seed:0});assert.equal(calls.length,initial);assert.equal(repeated.calls,0);
  await engine.generate({...config,speed:4.1},start,{seed:0});assert.ok(calls.length>initial);
  assert.ok(calls.slice(initial).every(c=>c.speed===4.1));
});
test('failure of an optional alternative does not discard an already validated course',async()=>{
  let calls=0,failed=false;
  const {engine}=setup({route:async(a,b)=>{calls++;if(calls>2){failed=true;throw new core.TourError('ROUTE_API','busy');}return leg(a,b);}});
  const {course}=await engine.generate({...config,count:1},start);
  assert.equal(course.legs.length,2);assert.equal(course.distance,2500);assert.equal(failed,true);
});
test('cancellation rejects even if the provider ignores abort, and late responses cannot populate caches',async()=>{
  let resolveFirst,first=true;
  const {engine,calls}=setup({route:(a,b)=>{if(first){first=false;return new Promise(resolve=>{resolveFirst=()=>resolve(leg(a,b));});}return Promise.resolve(leg(a,b));}});
  const controller=new AbortController();const pending=engine.generate(config,start,{signal:controller.signal});
  for(let i=0;i<20&&!resolveFirst;i++)await new Promise(setImmediate);
  controller.abort();await assert.rejects(pending,{name:'AbortError'});resolveFirst();await new Promise(setImmediate);
  await engine.generate(config,start);assert.equal(calls.length,5);
});
test('time limits settle non-cooperative lookups and distinguish a timeout from user cancellation',async()=>{
  let aborted=false;
  await assert.rejects(core.bounded(signal=>{signal.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});},10,null,'SEARCH_TIMEOUT'),{code:'SEARCH_TIMEOUT'});
  assert.equal(aborted,true);
  const old=core.LIMITS.generationMs;core.LIMITS.generationMs=15;
  try{const {engine}=setup({search:async()=>new Promise(()=>{})});await assert.rejects(engine.generate(config,start),{code:'TIMEOUT'});}
  finally{core.LIMITS.generationMs=old;}
});
test('rebuild applies exact requested order, reuses unchanged legs and removes only deleted progress',async()=>{
  const {engine}=setup();const {course}=await engine.generate(config,start);
  course.visited=course.stops.map(p=>p.key);course.returned=true;
  const reversed=await engine.rebuild(course,[...course.stops].reverse());
  assert.deepEqual(reversed.stops.map(p=>p.key),course.stops.map(p=>p.key).reverse());assert.equal(reversed.returned,false);
  const removed=await engine.rebuild(course,course.stops.slice(0,2));
  assert.equal(removed.settings.count,2);assert.equal(removed.visited.length,2);assert.equal(course.stops.length,3);
});
test('failed replacement cannot mutate the existing course or silently keep its old geometry',async()=>{
  let fail=false;
  const {engine}=setup({route:async(a,b)=>leg(a,b,{duration:fail?100000:1200})});
  const {course}=await engine.generate(config,start),before=JSON.stringify(course);fail=true;
  const replacement=pool.find(p=>!course.stops.some(v=>v.key===p.key));
  await assert.rejects(engine.rebuild(course,[replacement,...course.stops.slice(1)]),{code:'OVER_BUDGET'});
  assert.equal(JSON.stringify(course),before);
});
test('overlap detects a reversed repeated road; closed completion also needs manual return confirmation',async()=>{
  assert.equal(core.overlap([{points:[[35,139],[35.001,139]]},{points:[[35.001,139],[35,139]]}]),.5);
  const {engine}=setup();const {course}=await engine.generate(config,start);
  course.visited=course.stops.map(p=>p.key);assert.equal(core.complete(course),false);course.returned=true;assert.equal(core.complete(course),true);
  course.visited.pop();assert.equal(core.complete(course),false);
});
test('saved tours validate stops, geometry, time and manual progress, and recompute totals from route metrics',async()=>{
  const {engine}=setup();const {course}=await engine.generate(config,start);
  const changed=structuredClone(course);changed.distance=1;changed.duration=1;assert.equal(core.validateCourse(changed).distance,5000);
  for(const mutate of [c=>c.visited=['unknown'],c=>c.legs.pop(),c=>c.settings.count=1,c=>c.stops[0].key='',c=>c.completedAt='invalid',c=>c.legs[0].duration=100000]){
    const invalid=structuredClone(course);mutate(invalid);assert.throws(()=>core.validateCourse(invalid));
  }
});

test('stop count is automatic for new tours, adapts to sparse candidates, and can fall when actual time is too long',async()=>{
  assert.equal(core.automaticCount(15),1);assert.equal(core.automaticCount(60),2);assert.equal(core.automaticCount(120),4);assert.equal(core.automaticCount(900),5);
  const auto={...config,count:core.automaticCount(config.minutes),autoCount:true};
  const full=await setup().engine.generate(auto,start);assert.equal(full.course.stops.length,4);
  const sparse=await setup({search:async()=>pool.slice(0,2)}).engine.generate(auto,start);assert.equal(sparse.course.stops.length,2);
  const reduced=await setup({route:async(a,b)=>leg(a,b,{duration:2000})}).engine.generate(auto,start);
  assert.ok(reduced.course.stops.length<4);assert.ok(reduced.course.duration<=auto.minutes*60);
});

test('road overlap is robust to different vertex spacing and does not equate a parallel road with the original',()=>{
  const a=[35,139],mid=[35.005,139],b=[35.01,139];
  const split=[{points:[a,mid,b]},{points:[b,a]}];
  assert.ok(core.overlap(split)>.47);assert.ok(core.overlap(split,true)>.9);
  const parallel=[{points:[a,b]},{points:[[35.01,139.001],[35,139.001]]}];
  assert.equal(core.overlap(parallel),0);
});

test('return route avoids shared outbound roads, stays within budget and keeps endpoint access clear',async()=>{
  const remote={...pool[0],lat:start.lat+.01,lng:start.lng};
  let exclusions;
  const {engine}=setup({search:async()=>[remote],route:async(a,b,speed,signal,options)=>{
    if(options.avoidPolygons?.length){exclusions=options.avoidPolygons;return leg(a,b,{points:[[a.lat,a.lng],[a.lat,a.lng+.003],[b.lat,b.lng+.003],[b.lat,b.lng]],duration:1500});}
    return leg(a,b);
  }});
  const {course}=await engine.generate({...config,count:1},start);
  assert.ok(exclusions.length>0&&exclusions.length<=4);assert.ok(course.overlap<.1);assert.equal(course.duration,2700);
  for(const ring of exclusions){assert.deepEqual(ring[0],ring.at(-1));for(const [lng,lat] of ring){assert.ok(core.meters({lat,lng},start)>100);assert.ok(core.meters({lat,lng},remote)>100);}}
});

test('an over-budget or unavailable alternate return keeps the verified baseline, and open tours do not request exclusions',async()=>{
  const remote={...pool[0],lat:start.lat+.01,lng:start.lng};
  for(const fail of [false,true]){
    const {engine,calls}=setup({search:async()=>[remote],route:async(a,b,speed,signal,options)=>{
      if(options.avoidPolygons?.length){if(fail)throw new core.TourError('NO_ROUTE','no alternative');return leg(a,b,{duration:100000});}
      return leg(a,b);
    }});
    const {course}=await engine.generate({...config,count:1},start);assert.equal(course.duration,2400);assert.ok(calls.length<=14);
    const before=calls.length,open=await engine.generate({...config,count:1,returnToStart:false},start);assert.equal(open.course.legs.length,1);
    assert.ok(calls.slice(before).every(call=>!call.routeOptions?.avoidPolygons?.length));
  }
});

test('different return requests retain the existing restricted-area exclusions and ordinary routing remains unchanged',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8');let body;
  const ring=[[139,35],[139.001,35],[139.001,35.001],[139,35]];
  const context=vm.createContext({URL,ROUTE_ENDPOINT:'https://routes.test/route',loadRouteAccess:async()=>({areas:[{ring}]}),waitForRouteTurn:async()=>{},fetchRouteJson:async url=>{body=JSON.parse(url.searchParams.get('json'));return {};},parseWalkingRoute:()=>({points:[]})});
  vm.runInContext(source.slice(source.indexOf('async function calculateWalkingRoute('),source.indexOf('async function findNatureWaypoint(')),context);
  const avoid=core.returnAvoidAreas([{points:[[start.lat,start.lng],[start.lat+.01,start.lng]]},{points:[[start.lat+.01,start.lng],[start.lat,start.lng]]}],start,{lat:start.lat+.01,lng:start.lng});
  await context.calculateWalkingRoute(start,pool[0],'standard',4,{},null,avoid);
  assert.equal(body.exclude_polygons.length,avoid.length+1);assert.deepEqual(body.exclude_polygons[0],ring);
  await context.calculateWalkingRoute(start,pool[0],'standard',4,{});assert.equal(body.exclude_polygons.length,1);
  for(const file of ['index.html','templates/index.html'])assert.doesNotMatch(fs.readFileSync(`${__dirname}/${file}`,'utf8'),/id="tour-count"|立ち寄る地点数/);
});

test('four directions use 90-degree sectors around the selected departure, including north wrap and the date line',()=>{
  const points={n:{lat:start.lat+.01,lng:start.lng},e:{lat:start.lat,lng:start.lng+.01},s:{lat:start.lat-.01,lng:start.lng},w:{lat:start.lat,lng:start.lng-.01}};
  for(const [direction,p] of Object.entries(points)){
    assert.equal(core.directionMatches(start,p,direction),true);
    for(const other of Object.keys(points).filter(k=>k!==direction))assert.equal(core.directionMatches(start,p,other),false);
  }
  assert.equal(core.directionMatches(start,{lat:start.lat+.01,lng:start.lng-.001},'n'),true);
  assert.equal(core.directionMatches({lat:0,lng:179.99},{lat:0,lng:-179.99},'e'),true);
  assert.equal(core.directionMatches(start,start,'n'),false);
  assert.equal(core.directionMatches(start,points.n,'unknown'),false);
  assert.equal(core.directionMatches(start,{lat:NaN,lng:0},'any'),false);
});

test('generation filters by direction before the candidate cap and automatic count, without falling back to the opposite side',async()=>{
  const north=pool.filter(p=>core.directionMatches(start,p,'n'));
  const opposite=Array.from({length:60},(_,i)=>({...pool[0],key:`south/${i}`,name:`South ${i}`,lat:start.lat-.003-i*.00001,lng:start.lng}));
  const {engine,calls}=setup({search:async selected=>{assert.equal(selected.direction,'n');return [...opposite,...north];}});
  const {course}=await engine.generate({...config,autoCount:true,direction:'n'},start);
  assert.ok(course.stops.length);assert.ok(course.stops.every(p=>core.directionMatches(start,p,'n')));
  assert.equal(course.settings.direction,'n');assert.ok(calls.length);
  const empty=setup({search:async()=>opposite});await assert.rejects(empty.engine.generate({...config,autoCount:true,direction:'n'},start),{code:'INSUFFICIENT'});assert.equal(empty.calls.length,0);
});

test('direction persists through rebuild and save validation, while older tours without it remain readable',async()=>{
  const {engine}=setup();const {course}=await engine.generate({...config,count:1,direction:'n'},start);
  const kept=await engine.rebuild(course,course.stops);assert.equal(kept.settings.direction,'n');
  const southern={...pool[0],key:'south',lat:start.lat-.01,lng:start.lng};
  await assert.rejects(engine.rebuild(course,[southern]),{code:'INPUT'});
  const bad=structuredClone(course);bad.settings.direction='s';assert.throws(()=>core.validateCourse(bad),{code:'STORAGE'});
  const legacy=structuredClone(course);delete legacy.settings.direction;assert.equal(core.validateCourse(legacy).settings.direction,'any');
});
