const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const app = readFileSync(join(__dirname,'static/js/app.js'),'utf8');
const natural = readFileSync(join(__dirname,'static/js/natural-discovery.js'),'utf8');
const start = {lat:35.7787,lng:139.4966};
const criteria = {kind:'forest',minMinutes:0,minutes:30,speed:4,ambience:'any',direction:'any',keyword:''};
function distance(a,b) {
  if(Array.isArray(a))a={lat:a[0],lng:a[1]};if(Array.isArray(b))b={lat:b[0],lng:b[1]};
  const r=Math.PI/180,s=Math.sin((b.lat-a.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lng-a.lng)*r/2)**2;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,s)));
}
function setup() {
  let now=1000000;const queries=[];
  const c=vm.createContext({URL,URLSearchParams,AbortController,DOMException,Map,Set,Math,Number,Object,setTimeout,clearTimeout,
    Date:class extends Date{static now(){return now}},map:{distance},
    validCoordinates:(lat,lng)=>typeof lat==='number'&&Number.isFinite(lat)&&Math.abs(lat)<=90&&typeof lng==='number'&&Number.isFinite(lng)&&Math.abs(lng)<=180,
    DISCOVERY_LOCAL_SOURCES:[],DISCOVERY_LOCAL_CLASSES:{},bundledDiscoveryCache:new Map(),bundledDiscoveryAttributions:new Set(),shrineIndexCache:new Map(),
    discoveryContextCache:new Map(),discoveryGeometryCache:new Map(),discoveryElevationCache:new Map(),discoveryMapCache:new Map(),
    discoveryParkCache:new Map(),discoveryRandomCache:new Map(),ui:{'discovery-status':{}},message(){},
    fetchRouteJson:async()=>({features:[]})});
  vm.runInContext(app.slice(app.indexOf('const SEASONAL_KIND_WORDS'),app.indexOf('const NEARBY_CONVENIENCE_RADIUS')),c);
  vm.runInContext(app.slice(app.indexOf('const DISCOVERY_DISTANCE_FACTOR'),app.indexOf('const WALKING_SETTINGS_KEY')),c);
  vm.runInContext(app.slice(app.indexOf('function discoveryText'),app.indexOf('function renderDiscoveryResults')),c);
  vm.runInContext(natural,c);
  c.fetchDiscoveryMapData=async(q,req,timeout,retry,options)=>{queries.push({q,timeout,retry,options});return c.respond(q,req)};
  const request=(input=criteria)=>({criteria:input,controller:new AbortController()});
  return {c,queries,request,advance:ms=>now+=ms};
}
function point(x,y){return {lat:start.lat+y/111195,lon:start.lng+x/(111195*Math.cos(start.lat*Math.PI/180))}}
function ring(x1,y1,x2,y2){return [[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]].map(p=>point(...p))}
function feature(tags={natural:'wood'},id=10){return {type:'way',id,tags,center:{lat:point(200,0).lat,lon:point(200,0).lon},geometry:ring(100,-100,300,100)}}
function road(tags={highway:'footway',foot:'designated'},id=20,x=80){return {type:'way',id,tags,nodes:[200,201],geometry:[point(x,-150),point(x,150)]}}
function metadata(features){return features.map(e=>({type:e.type,id:e.id,tags:e.tags,...(e.type==='node'?{lat:e.lat,lon:e.lon}:{center:e.center})}))}
function respondWith(c,features,access){c.respond=async q=>q.includes('out body center')?metadata(features):q.includes('->.features')?features:access}

