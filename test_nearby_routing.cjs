const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const R=require('./static/js/long-routes.js'),app=fs.readFileSync(__dirname+'/static/js/app.js','utf8');
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.textContent='';}
 append(...nodes){this.children.push(...nodes);} prepend(...nodes){this.children.unshift(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 get firstElementChild(){return this.children[0];} setAttribute(key,value){this[key]=value;}
 addEventListener(event,fn){this.listeners[event]=fn;} click(){if(!this.disabled)this.listeners.click?.();}
 querySelectorAll(selector){return this.children.flatMap(p=>[...(selector==='.'+p.className?[p]:[]),...p.querySelectorAll(selector)]);}
}
const start={lat:35,lng:139},goal={lat:35.02,lng:139,name:'Goal'},place={lat:35.005,lng:139.005,name:'Shop'};
function setup(){
 const doc=new Element('document'),fields=Object.fromEntries(['route-panel','route-status','nearby-convenience-status','route-details-content'].map(k=>[k,new Element('div')]));
 const c=vm.createContext({AbortController,DOMException,setTimeout,clearTimeout,Date,LongRoutes:R,document:doc,
   map:{distance:(a,b)=>R.meters(Array.isArray(a)?{lat:a[0],lng:a[1]}:a,Array.isArray(b)?{lat:b[0],lng:b[1]}:b),closePopup(){},getPane:()=>({style:{}})},
   L:{circleMarker:()=>({addTo(){return this},bindTooltip(){return this},remove(){c.removed=(c.removed||0)+1;}}),
      polyline:(points,options)=>({points,options,addTo(){c.line=this;return this;},remove(){this.removed=true;}})},
   window:{matchMedia:()=>({matches:true})},validCoordinates:(lat,lng)=>R.valid({lat,lng}),
   destination:{...goal},getStartPoint:()=>start,currentWalkingSpeed:()=>({kmh:4.5}),ui:fields,
   routeEnabled:false,routeAwaitingLocation:false,walkingRouteMode:'standard',roundTripOrigin:null,roundTripDestinationReached:false,
   routeVersion:1,routeRequest:null,routeTimer:null,routeLayer:null,routeChoices:new Map(),routeLayers:new Map(),selectedRouteKind:'standard',currentPosition:null,
   setRouteBusy(){},routeErrorMessage:e=>e.userMessage||e.message,
   message:(el,text,error)=>Object.assign(el,{textContent:text,error}),
   textElement:(tag,text='',cls='')=>Object.assign(new Element(tag),{textContent:text,className:cls}),
   WalkingTour:{deactivate(){c.deactivated=true;}},setRouteDetailsOpen:open=>{c.detailsOpen=open;},
   requestWalkingRoute:options=>{c.requests=(c.requests||[]).concat([options]);},
   beginWalkingRoute:()=>{c.started=(c.started||0)+1;c.routeEnabled=true;},routeDistance:n=>`${n}m`,routeDuration:n=>`${n/60}min`,
   prepareRouteReplacement:()=>{c.replacements=(c.replacements||0)+1;c.routeChoices.clear();},
   displayWalkingRoute:route=>{c.shown=route;c.routeLayer={};},
 });
 doc.createElement=tag=>new Element(tag);
 c.calculateWalkingRoute=async(a,b,kind,speed,request)=>({points:[[a.lat,a.lng],[b.lat,b.lng]],distance:R.meters(a,b),duration:R.meters(a,b)/speed*3.6,
   steps:[{mode:'walking',distance:R.meters(a,b),maneuver:{type:'depart'}},{mode:'walking',distance:0,maneuver:{type:'arrive'}}]});
 vm.runInContext(fs.readFileSync(__dirname+'/static/js/nearby-routing.js','utf8')+'\nglobalThis.api=NearbyRouting;',c);
 c.setDestination=p=>{c.api.clear();c.destination=p;};
 return c;
}
const request=()=>({controller:new AbortController(),automatic:true});
test('nearby choices never change a destination until selected and explain missing or identical destinations',()=>{
 const c=setup();c.destination=null;const box=c.api.actions(place),[destination,via,note]=box.children;
 assert.equal(via.disabled,true);assert.ok(note.textContent);via.click();assert.equal(c.requests,undefined);
 c.destination={...goal};box.refreshNearbyActions();assert.equal(via.disabled,false);assert.equal(note.hidden,true);
 assert.equal(c.destination.name,'Goal');destination.click();assert.equal(c.destination.name,'Shop');
 box.refreshNearbyActions();assert.equal(via.disabled,true);
});
test('choosing a via keeps the destination and start, starts a missing main route and removes only the extra route',()=>{
 const c=setup();c.api.select(place);assert.equal(c.destination.name,'Goal');assert.equal(c.api.via.name,'Shop');assert.equal(c.deactivated,undefined);
 assert.equal(c.started,1);assert.equal(c.requests,undefined);
 assert.equal(c.detailsOpen,false);const summary=c.ui['route-details-content'].firstElementChild;
 assert.ok(summary.firstElementChild.textContent.includes('Shop'));summary.children[1].click();
 assert.equal(c.api.via,null);assert.equal(summary.hidden,true);assert.equal(c.requests,undefined);
});
test('via routing uses two continuous fetched routes and adds actual road distance/time with one final arrival',async()=>{
 const c=setup();c.api.select(place);const calls=[];
 c.calculateWalkingRoute=async(a,b,k,s)=>{
   calls.push({a,b,k,s});const end=calls.length===1?{lat:b.lat,lng:b.lng+.00005}:b;
   return {points:[[a.lat,a.lng],[end.lat,end.lng]],distance:calls.length*1000,duration:calls.length*900,
     steps:[{distance:1000,mode:'walking',maneuver:{type:'depart'}},{distance:0,mode:'walking',maneuver:{type:'arrive'}}]};
 };
 await c.api.fetchRoute(start,goal,request(),()=>true);
 assert.equal(calls.length,2);assert.equal(calls[0].s,4.5);assert.equal(calls[1].a.lng,place.lng+.00005);
 assert.equal(c.api.route.points.length,3);assert.equal(c.api.route.distance,3000);assert.equal(c.api.route.duration,2700);
 assert.equal(c.api.route.steps.filter(s=>s.maneuver.type==='arrive').length,1);assert.equal(c.api.route.steps.filter(s=>s.maneuver.type==='depart').length,1);
 assert.ok(c.api.route.nearbyViaAlong>0);assert.equal(c.replacements,undefined);assert.equal(c.shown,undefined);assert.equal(c.destination.name,'Goal');
 assert.ok(!c.line.options.dashArray);assert.equal(c.line.options.color,'#E87524');
});
test('a failed leg or disconnected snap preserves the previous route and never draws a partial path',async()=>{
 for(const gap of [false,true]){
   const c=setup();c.api.select(place);c.routeChoices.set('old',{route:{distance:50}});let calls=0;const calc=c.calculateWalkingRoute;
   c.calculateWalkingRoute=async(...args)=>{if(++calls===2){if(!gap)throw Object.assign(Error('timeout'),{name:'AbortError'});args[0]={lat:35.01,lng:139};}return calc(...args);};
   await assert.rejects(c.api.fetchRoute(start,goal,request(),()=>true));assert.equal(c.replacements,undefined);assert.equal(c.shown,undefined);assert.ok(c.routeChoices.has('old'));
 }
});
test('changing a via, cancellation or clearing the destination discards late results',async()=>{
 for(const mode of ['change','abort','clear']){
   const c=setup();c.api.select(place);let release;const calc=c.calculateWalkingRoute;
   c.calculateWalkingRoute=(...args)=>new Promise(resolve=>{release=async()=>resolve(await calc(...args));});
   const req=request(),pending=c.api.fetchRoute(start,goal,req,()=>true);
   if(mode==='change')c.api.select({...place,lat:35.008});else if(mode==='abort')req.controller.abort();else c.api.clear();
   await release();await assert.rejects(pending,{name:'AbortError'});assert.equal(c.shown,undefined);
 }
});
test('automatic rerouting keeps an unpassed waypoint and consumes it only after confirmed route progress',async()=>{
 const c=setup();c.api.select(place);await c.api.fetchRoute(start,goal,request(),()=>true);
 c.currentPosition={...place,lat:place.lat+.0002};c.walkingRoutePosition=()=>({along:c.api.route.nearbyViaAlong+30,distance:100});
 c.api.advance();assert.ok(c.api.via);
 c.walkingRoutePosition=()=>({along:c.api.route.nearbyViaAlong-5,distance:0});c.api.advance();assert.ok(c.api.via);
 await c.api.fetchRoute({...start,lat:35.001},goal,request(),()=>true);assert.equal(c.api.route.nearbyVia.name,'Shop');
 c.walkingRoutePosition=()=>({along:c.api.route.nearbyViaAlong+25,distance:0});c.api.advance();assert.equal(c.api.via,null);
});
test('adding, failing and removing an extra route preserve the main layer, selection, metrics and mode',async()=>{
 const c=setup(),main={distance:900,points:[[35,139],[35.02,139]]},layer={bringToFront(){c.front=true;}};
 c.routeEnabled=true;c.routeLayer=layer;c.routeLayers.set('standard',layer);c.routeChoices.set('standard',{route:main});c.selectedRouteKind='gentle';c.walkingRouteMode='roundtrip';
 c.api.select(place);while(c.api.busy)await new Promise(setImmediate);
 assert.ok(c.api.route.nearbyVia);assert.equal(c.routeLayer,layer);assert.equal(c.routeChoices.get('standard').route,main);
 assert.equal(c.selectedRouteKind,'gentle');assert.equal(c.walkingRouteMode,'roundtrip');assert.equal(c.front,true);assert.equal(c.requests,undefined);
 const old=c.api.route;c.calculateWalkingRoute=async()=>{throw Error('API unavailable')};await c.api.update(true);
 assert.equal(c.api.route,old);assert.equal(c.api.busy,false);assert.equal(c.detailsOpen,true);assert.equal(c.ui['route-details-content'].firstElementChild.children[2].error,true);
 c.api.clear();assert.equal(c.routeLayer,layer);assert.equal(c.routeChoices.get('standard').route,main);assert.equal(c.line.removed,true);
});

test('a far final destination retains bounded pedestrian segmentation after a nearby stop',async()=>{
 const c=setup();c.api.select(place);const calc=c.calculateWalkingRoute;let splits=0;
 c.locateWalkingWaypoints=()=>{};
 c.LongRoutes={...R,segmented:async options=>{splits++;assert.equal(options.locate,c.locateWalkingWaypoints);assert.equal(options.start.lat,place.lat);return calc(options.start,options.end,'standard',4.5);}};
 c.calculateWalkingRoute=async(a,b,...rest)=>{if(b.lat===40)throw Object.assign(Error('limit'),{routeCode:'DistanceExceeded'});return calc(a,b,...rest);};
 await c.api.fetchRoute(start,{lat:40,lng:139},request(),()=>true);
 assert.equal(splits,1);assert.equal(c.api.route.nearbyVia.name,'Shop');assert.equal(c.api.route.points.at(-1)[0],40);
});

test('a missing main route is created first, then its display schedules the separate route once',async()=>{
 const c=setup();c.setTimeout=(fn,ms)=>setTimeout(fn,ms===500?0:ms);c.api.select(place);assert.equal(c.started,1);assert.equal(c.api.route,null);
 c.routeLayer={bringToFront(){}};c.routeChoices.set('standard',{route:{distance:900}});c.api.mainRouteChanged();
 while(!c.api.route)await new Promise(setImmediate);
 while(c.api.busy)await new Promise(setImmediate);
 assert.equal(c.routeChoices.get('standard').route.distance,900);let calls=0;c.calculateWalkingRoute=async()=>{calls++;throw Error('must not repeat')};
 c.api.mainRouteChanged();await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);c.api.clear();
});

