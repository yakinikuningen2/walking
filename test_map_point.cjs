const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {roadPoint,createResolver}=require('./static/js/map-point.js');
const {meters}=require('./static/js/walk-session-core.js');
const origin={lat:35,lng:139},point=n=>({lat:35+n/111195,lng:139});
const edge=(n=0,change={})=>({correlated_lat:point(n).lat,correlated_lon:139,inbound_reach:20,outbound_reach:20,
 edge:{access:{pedestrian:true},classification:{use:'footway'}},...change});
const data=(...items)=>[{edges:items}];
test('map selection uses the nearest pedestrian edge and excludes restricted/ferry/isolated/distant positions',()=>{
 const blocked=[edge(1,{edge:{access:{pedestrian:false}}}),edge(2,{edge:{access:{pedestrian:true},destination_only:true}}),
 edge(3,{edge:{access:{pedestrian:true},access_restriction:true}}),edge(4,{access_restrictions:[{}]}),
 edge(5,{edge:{access:{pedestrian:true},start_restriction:{pedestrian:true}}}),edge(6,{edge:{access:{pedestrian:true},classification:{use:'ferry'}}}),
 edge(7,{inbound_reach:0}),edge(151),edge(8,{correlated_lat:NaN})];
 assert.equal(roadPoint(origin,data(...blocked),meters),null);
 const p=roadPoint(origin,data(...blocked,edge(70),edge(20,{edge:{access:{pedestrian:true},not_thru:true}})),meters);
 assert.ok(p.offset>19&&p.offset<21);assert.equal(p.mapPoint,true);assert.ok(p.accessNote.includes('20m'));
});
test('empty results are distinct from malformed API responses',()=>{
 assert.equal(roadPoint(origin,data(),meters),null);assert.equal(roadPoint(origin,[{edges:null}],meters),null);
 for(const response of [{error:'busy'},[],[{}]])assert.throws(()=>roadPoint(origin,response,meters),{routeCode:'RouteResponse'});
});
test('access checks are bounded, cache only successful responses and do not repeat network errors',async()=>{
 let now=0,calls=0,fail=false;
 const resolve=createResolver({distance:meters,now:()=>now,locate:async(points,signal,options)=>{
  calls++;assert.equal(points.length,1);assert.equal(options.searchCutoff,200);assert.equal(options.timeoutMs,8000);
  if(fail)throw Error('offline');return data(edge());}});
 const s=new AbortController().signal;await resolve(origin,s);await resolve(origin,s);assert.equal(calls,1);
 now=300001;fail=true;await assert.rejects(resolve(origin,s));await assert.rejects(resolve(origin,s));assert.equal(calls,3);
});
test('negative results use a short cache, and cancellation discards late replies',async()=>{
 let now=0,calls=0;const resolve=createResolver({distance:meters,now:()=>now,locate:async()=>{calls++;return data();}});
 await resolve(origin,new AbortController().signal);await resolve(origin,new AbortController().signal);assert.equal(calls,1);
 now=30001;await resolve(origin,new AbortController().signal);assert.equal(calls,2);
 let release;const delayed=createResolver({distance:meters,locate:()=>new Promise(r=>{release=r;})}),controller=new AbortController();
 const pending=delayed(origin,controller.signal);controller.abort();release(data(edge()));await assert.rejects(pending,{name:'AbortError'});
});
class Element {
 constructor(){this.children=[];this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.textContent='';this.classList={toggle(){}};}
 append(...nodes){this.children.push(...nodes);}setAttribute(){}addEventListener(type,fn){this.listeners[type]=fn;}
 click(){if(!this.disabled)return this.listeners.click?.();}
}
function setup({routing=false,locate=async()=>data(edge())}={}){
 const goals=[],stops=[],requests=[],panels=[],listeners={};let popup;
 const c=vm.createContext({AbortController,DOMException,Date,setTimeout,clearTimeout,Map,
  map:{distance:meters,getSize:()=>({y:800})},document:{createElement:()=>new Element(),addEventListener(type,fn){listeners[type]=fn;}},
  L:{popup:()=>{const p={events:{},setLatLng(){return this;},setContent(content){this.content=content;panels.push(content);return this;},
   on(type,fn){this.events[type]=fn;return this;},openOn(){popup=this;return this;},remove(){this.events.remove?.();}};return p;}},
  loadRouteAccess:async()=>({areas:[]}),routeCrossesRestrictedArea:()=>false,
  locateWalkingWaypoints:async(...args)=>{requests.push(args);return locate(...args);},routeEnabled:routing,destination:routing?point(500):null,
  NearbyRouting:{stops,select:p=>stops.push(p),popupOpened(){},popupClosed(){}},
  setDestination:p=>goals.push(p),textElement:(_,text)=>Object.assign(new Element(),{textContent:text}),
  message:(target,text)=>{target.textContent=text;},validCoordinates:(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng),
 });
 vm.runInContext(fs.readFileSync(`${__dirname}/static/js/map-point.js`,'utf8')+'\nglobalThis.api=MapPointSelection;',c);
 return {c,goals,stops,requests,panels,listeners,get buttons(){return popup.content.children[1].children;},get status(){return popup.content.children[2].textContent;}};
}
test('a normal tap is read-only until the destination action is selected',async()=>{
 const s=setup();s.c.api.show(origin);assert.equal(s.requests.length,0);assert.equal(s.goals.length,0);
 assert.equal(s.buttons.length,1);await s.buttons[0].click();assert.equal(s.goals.length,1);assert.equal(s.requests.length,1);
});
test('during guidance a tap can add an independent via without changing the destination',async()=>{
 const s=setup({routing:true}),original=s.c.destination;s.c.api.show(origin);assert.equal(s.buttons.length,2);
 await s.buttons[1].click();assert.equal(s.stops.length,1);assert.equal(s.goals.length,0);assert.equal(s.c.destination,original);
});
test('moving to a nearby road requires a second explicit choice and uses the corrected point',async()=>{
 const s=setup({locate:async()=>data(edge(80))});s.c.api.show(origin);await s.buttons[0].click();
 assert.equal(s.goals.length,0);assert.ok(s.status.includes('80m'));assert.ok(s.buttons[0].textContent.includes('近くの道'));
 await s.buttons[0].click();assert.equal(s.goals.length,1);assert.ok(meters(s.goals[0],point(80))<1);assert.equal(s.requests.length,1);
});
test('no road and network failure have different messages and preserve the old destination',async()=>{
 const none=setup({routing:true,locate:async()=>data()});none.c.api.show(origin);await none.buttons[0].click();
 assert.ok(none.status.includes('見つかりません'));assert.equal(none.goals.length,0);
 const offline=setup({routing:true,locate:async()=>{throw Error('offline');}});offline.c.api.show(origin);await offline.buttons[0].click();
 assert.ok(offline.status.includes('通信エラー'));assert.equal(offline.goals.length,0);
});
test('a new tap cancels the previous choice and late results cannot update the destination',async()=>{
 let release;const s=setup({locate:()=>new Promise(r=>{release=r;})});s.c.api.show(origin);const pending=s.buttons[0].click();
 s.c.api.show(point(500));release(data(edge()));await pending;assert.equal(s.goals.length,0);assert.equal(s.status,'');
});
test('via actions do not apply after the route changes or when all five stops are occupied',async()=>{
 const s=setup({routing:true});s.c.api.show(origin);s.c.destination=point(600);await s.buttons[1].click();assert.equal(s.stops.length,0);assert.ok(s.status.includes('変わりました'));
 const full=setup({routing:true});full.stops.push(...Array(5).fill(point(300)));full.c.api.show(origin);await full.buttons[1].click();assert.equal(full.requests.length,0);
});