test('unnamed forest resolves onto an actual footway, not the forest centre or bare boundary',async()=>{
  const {c,request,queries}=setup(),f=feature(),path=road();respondWith(c,[f],[path]);
  const updates=[];const places=await c.findDiscoveryPlaces(criteria,start,request(),p=>updates.push(p));
  assert.equal(places.length,1);const p=places[0];
  assert.equal(p.naturalUnnamed,true);assert.equal(p.accessAnchor.id,path.id);assert.equal(p.accessStatus,'mapped');
  assert.ok(p.accessNote.includes('現地未確認'));assert.ok(p.name.includes('歩道'));
  assert.ok(Math.abs(c.naturalXY(p,start).x-80)<.001);assert.ok(distance(p,{lat:f.center.lat,lng:f.center.lon})>100);
  assert.equal(queries.length,4);assert.ok(queries.every(q=>q.retry===false&&[6000,10000].includes(q.timeout)));
  assert.match(queries[0].q,/nwr\(/);assert.ok(!queries[0].q.includes('[name]'));
  assert.match(queries[2].q,/footway\|path/);assert.match(queries[3].q,/\[entrance\]/);assert.match(queries[3].q,/park\|garden/);
  assert.ok(updates.some(p=>p.length===1));
});

test('node nature also needs a mapped access point; missing paths never become raw destinations',async()=>{
  const {c,request}=setup(),node={type:'node',id:1,...point(100,0),tags:{natural:'wood'}};respondWith(c,[node],[]);
  const req=request();assert.equal((await c.findDiscoveryPlaces(criteria,start,req)).length,0);assert.equal(req.natureAccessUnresolved,true);
  assert.equal(c.discoveryCandidates([node,...metadata([feature()])],criteria,start).length,0);
  const result=c.naturalResolve(node,'forest',[road()],criteria,start);assert.ok(result);
  assert.ok(Math.abs(c.naturalXY(result.naturalAccess.point,start).x-80)<.001);
});

test('water polygons select dry mapped shore paths and reject an unbridged path in the water',()=>{
  const {c}=setup(),lake=feature({natural:'water',water:'lake'}),input={...criteria,kind:'waterside'};
  const submerged=road(undefined,21,200);submerged.geometry=[point(200,-50),point(200,50)];
  assert.equal(c.naturalResolve(lake,'waterside',[submerged],input,start),null);
  const bank=c.naturalResolve(lake,'waterside',[road()],input,start);assert.ok(bank);
  assert.ok(Math.abs(c.naturalXY(bank.naturalAccess.point,start).x-80)<.001);
  const bridge=c.naturalResolve(lake,'waterside',[road({highway:'footway',foot:'yes',bridge:'yes'},22,200)],input,start);assert.ok(bridge);
  const clipped={...lake,geometry:[...lake.geometry.slice(0,2),null]};
  assert.equal(c.naturalResolve(clipped,'waterside',[road()],input,start),null,'incomplete water outlines cannot prove a dry shore');
});

test('river and stream centre lines are not walking destinations; a bank path or mapped bridge is required',()=>{
  const {c}=setup(),river={type:'way',id:11,tags:{waterway:'river',width:'10'},geometry:[point(100,-300),point(100,300)]},input={...criteria,kind:'waterside'};
  assert.equal(c.naturalResolve(river,'waterside',[road(undefined,21,100)],input,start),null);
  assert.ok(c.naturalResolve(river,'waterside',[road()],input,start));
  assert.ok(c.naturalResolve(river,'waterside',[road({highway:'footway',foot:'yes',bridge:'yes'},22,100)],input,start));
  const stream={...river,tags:{waterway:'stream'}};
  assert.equal(c.naturalResolve(stream,'waterside',[road(undefined,23,100)],input,start),null);
});

test('multipolygon member ways join in either direction and inner islands remain dry',()=>{
  const {c}=setup(),outer=ring(100,-200,400,200),inner=ring(200,-100,300,100);
  const lake={type:'relation',id:30,tags:{natural:'water',water:'pond'},members:[
    {role:'outer',geometry:outer.slice(0,3)},{role:'outer',geometry:outer.slice(2).reverse()},
    {role:'inner',geometry:inner.slice(0,3)},{role:'inner',geometry:inner.slice(2)}]};
  assert.equal(c.naturalRings(lake,start).length,1);assert.equal(c.naturalRings(lake,start,true).length,1);
  const island=road(undefined,23,250);island.geometry=[point(250,-50),point(250,50)];
  assert.ok(c.naturalResolve(lake,'waterside',[island],{...criteria,kind:'waterside'},start));
  assert.equal(c.naturalResolve(lake,'waterside',[road(undefined,24,350)],{...criteria,kind:'waterside'},start),null);
});

test('private nature, forbidden roads, private areas and locked or forbidden gates are excluded',()=>{
  const {c}=setup(),f=feature();
  for(const tags of [{highway:'footway',access:'private',foot:'yes'},{highway:'path',foot:'no'},
    {highway:'motorway',foot:'yes'},{highway:'path',access:'military'},{highway:'path',access:'permit'},
    {highway:'path',access:'customers'},{highway:'path',sac_scale:'alpine_hiking'},{highway:'path',informal:'yes'}]) {
    assert.equal(c.naturalResolve(f,'forest',[road(tags)],criteria,start),null,JSON.stringify(tags));
  }
  assert.equal(c.naturalResolve(feature({natural:'wood',access:'private'}),'forest',[road()],criteria,start),null);
  const area={type:'way',id:40,tags:{landuse:'forest',access:'private'},geometry:ring(60,-200,90,200)};
  assert.equal(c.naturalResolve(f,'forest',[road(),area],criteria,start),null);
  const gate={type:'node',id:200,...point(80,0),tags:{barrier:'gate',locked:'yes'}};
  assert.equal(c.naturalResolve(f,'forest',[road(),gate],criteria,start),null);
});

test('unknown and conditional access are visibly distinguished from explicit mapped pedestrian permission',()=>{
  const {c}=setup(),f=feature();
  for(const tags of [{highway:'path'},{highway:'footway',foot:'yes','foot:conditional':'no @ (22:00-06:00)'}]) {
    const result=c.naturalResolve(f,'forest',[road(tags)],criteria,start);assert.ok(result);
    assert.equal(result.naturalAccess.status,'unknown');assert.ok(result.naturalAccess.note.includes('未確認'));
  }
});

test('mapped entrances and adjacent parks improve the label without using the park centre as the destination',()=>{
  const {c}=setup(),f=feature(),path=road();const gate={type:'node',id:99,...point(80,0),tags:{entrance:'main',foot:'yes'}};
  const result=c.naturalResolve(f,'forest',[path,gate],criteria,start);assert.ok(result.tags.name.includes('入口'));
  const park={type:'way',id:60,tags:{leisure:'park'},geometry:ring(60,-200,90,200)};
  const nearby=c.naturalResolve(f,'forest',[path,park],criteria,start);assert.ok(nearby.tags.name.includes('公園の歩道'));
  assert.ok(Math.abs(c.naturalXY(nearby.naturalAccess.point,start).x-80)<.001);
});

test('time and direction are measured at the footway and rechecked after speed or start changes',()=>{
  const {c}=setup(),f=feature(),path=road();
  const west={...criteria,direction:'w'};assert.equal(c.naturalResolve(f,'forest',[path],west,start),null);
  assert.equal(c.naturalResolve(f,'forest',[path],{...criteria,minMinutes:330,minutes:390},start),null);
  const east={...criteria,direction:'e'};assert.ok(c.naturalResolve(f,'forest',[path],east,start));
  const result=c.naturalResolve(f,'forest',[path],criteria,start);
  const shifted={lat:start.lat,lng:point(70,0).lon};
  const first=c.discoveryCandidates([result],criteria,start)[0],next=c.discoveryCandidates([result],{...criteria,speed:6.5},shifted)[0];
  assert.ok(next.duration<first.duration);
});

test('a long natural boundary is searched near the requested time band rather than only near its centre or nearest edge',()=>{
  const {c}=setup();const long={type:'way',id:70,tags:{waterway:'river'},geometry:[point(100,0),point(25000,0)]};
  const input={...criteria,kind:'waterside',minMinutes:330,minutes:390};
  const points=c.naturalFocusPoints(long,input,start);assert.ok(points.length);
  assert.ok(points.some(p=>distance(start,p)>16000&&distance(start,p)<21000));
});

test('query regions, feature budgets, memory, counts and far-away sampling are bounded and reported',async()=>{
  const {c,request,queries}=setup();const input={...criteria,minMinutes:720,minutes:780};
  const scope=c.naturalSearchBoxes(input,start,40000);assert.equal(scope.limited,true);assert.equal(scope.boxes.length,4);
  assert.ok(scope.boxes.every(b=>{const a=b.split(',').map(Number);return distance({lat:a[0],lng:a[1]},{lat:a[2],lng:a[3]})<11000}));
  const features=Array.from({length:35},(_,i)=>feature({natural:'wood'},100+i));respondWith(c,features,[road()]);
  const req=request();await c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,req);
  assert.equal(req.natureLimited,true);assert.ok(queries.length<=10);assert.match(queries[0].q,/timeout:8/);assert.match(queries[0].q,/maxsize:67108864/);
  assert.ok(c.naturalDataTruncated([{type:'count',tags:{total:'33'}}],[32]));
});

