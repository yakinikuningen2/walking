const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('./static/js/walk-session-core.js');
const origin=[35,139],at=(meters,east=0)=>[35+meters/111195,139+east/(111195*Math.cos(35*Math.PI/180))];
const fix=(meters,time,accuracy=5,east=0)=>({coords:{latitude:at(meters,east)[0],longitude:at(meters,east)[1],accuracy},timestamp:time});
const memory=()=>{const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
const record=(id='one',source='plan',segments=[[origin,at(1000)]])=>({version:1,id,name:'Route',source,date:'2026-11-16T01:00:00Z',distanceMeters:1000,durationSeconds:1000,movingSeconds:source==='gps'?900:0,weightKg:null,note:'',segments});

test('GPS walking distance, moving time and calibrated speed come from accepted positions',()=>{
 const r=new C.Recorder();r.start(100000);r.fix(fix(0,100000),100000);
 for(let i=1;i<=20;i++)r.fix(fix(i*10,100000+i*10000),100000+i*10000);
 assert.ok(Math.abs(r.distanceMeters-200)<.1);assert.equal(r.movingSeconds,200);assert.ok(Math.abs(r.speed()-3.6)<.01);
 r.pause(310000);assert.equal(r.elapsed(999999),210);assert.equal(r.record({},999999).source,'gps');
 assert.equal(r.record({},999999).durationSeconds,210);
});
test('stationary jitter, invalid fixes, stale timestamps and jumps are not walking distance',()=>{
 const r=new C.Recorder();r.start(100000);r.fix(fix(0,100000),100000);
 for(let i=1;i<=20;i++)r.fix(fix(i%3,100000+i*1000),100000+i*1000);
 assert.equal(r.distanceMeters,0);assert.equal(r.speed(),null);
 for(const p of [fix(100,121000,100),fix(10000,122000),fix(100,100000),{coords:{latitude:NaN,longitude:139,accuracy:5},timestamp:123000}])r.fix(p,123000);
 assert.equal(r.distanceMeters,0);
});
test('pauses and missing GPS intervals create separate segments rather than straight bridges',()=>{
 const r=new C.Recorder();r.start(100000);r.fix(fix(0,100000),100000);r.fix(fix(10,110000),110000);
 r.pause(115000);r.start(200000);r.fix(fix(500,200000),200000);r.fix(fix(510,210000),210000);
 r.fix(fix(1000,300000),300000);r.fix(fix(1010,310000),310000);r.pause(311000);
 assert.ok(Math.abs(r.distanceMeters-30)<.1);assert.equal(r.movingSeconds,30);assert.equal(r.durationSeconds,126);
 assert.equal(r.segments.length,3);assert.equal(r.gaps,1);
 const recovered=new C.Recorder(r.record());assert.equal(recovered.running,false);assert.equal(recovered.record().id,r.record().id);
});
test('calories require a supplied body weight and remain an estimate separate from measurements',()=>{
 assert.equal(C.calories(2000,60),60);assert.equal(C.calories(0,60),0);
 for(const weight of [null,undefined,NaN,0,19,301])assert.equal(C.calories(2000,weight),null);
 assert.equal(C.calories(-1,60),null);
});
test('short recordings cannot calibrate speed',()=>{
 const r=new C.Recorder();r.start(0);r.fix(fix(0,0),0);r.fix(fix(50,20000),20000);assert.equal(r.speed(),null);
});
test('many disconnected GPS sections stay bounded without joining gaps or losing the measured totals',()=>{
 const r=new C.Recorder();r.start(0);
 for(let i=0;i<110;i++){r.fix(fix(i*100,i*60000),i*60000);r.fix(fix(i*100+10,i*60000+10000),i*60000+10000);}
 assert.equal(r.segments.length,100);assert.equal(r.geometryLimited,true);
 assert.ok(Math.abs(r.distanceMeters-1100)<1);assert.equal(r.movingSeconds,1100);
 const saved=r.record({},110*60000);assert.equal(saved.geometryLimited,true);assert.equal(new C.Recorder(saved).geometryLimited,true);
});
test('compaction is bounded, preserves disconnected tracks and handles singleton segments',()=>{
 const segments=[[origin],Array.from({length:4000},(_,i)=>at(i))];
 const saved=C.compact(segments);assert.ok(saved.flat().length<=C.MAX_POINTS);assert.equal(saved.length,2);
 assert.deepEqual(saved[0],[origin]);assert.deepEqual(saved[1].at(-1),at(3999));
});
test('route book separates plans/GPS, survives reload and does not change existing visit data',()=>{
 const storage=memory();storage.setItem('walking.visits.v1','old visits');const b=new C.RouteBook(storage);
 b.add(record());b.add(record('two','gps'));assert.equal(new C.RouteBook(storage).records.length,2);
 assert.equal(storage.getItem('walking.visits.v1'),'old visits');b.remove('one');assert.equal(b.records[0].source,'gps');
});
test('corrupt or unavailable storage is protected and failed writes keep the old book',()=>{
 const s=memory();s.setItem('walking.routes.v1','not json');const b=new C.RouteBook(s);assert.equal(b.readable,false);
 assert.throws(()=>b.add(record()));assert.equal(s.getItem('walking.routes.v1'),'not json');
 const store=memory(),good=new C.RouteBook(store);good.add(record());store.setItem=()=>{throw Error('quota')};
 assert.throws(()=>good.add(record('two')));assert.equal(good.records.length,1);
 const blocked=new C.RouteBook({getItem(){throw Error('blocked')}});assert.equal(blocked.readable,false);
});
test('record limits and invalid coordinates are rejected without silent deletion',()=>{
 const b=new C.RouteBook(memory());for(let i=0;i<C.MAX_RECORDS;i++)b.add(record(String(i)));
 assert.throws(()=>b.add(record('extra')));assert.equal(b.records.length,C.MAX_RECORDS);
 assert.throws(()=>C.validate(record('bad','gps',[[[91,139]]])));
 assert.throws(()=>C.validate({...record(),movingSeconds:2000}));
});
test('saved plans and recorded walks influence candidate selection only inside the browser',()=>{
 for(const source of ['gps','plan']){
  const b=new C.RouteBook(memory());b.add(record('history',source));
  const old={points:[origin,at(1000)],distance:1000,duration:1000};
  const fresh={points:[origin,at(200,100),at(800,100),at(1000)],distance:1250,duration:1250};
  const chosen=b.choose([old,fresh]);assert.equal(chosen.distance,1250);assert.ok(chosen.historyOverlap<.5);
  assert.equal(b.choose([old,fresh],false),old);assert.equal(b.choose([old]).historyAlternatives,1);
 }
});
test('candidate selection avoids unreasonable detours and preserves the only available path',()=>{
 const b=new C.RouteBook(memory());b.add(record());const old={points:[origin,at(1000)],distance:1000};
 const far={points:[origin,at(200,1000),at(1000)],distance:5000};
 assert.equal(b.choose([old,far]).distance,1000);assert.ok(b.choose([old]).historyOverlap>.8);
});

test('tour leg caches refresh when the saved-route comparison changes',async()=>{
 const Tour=require('./static/js/tour-core.js');let revision='before',calls=0;
 const p={lat:at(500)[0],lng:139,name:'Park',key:'park/1',kindId:'park'};
 const engine=Tour.createEngine({search:async()=>[p],historyKey:()=>revision,route:async(a,b)=>{
  calls++;return {points:[[a.lat,a.lng],[b.lat,b.lng]],distance:500,duration:450};
 }});
 const {course}=await engine.generate({minutes:30,speed:4,count:1,theme:'any',returnToStart:false,direction:'any'},{lat:35,lng:139});
 const before=calls;await engine.rebuild(course,course.stops);assert.equal(calls,before);
 revision='after';await engine.rebuild(course,course.stops);assert.equal(calls,before+1);
});
test('actual routing sends normal endpoints and at most two alternates, without saved tracks or body data',async()=>{
 const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8'),calls=[],book=new C.RouteBook(memory());book.add(record());
 const old={points:[origin,at(1000)],distance:1000,steps:[]},alt={points:[origin,at(200,100),at(800,100),at(1000)],distance:1250,steps:[]};
 const c=vm.createContext({URL,ROUTE_ENDPOINT:'https://example.test/route',map:{distance:C.meters},
  WalkingSession:{hasHistory:true,choose:routes=>book.choose(routes)},
  loadRouteAccess:async()=>({areas:[]}),waitForRouteTurn:async()=>{},parseWalkingRoute:data=>data.routes[0],
  fetchRouteJson:async url=>{calls.push(JSON.parse(url.searchParams.get('json')));return {routes:[old,alt]};},
  validCoordinates:(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng),LongRoutes:{},
 });
 vm.runInContext(source.slice(source.indexOf('async function calculateWalkingRoute('),source.indexOf('async function findNatureWaypoint(')),c);
 const route=await c.calculateWalkingRoute({lat:35,lng:139},{lat:at(1000)[0],lng:139},'standard',4,{controller:new AbortController()});
 assert.equal(route.distance,1250);assert.equal(calls.length,1);assert.equal(calls[0].alternates,2);
 assert.equal(calls[0].locations.length,2);assert.deepEqual(calls[0].exclude_polygons,[]);
 for(const key of ['history','segments','weight','weightKg','records'])assert.equal(Object.hasOwn(calls[0],key),false);
});

test('explicit start-point selection and registration do not become accidental detours',()=>{
 const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8'),begin=source.lastIndexOf('map.on("click", ({ latlng }) => {');
 let handler,starts=0,detours=0,visits=0,picking=true;
 const c=vm.createContext({map:{on:(_,fn)=>{handler=fn;}},selectingStartOnMap:true,
  NearbyRouting:{stopPicking(){picking=false;},handleMapClick(){if(picking){detours++;return true;}return false;}},
  stopStartMapSelection(){c.selectingStartOnMap=false;},setDiscoveryOpen(){},setStartPoint(){starts++;},
  panelIsOpen:()=>true,selectPlace(){visits++;},
 });
 vm.runInContext(source.slice(begin,source.indexOf('\nrenderVisits();',begin)),c);
 handler({latlng:{lat:35,lng:139}});assert.equal(starts,1);assert.equal(detours,0);
 handler({latlng:{lat:35,lng:139}});assert.equal(visits,1);
 picking=true;handler({latlng:{lat:35,lng:139}});assert.equal(detours,1);assert.equal(visits,1);
});