test('popup button clicks do not count as navigation merely because the body has data-view',async()=>{
 const s=setup();s.c.api.show(origin);const pending=s.buttons[0].click();
 const body={dataset:{view:'map'}};
 s.listeners.click({target:{closest(selector){return /(^|[,\s])\[data-view\]/.test(selector)?body:null;}}});
 await pending;assert.equal(s.goals.length,1);
});

test('restrictions for vehicles alone do not exclude a walkable road; pedestrian and impassable restrictions do',()=>{
 const vehicle=edge(5,{edge:{access:{pedestrian:true},access_restriction:true},access_restrictions:[{type:'max_height',pedestrian:false,truck:true}]});
 assert.ok(roadPoint(origin,data(vehicle),meters));
 const impassable=edge(5,{edge:{access:{pedestrian:true},classification:{surface:'impassable'}}});
 assert.equal(roadPoint(origin,data(impassable),meters),null);
 assert.equal(roadPoint(origin,data(edge(5,{access_restrictions:[{pedestrian:true}]})),meters),null);
});
test('known paid passage areas and private endpoint nodes are excluded',()=>{
 const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8'),ctx=vm.createContext({});
 vm.runInContext(source.slice(source.indexOf('function routeCrossesRestrictedArea('),source.indexOf('async function calculateWalkingRoute(')),ctx);
 const areas=JSON.parse(fs.readFileSync(`${__dirname}/static/route-access.json`,'utf8')).areas;
 const input={lat:35.77852,lng:139.49651};
 const inside={...edge(),correlated_lat:input.lat,correlated_lon:input.lng};
 const outside={...edge(),correlated_lat:input.lat+.0005,correlated_lon:input.lng};
 const result=roadPoint(input,data(inside,outside),meters,p=>ctx.routeCrossesRestrictedArea([[p.lat,p.lng],[p.lat,p.lng]],areas.map(a=>a.ring)));
 assert.ok(result.offset>50);
 const privateNode=data(edge());privateNode[0].nodes=[{lat:origin.lat,lon:origin.lng,private_access:true}];
 assert.equal(roadPoint(origin,privateNode,meters),null);
});

