const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const R=require('./static/js/long-routes.js');
const origin={lat:35,lng:139},target={lat:35.9,lng:139};
const leg=(a,b,changes={})=>({points:[[a.lat,a.lng],[b.lat,b.lng]],distance:R.meters(a,b)*1.05,duration:R.meters(a,b),steps:[{mode:'walking',distance:R.meters(a,b)*1.05,maneuver:{type:'depart'}},{mode:'walking',distance:0,maneuver:{type:'arrive'}}],...changes});
const located=points=>points.map(p=>({edges:[{correlated_lat:p.lat,correlated_lon:p.lng,inbound_reach:100,outbound_reach:100,access_restrictions:[],edge:{access:{pedestrian:true},classification:{use:'road'}}}]}));
test('long request timeouts scale with distance without changing the short-route default',()=>{
 assert.equal(R.timeoutMs(1000),18000);assert.equal(R.timeoutMs(20000),45000);assert.equal(R.timeoutMs(100000),60000);
});
test('intermediate search is geographically ordered and bounded, including date line crossings',()=>{
 const points=R.anchors(origin,target);assert.equal(points.length,2);assert.ok(points[0].lat>origin.lat&&points[1].lat<target.lat&&points[0].lat<points[1].lat);
 const wrap=R.anchors({lat:35,lng:179.9},{lat:35,lng:-179.9});assert.ok(Math.abs(wrap[0].lng)>179);
 assert.throws(()=>R.anchors(origin,{lat:45,lng:120}),{routeCode:'AppRouteLimit'});
 assert.throws(()=>R.anchors(origin,origin),{routeCode:'NoRoute'});
});

test('trips beyond the former 280 km cap use bounded larger segments below the provider input limit',async()=>{
 const akitsu={lat:35.7789,lng:139.4968},hiroshima={lat:34.3974,lng:132.4757};
 const via=R.anchors(akitsu,hiroshima),targets=[...via,hiroshima];let previous=akitsu;
 assert.ok(R.meters(akitsu,hiroshima)>280000);assert.ok(targets.length<=16);
 for(const point of targets){assert.ok(R.meters(previous,point)<=70001);previous=point;}
 let calls=0;const result=await R.segmented({start:akitsu,end:hiroshima,locate:async points=>located(points),route:async(a,b)=>{calls++;return leg(a,b)}});
 assert.equal(result.segmentCount,targets.length);assert.equal(calls,targets.length);assert.ok(result.distance>600000);
 const last={lat:35.54,lng:139};assert.ok(leg(origin,last,{distance:104000}).distance>100000);
 assert.doesNotThrow(()=>R.check(leg(origin,last,{distance:104000}),origin,last));
 // Provider limits apply to the input distance, not the returned road distance.
 const max=R.LIMITS.longPartMeters*R.LIMITS.parts;
 assert.ok(max===1120000);
});
test('locate requires explicit pedestrian access, connected roads, bounded offsets and no known restrictions',()=>{
 const base=located([origin]);assert.deepEqual(R.located([origin],base),[origin]);
 for(const change of [{access:{pedestrian:false}},{access:{}},{destination_only:true},{not_thru:true},{access_restriction:true},{classification:{use:'ferry'}},{start_restriction:{pedestrian:true}},{end_restriction:{pedestrian:true}}]){
   const data=structuredClone(base);Object.assign(data[0].edges[0].edge,change);assert.throws(()=>R.located([origin],data),{routeCode:'NoRoute'});
 }
 for(const change of [{inbound_reach:1},{outbound_reach:0},{access_restrictions:[{}]},{correlated_lat:40},{correlated_lon:NaN}]){
   const data=structuredClone(base);Object.assign(data[0].edges[0],change);assert.throws(()=>R.located([origin],data),{routeCode:'NoRoute'});
 }
 assert.throws(()=>R.located([origin],[]),{routeCode:'RouteResponse'});
});
test('segmented results contain only fetched continuous road geometry and summed API metrics',async()=>{
 let locatedCalls=0;const calls=[],progress=[];
 const result=await R.segmented({start:origin,end:target,locate:async points=>{locatedCalls++;return located(points)},route:async(a,b)=>{calls.push({a,b});return leg(a,b)},progress:t=>progress.push(t)});
 assert.equal(locatedCalls,1);assert.equal(calls.length,3);assert.equal(result.segmentCount,3);assert.equal(result.segmented,true);
 assert.deepEqual(calls[1].a,{lat:result.points[1][0],lng:result.points[1][1]});
 assert.ok(Math.abs(result.distance-calls.reduce((s,c)=>s+leg(c.a,c.b).distance,0))<.01);
 assert.equal(result.steps.filter(s=>s.maneuver.type==='arrive').length,1);assert.equal(result.steps.filter(s=>s.maneuver.type==='depart').length,1);
 assert.equal(result.points.length,4);assert.ok(progress.length>=3);
});