test('multiple detours share an ordered route while keeping the main route intact',async()=>{
 const c=setup(),second={lat:35.009,lng:139.008,name:'Park'};
 c.api.select(place);c.api.select(second);
 const main={points:[[35,139],[35.02,139]],distance:2100};c.routeChoices.set('standard',{route:main});
 await c.api.update(true);
 assert.equal(c.api.stops.length,2);assert.equal(c.api.route.nearbyStops[1].name,'Park');
 assert.equal(c.api.route.points.length,4);assert.equal(c.routeChoices.get('standard').route,main);
 c.api.move(1,-1);await c.api.update(true);assert.equal(c.api.stops[0].name,'Park');
 c.api.remove(1);await c.api.update(true);assert.equal(c.api.stops.length,1);assert.equal(c.api.route.nearbyVia.name,'Park');c.api.clear();
});

test('map selection is explicit, accepts multiple points and never adds a stop during normal map taps',()=>{
 const c=setup();assert.equal(c.api.handleMapClick(place),false);assert.equal(c.api.stops.length,0);
 c.api.startPicking();assert.equal(c.api.handleMapClick(place),true);assert.equal(c.api.stops.length,1);
 c.api.handleMapClick(place);assert.equal(c.api.stops.length,1,'duplicate point');
 for(let i=0;i<8;i++)c.api.handleMapClick({lat:35.007+i*.001,lng:139.01,name:`Stop ${i}`});
 assert.equal(c.api.stops.length,5);c.api.stopPicking();assert.equal(c.api.handleMapClick({lat:35.015,lng:139.012}),false);c.api.clear();
});