test('empty results, API failures, partial failures and cancellation remain separate; cached reads expire',async()=>{
  const {c,request,queries,advance}=setup();c.respond=async()=>[];
  assert.equal((await c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,request())).length,0);
  await c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,request());assert.equal(queries.length,1);
  advance(600001);await c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,request());assert.equal(queries.length,2);
  const other=setup();other.c.respond=async()=>{throw Object.assign(Error('busy'),{routeCode:'MapBusy'})};
  await assert.rejects(other.c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,other.request()),{routeCode:'MapBusy'});
  let resolve;const last=setup();last.c.respond=()=>new Promise(r=>{resolve=r});const req=last.request(),updates=[];
  const pending=last.c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,req,p=>updates.push(p));req.controller.abort();resolve(metadata([feature()]));
  await assert.rejects(pending,{name:'AbortError'});assert.equal(updates.length,0);
});

test('water, forest and coast tag alternatives are OR queries over nodes, ways and relations, without name requirements',()=>{
  const {c}=setup(),q=c.naturalIndexQuery(['forest','waterside','coast'],['35,139,36,140'],32);
  for(const tag of ['wood','forest','river','stream','water','lake','pond','coastline','beach','harbour','marina'])assert.ok(q.includes(tag),tag);
  assert.ok(!q.includes('[name]'));assert.match(q,/nwr\(/);
});

test('a named natural feature takes precedence when a coastline and beach share the same walking destination',()=>{
  const {c}=setup(),path=road();
  const first=c.naturalResolve(feature({natural:'wood'},10),'forest',[path],criteria,start);
  const named=c.naturalResolve(feature({natural:'wood',name:'Named forest'},11),'forest',[path],criteria,start);
  const places=c.discoveryCandidates([first,named],criteria,start);
  assert.equal(places.length,1);assert.equal(places[0].osmId,11);assert.ok(places[0].name.includes('Named forest'));
});

test('partial API failures preserve already resolved candidates and report an incomplete search',async()=>{
  const {c,request}=setup(),features=Array.from({length:5},(_,i)=>feature({natural:'wood'},10+i));
  let geometryCalls=0;c.respond=async q=>{
    if(q.includes('out body center'))return metadata(features);
    if(q.includes('->.features')){if(++geometryCalls===2)throw Object.assign(Error('busy'),{routeCode:'MapBusy'});return features.slice(0,4)}
    return [road()];
  };
  const req=request(),updates=[];
  const found=await c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,req,p=>updates.push(p));
  assert.equal(found.length,4);assert.equal(req.natureUnavailable,true);assert.ok(updates.some(p=>p.length===4));
});