test('missing intermediate roads trigger bounded nearby searches and use verified road coordinates only',async()=>{
 let calls=0;const probes=[];
 const out=await R.segmented({start:origin,end:target,locate:async points=>{
   calls++;probes.push(points);return calls===1?points.map(()=>({edges:[]})):located(points);
 },route:async(a,b)=>leg(a,b)});
 assert.equal(calls,2);assert.equal(probes[1].length,probes[0].length*4);assert.equal(out.segmentCount,3);
 for(const p of out.points.slice(1,-1))assert.ok(probes[1].some(q=>q.lat===p[0]&&q.lng===p[1]));
});

test('unavailable intermediate roads never draw a partial route or expand API work without a limit',async()=>{
 let calls=0,routes=0;
 await assert.rejects(R.segmented({start:origin,end:target,locate:async points=>{calls++;return points.map(()=>({edges:[]}));},route:async()=>{routes++;}}),{routeCode:'NoRoute'});
 assert.equal(calls,3);assert.equal(routes,0);
 calls=0;await assert.rejects(R.segmented({start:origin,end:{lat:40,lng:139},locate:async points=>{calls++;return points.map(()=>({edges:[]}));},route:async()=>{routes++;}}),{routeCode:'NoRoute'});
 assert.equal(calls,1);assert.equal(routes,0);
});