test('routing cannot silently stop on a different road far from a checked map destination',async()=>{
 const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8'),end=point(1000);
 const route={points:[[origin.lat,origin.lng],[point(1060).lat,139]],distance:1060,duration:1000,steps:[{mode:'walking',distance:1060,maneuver:{type:'depart'}}]};
 const c=vm.createContext({URL,ROUTE_ENDPOINT:'https://example.test/route',map:{distance:meters},
  loadRouteAccess:async()=>({areas:[]}),waitForRouteTurn:async()=>{},fetchRouteJson:async()=>({routes:[route]}),parseWalkingRoute:d=>d.routes[0]});
 vm.runInContext(source.slice(source.indexOf('async function calculateWalkingRoute('),source.indexOf('async function findNatureWaypoint(')),c);
 await assert.rejects(c.calculateWalkingRoute(origin,{...end,mapPoint:true},'standard',4,{controller:new AbortController()}),{routeCode:'RouteResponse'});
 assert.equal((await c.calculateWalkingRoute(origin,end,'standard',4,{controller:new AbortController()})).distance,1060);
 const Long=require('./static/js/long-routes.js');assert.throws(()=>Long.check(route,origin,{...end,mapPoint:true}),{routeCode:'RouteResponse'});
 assert.equal(Long.check(route,origin,end),route);
});
test('ORS fallback also rejects a checked map destination whose road endpoint is too far away',async()=>{
 const source=fs.readFileSync(`${__dirname}/static/js/app.js`,'utf8');
 const c=vm.createContext({loadRouteAccess:async()=>({areas:[]}),map:{distance:meters},requestSuggestedRouteData:async()=>({routes:[{id:'ors_standard',route:{points:[[35,139],[point(1060).lat,139]]}}]}),parseWalkingRoute:d=>d.routes[0]});
 vm.runInContext(source.slice(source.indexOf('async function fetchSuggestedWalkingRoutes('),source.indexOf('async function locateWalkingWaypoints(')),c);
 await assert.rejects(c.fetchSuggestedWalkingRoutes(origin,{...point(1000),mapPoint:true},'standard',{},()=>true),{routeCode:'NoRoute'});
});