test('long-distance sampled regions retain geometry from later regions instead of only the first box',async()=>{
  const {c,request,queries}=setup(),input={...criteria,minMinutes:720,minutes:780};
  const base={type:'way',id:70,tags:{natural:'wood'},center:{lat:start.lat,lon:start.lng}};
  const north={...base,geometry:[point(100,37000),point(100,38000)]};
  const east={...base,geometry:[point(37000,100),point(38000,100)]};
  const path=road();path.geometry=[point(37000,80),point(38000,80)];
  c.respond=async q=>q.includes('out body center')?[base]:q.includes('->.features')?[north,east]:[path];
  const req=request(input),found=await c.findNaturalDiscoveryElements(['forest'],input,start,40000,req);
  assert.ok(found.length);assert.ok(found[0].naturalAccess.point.lng>start.lng+.2);assert.equal(req.natureLimited,true);
  assert.equal((queries[1].q.match(/\.features out body geom/g)||[]).length,4);
});

test('failure of ancillary access information keeps mapped paths explicitly unconfirmed, rather than claiming verified access',async()=>{
  const {c,request}=setup();c.respond=async q=>{
    if(q.includes('out body center'))return metadata([feature()]);
    if(q.includes('->.features'))return [feature()];
    if(q.includes('[timeout:5]'))throw Object.assign(Error('busy'),{routeCode:'MapBusy'});
    return [road()];
  };
  const req=request(),places=await c.findDiscoveryPlaces(criteria,start,req);
  assert.equal(places.length,1);assert.equal(req.natureUnavailable,true);assert.equal(places[0].accessStatus,'unknown');
  assert.ok(places[0].accessNote.includes('立入制限'));
});