test('malformed responses and cancellation during nearby intermediate searches stop without route requests',async()=>{
 let calls=0;
 await assert.rejects(R.segmented({start:origin,end:target,locate:async()=>{calls++;return [];},route:async()=>assert.fail('must not route')}),{routeCode:'RouteResponse'});
 assert.equal(calls,1);
 const controller=new AbortController();calls=0;
 await assert.rejects(R.segmented({start:origin,end:target,signal:controller.signal,locate:async points=>{
   if(++calls===1)return points.map(()=>({edges:[]}));controller.abort();return located(points);
 },route:async()=>assert.fail('must not route')}),{name:'AbortError'});assert.equal(calls,2);
});
test('the next leg uses the previous fetched road endpoint, rather than guessing a connecting segment',async()=>{
 let count=0,previous;const result=await R.segmented({start:origin,end:target,locate:async points=>located(points),route:async(a,b)=>{
   if(previous)assert.deepEqual(a,previous);
   const out=leg(a,b);if(count++===0){out.points.at(-1)[1]+=.0001;previous={lat:out.points.at(-1)[0],lng:out.points.at(-1)[1]};}else previous=undefined;return out;
 }});assert.equal(result.segmentCount,3);
});
test('disconnected legs are rejected and never joined with a synthetic straight line',async()=>{
 let count=0;await assert.rejects(R.segmented({start:origin,end:target,locate:async points=>located(points),route:async(a,b)=>{
   const out=leg(a,b);if(count++===1)out.points[0][1]+=.0001;return out;
 }}),{routeCode:'RouteGap'});
});
test('ferry, malformed shape, wrong endpoints and unreasonable detours are rejected',()=>{
 const end={lat:35.1,lng:139};
 for(const changes of [{steps:[{mode:'ferry'}]},{points:[[36,139],[36.1,139]]},{distance:1},{duration:NaN},{points:[[35,139]]}])assert.throws(()=>R.check(leg(origin,end,changes),origin,end),{routeCode:'RouteResponse'});
 assert.throws(()=>R.check(leg(origin,end,{distance:90000}),origin,end),{routeCode:'RouteDetour'});
});
test('failure of any segment returns an error and never presents the earlier partial route',async()=>{
 let calls=0;await assert.rejects(R.segmented({start:origin,end:target,locate:async points=>located(points),route:async(a,b)=>{
   if(++calls===2)throw Object.assign(Error('busy'),{httpStatus:429});return leg(a,b);
 }}),{httpStatus:429});assert.equal(calls,2);
});
test('timeouts settle a noncooperative provider and user cancellation discards late results',async()=>{
 let legs=0;await assert.rejects(R.segmented({start:origin,end:target,budgetMs:5,locate:()=>new Promise(()=>{}),route:()=>{legs++}}),{routeCode:'RouteTimeout'});assert.equal(legs,0);
 const controller=new AbortController();let release;
 const task=R.segmented({start:origin,end:target,signal:controller.signal,locate:points=>new Promise(resolve=>{release=()=>resolve(located(points))}),route:()=>{legs++}});
 controller.abort();await assert.rejects(task,{name:'AbortError'});release();await new Promise(setImmediate);assert.equal(legs,0);
 const already=new AbortController();already.abort();await assert.rejects(R.segmented({start:origin,end:target,signal:already.signal,locate:()=>{throw Error('must not call')}}),{name:'AbortError'});
});
test('large fetched geometries concatenate without argument-spread stack overflows',()=>{
 const middle={lat:35.1,lng:139},end={lat:35.2,lng:139};
 const points=(a,b)=>Array.from({length:60000},(_,i)=>[a.lat+(b.lat-a.lat)*i/59999,139]);
 const out=R.join([leg(origin,middle,{points:points(origin,middle)}),leg(middle,end,{points:points(middle,end)})],origin,end);
 assert.equal(out.points.length,119999);assert.equal(out.segmentCount,2);
});
const app=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8');
function appContext(extra={}){
 const choices=new Map(),c=vm.createContext({URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,LongRoutes:R,
  Date,Number,Math,Map,Set,map:{distance:(a,b)=>R.meters(Array.isArray(a)?{lat:a[0],lng:a[1]}:a,Array.isArray(b)?{lat:b[0],lng:b[1]}:b)},
  validCoordinates:(lat,lng)=>R.valid({lat,lng}),routeAccessCache:{areas:[]},routeChoices:choices,routeLayers:new Map(),routeLayer:null,
  ui:{'route-status':{},'route-details-content':{hidden:false}},routeEnabled:true,routeVersion:1,routeRequest:null,routeTimer:null,
  selectedRouteKind:'standard',walkingRouteMode:'standard',destination:target,routeAttributionAdded:true,
  ROUTE_KINDS:[{id:'standard'},{id:'gentle'},{id:'convenience'},{id:'nature'}],message:(el,text,error)=>Object.assign(el,{text,error}),setRouteBusy(){},renderRouteChoices(){},setRouteDetailsOpen(){},
  currentWalkingSpeed:()=>({kmh:4}),prepareRouteReplacement(){},routesEquivalent:()=>false,
  displayWalkingRoute:(route,kind)=>{c.shown=route;c.routeLayer={};choices.set(kind,{route})},...extra});
 vm.runInContext(app.slice(app.indexOf('function routeErrorMessage('),app.indexOf('function abortableRouteDelay(')),c);
 vm.runInContext(app.slice(app.indexOf('async function fetchWalkingRoute('),app.indexOf('function beginWalkingRoute(')),c);
 return c;
}
test('manual long routes ignore walking-time search settings, draw the route and avoid optional whole-route retries',async()=>{
 let calls=0;const c=appContext({calculateWalkingRoute:async()=>{calls++;return leg(origin,target)}});
 c.recoverLongWalkingRoute=()=>{throw Error('must not fallback')};await c.fetchWalkingRoute(origin,target,1);
 assert.equal(calls,1);assert.ok(c.shown.distance>100000);assert.equal(c.routeRequest,null);
});
test('long-route failures switch to recovery once, while short routes keep existing alternatives',async()=>{
 const c=appContext({calculateWalkingRoute:async()=>{throw Object.assign(Error('timeout'),{name:'AbortError'})}});let recovered=0;
 c.recoverLongWalkingRoute=async()=>{recovered++};await c.fetchWalkingRoute(origin,target,1);assert.equal(recovered,1);
 const kinds=[];const short=appContext({calculateWalkingRoute:async(a,b,k)=>{kinds.push(k);return leg(a,b)},findConvenienceStores:async()=>[],countConvenienceStores:()=>0,
  findConvenienceRoute:async()=>null,findNatureWaypoint:async()=>null});await short.fetchWalkingRoute(origin,{lat:35.01,lng:139},1);assert.deepEqual(kinds,['standard','gentle']);
});
test('retrieval failures and drawing failures have distinct messages and preserve a displayed route on failed updates',async()=>{
 const c=appContext();assert.match(c.routeErrorMessage({routeCode:'154'}),/遠すぎ/);assert.match(c.routeErrorMessage({name:'AbortError'}),/タイムアウト/);
 assert.match(c.routeErrorMessage({routeCode:442}),/経路が見つかりません/);assert.match(c.routeErrorMessage({httpStatus:502}),/通信に失敗/);
 c.routeLayer={existing:true};c.calculateWalkingRoute=async()=>{throw Error('network')};c.recoverLongWalkingRoute=async()=>{throw Error('network')};
 await c.fetchWalkingRoute(origin,target,1,'standard',true);assert.equal(c.routeLayer.existing,true);assert.equal(c.ui['route-status'].error,true);
 const broken=appContext({calculateWalkingRoute:async()=>leg(origin,target),displayWalkingRoute:()=>{throw Object.assign(Error('render'),{routeCode:'RouteDisplay',userMessage:'地図に表示できません'})}});
 broken.recoverLongWalkingRoute=()=>{throw Error('must not recover a rendering error')};await broken.fetchWalkingRoute(origin,target,1);assert.equal(broken.ui['route-status'].text,'地図に表示できません');
});
test('existing ORS recovery is used first and a missing server key can recover through bounded segments',async()=>{
 for(const hasORS of [true,false]){
  const c=appContext();let bridge=0,splits=0;
  c.fetchSuggestedWalkingRoutes=async()=>{bridge++;if(!hasORS)throw Object.assign(Error('missing key'),{routeCode:'ORS_NOT_CONFIGURED'})};
  c.LongRoutes={...R,segmented:async options=>{splits++;assert.deepEqual(options.start,origin);return {...leg(origin,target),segmented:true,segmentCount:3}}};
  vm.runInContext(app.slice(app.indexOf('async function recoverLongWalkingRoute('),app.indexOf('async function fetchWalkingRoute(')),c);
  const request={controller:new AbortController(),deadlineAt:Date.now()+10000};await c.recoverLongWalkingRoute(origin,target,request,()=>true,{routeCode:'DistanceExceeded',httpStatus:400});
  assert.equal(bridge,1);assert.equal(splits,hasORS?0:1);if(!hasORS)assert.equal(c.shown.segmented,true);
 }
 const c=appContext({fetchSuggestedWalkingRoutes:async()=>{throw Error('must not repeat a previously failed ORS lookup')},LongRoutes:{...R,segmented:async()=>({...leg(origin,target),segmented:true})}});
 vm.runInContext(app.slice(app.indexOf('async function recoverLongWalkingRoute('),app.indexOf('async function fetchWalkingRoute(')),c);
 await c.recoverLongWalkingRoute(origin,target,{controller:new AbortController(),deadlineAt:Date.now()+10000,skipORS:true},()=>true,{routeCode:'DistanceExceeded'});
 assert.equal(c.shown.segmented,true);
});
test('provider throttling and disconnected input regions never trigger repeated segment requests',async()=>{
 for(const primary of [{httpStatus:429},{httpStatus:503},{routeCode:171},{routeCode:170}]){
  const c=appContext({fetchSuggestedWalkingRoutes:async()=>{throw Error('ORS unavailable')},LongRoutes:{...R,segmented:()=>{throw Error('must not multiply requests')}}});
  vm.runInContext(app.slice(app.indexOf('async function recoverLongWalkingRoute('),app.indexOf('async function fetchWalkingRoute(')),c);
  const request={controller:new AbortController(),deadlineAt:Date.now()+10000};await assert.rejects(c.recoverLongWalkingRoute(origin,target,request,()=>true,primary),e=>e===primary);
 }
});
test('ORS timeout aborts its own request without disabling the parent or later fallback',async()=>{
 const c=appContext({MAP_PROXY_ENDPOINT:new URL('http://localhost:8000/api/overpass'),roundTripDestinationReached:false,
  setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5)),fetch:async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))});
 vm.runInContext(app.slice(app.indexOf('async function requestSuggestedRouteData('),app.indexOf('async function fetchSuggestedWalkingRoutes(')),c);
 const request={controller:new AbortController()};await assert.rejects(c.requestSuggestedRouteData(origin,target,'standard',request),{name:'AbortError'});assert.equal(request.controller.signal.aborted,false);
});
test('ORS response codes and HTTP status survive the bridge for appropriate fallback and messages',async()=>{
 const c=appContext({MAP_PROXY_ENDPOINT:new URL('http://localhost:8000/api/overpass'),roundTripDestinationReached:false,
  fetch:async()=>({ok:false,status:422,json:async()=>({error:'API distance limit',code:'ORS_LIMIT_EXCEEDED'})})});
 vm.runInContext(app.slice(app.indexOf('async function requestSuggestedRouteData('),app.indexOf('async function fetchSuggestedWalkingRoutes(')),c);
 await assert.rejects(c.requestSuggestedRouteData(origin,target,'standard',{controller:new AbortController()}),{routeCode:'ORS_LIMIT_EXCEEDED',httpStatus:422,userMessage:'API distance limit'});
});
module.exports={appContext,leg,origin,target,located};