test('enormous geometry and private areas are bounded before expensive processing',async()=>{
  const {c,request}=setup(),huge={...feature(),geometry:Array.from({length:6001},(_,i)=>point(100,i/100))};
  respondWith(c,[huge],[road()]);const req=request();
  assert.equal((await c.findNaturalDiscoveryElements(['forest'],criteria,start,1600,req)).length,0);assert.equal(req.natureLimited,true);
  const privateArea={...huge,tags:{access:'private'}};
  assert.equal(c.naturalPrepareAccess([road(),privateArea],start).paths.length,0);
});

test('legacy or malformed natural history stays non-actionable until pedestrian access is searched again',()=>{
  const {c}=setup();const place=c.discoveryCandidates([c.naturalResolve(feature(),'forest',[road()],criteria,start)],criteria,start)[0];
  assert.equal(c.discoveryNaturalPlaceReady(place),true);
  for(const changed of [{...place,accessAnchor:undefined},{...place,accessStatus:undefined},
    {...place,accessAnchor:{type:'way',id:'bad'}},{...place,accessNote:''}])assert.equal(c.discoveryNaturalPlaceReady(changed),false);
});

function routeSetup() {
  const {c}=setup();Object.assign(c,{routeEnabled:true,routeVersion:1,routeRequest:null,walkingRouteMode:'standard',selectedRouteKind:'standard',
    setRouteBusy(){},routeErrorMessage:e=>String(e),destination:{lat:start.lat+.001,lng:start.lng,accessAnchor:{type:'way',id:20}}});
  const first=app.indexOf('async function fetchWalkingRoute(');
  vm.runInContext(app.slice(first,app.indexOf('ui["route-button"].addEventListener',first)),c);
  return c;
}

test('natural pedestrian endpoints use the existing server-side ORS bridge with a bounded wait',async()=>{
  const c=routeSetup(),end={lat:c.destination.lat,lng:c.destination.lng};let called;
  c.fetchSuggestedWalkingRoutes=async(a,b,mode,request,isCurrent)=>{called={a,b,mode,wait:request.orsTimeoutMs};assert.ok(isCurrent())};
  await c.fetchWalkingRoute(start,end,1);
  assert.equal(called.mode,'standard');assert.deepEqual(called.b,end);assert.equal(called.wait,15000);
});

test('an unavailable ORS bridge falls back once to the existing provider, while cancellation never restarts routing',async()=>{
  for(const cancelled of [false,true]) {
    const c=routeSetup(),original=c.fetchWalkingRoute,end={lat:c.destination.lat,lng:c.destination.lng};let fallback;
    c.fetchWalkingRoute=async(...args)=>{fallback=args};
    c.fetchSuggestedWalkingRoutes=async()=>{if(cancelled)c.routeEnabled=false;throw Error('ORS unavailable')};
    await original(start,end,1);
    if(cancelled)assert.equal(fallback,undefined);
    else {assert.deepEqual(fallback[1],end);assert.equal(fallback[5],true)}
  }
});

module.exports={setup,start,criteria,point,ring,feature,road,respondWith};
