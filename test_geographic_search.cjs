const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const G=require('./static/js/geographic-core.js');
const app=fs.readFileSync(path.join(__dirname,'static/js/app.js'),'utf8');
const origin={lat:35.77,lng:139.49,name:'検索地点'};
const pt=(x,y=0)=>({lat:origin.lat+y/111195,lon:origin.lng+x/(111195*Math.cos(origin.lat*Math.PI/180))});
function setup(){
 let now=1000000,calls=[],photonCalls=0;
 const c=vm.createContext({GeographicCore:G,URL,URLSearchParams,AbortController,DOMException,Map,Set,Math,Number,Object,setTimeout,clearTimeout,
  Date:class extends Date{static now(){return now}},PlaceIdentity:require('./static/js/place-identity.js'),map:{distance:G.meters},
  validCoordinates:(lat,lng)=>G.point({lat,lng}),fetchRouteJson:async()=>({}),
  DISCOVERY_LOCAL_SOURCES:[],DISCOVERY_LOCAL_CLASSES:{},discoveryElevationCache:new Map(),lastSearchAt:0,
  SEARCH_ENDPOINT:'https://photon.komoot.io/api/',abortableRouteDelay:async()=>{},message(){},
  fetch:async url=>{photonCalls++;return c.photonReply(url)},L:{}});
 vm.runInContext(app.slice(app.indexOf('const SEASONAL_KIND_WORDS'),app.indexOf('const NEARBY_CONVENIENCE_RADIUS')),c);
 vm.runInContext(app.slice(app.indexOf('const DISCOVERY_DISTANCE_FACTOR'),app.indexOf('const WALKING_SETTINGS_KEY')),c);
 vm.runInContext(app.slice(app.indexOf('function discoveryText'),app.indexOf('function renderDiscoveryResults')),c);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'static/js/natural-discovery.js'),'utf8'),c);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'static/js/geographic-search.js'),'utf8')+';globalThis.geo=GeographicSearch;',c);
 c.fetchDiscoveryMapData=async(q,request,timeout,retry)=>{calls.push({q,timeout,retry});return c.reply(q,request)};
 return {c,calls,photonCount:()=>photonCalls,advance:ms=>now+=ms,request:()=>({controller:new AbortController(),deadlineAt:now+26000})};
}
function river(){return {type:'way',id:10,tags:{name:'実データ形式の川',waterway:'river'},geometry:[pt(100,-100),pt(100,100)]};}
function road(tags={highway:'footway',foot:'designated'}){return {type:'way',id:20,tags,geometry:[pt(80,-120),pt(80,120)]};}

test('explicit geographic sentences are parsed; ordinary facility names keep the normal search',()=>{
 for(const [q,kind,region]of [['富士山のふもと','foothill','富士山'],['富士山のふもとの公園','foothill','富士山'],['川沿いを歩きたい','river',''],['多摩川沿いを歩きたい','river','多摩川'],['東京の川沿いを歩きたい','river','東京'],['海が見える場所','sea',''],['海の近く','sea',''],['森の中','forest',''],['高尾山の周辺','mountain','高尾山'],['山の周辺','mountain','']]){
  const p=G.parse(q);assert.equal(p?.kind,kind,q);assert.equal(p.region,region,q);
 }
 for(const q of ['富士山','桜上水駅','海辺公園','川沿いカフェ','森の中ホテル','公園','神田川','富士山神社'])assert.equal(G.parse(q),null,q);
 assert.equal(G.parse('  富士山のふもと  ').region,'富士山');assert.equal(G.parse('a'.repeat(181)),null);
});
test('geographic Photon records retain OSM IDs, tags and real mapped coordinates',()=>{
 const records=G.photon({features:[{properties:{osm_type:'W',osm_id:42,name:'公園',osm_key:'leisure',osm_value:'park',state:'山梨県',extra:{wikidata:'Q42'}},geometry:{coordinates:[138.7,35.4]}}]});
 assert.equal(records[0].tags.wikidata,'Q42');assert.equal(records[0].type,'way');assert.equal(G.location(records[0]).lat,35.4);
 assert.equal(G.photon({features:[{properties:{osm_type:'N',osm_id:-1},geometry:{coordinates:[138,35]}}]}).length,0);assert.throws(()=>G.photon({error:'failure'}));
});
test('named mountains exclude station homonyms and distant homonyms require region selection',()=>{
 const e=(id,lat,tags)=>({type:'node',id,lat,lon:138.7,tags:{name:'富士山',...tags}});
 const r=G.regions([e(1,35.36,{natural:'volcano'}),e(2,35.48,{railway:'station'}),e(3,36.2,{natural:'peak'})],G.parse('富士山のふもと'));
 assert.equal(r.length,2);assert.equal(r[0].id,1);assert.ok(r.every(p=>!p.tags.railway));
});
test('broad areas require explicit scope; region coordinates are query origins, not destinations',()=>{
 const r=G.regions([{type:'relation',id:1,center:{lat:35,lon:138},extent:[137,36,139,34],tags:{name:'山梨県',place:'state'}}],G.parse('山梨県の森の中'));
 assert.equal(r[0].broad,true);const area=G.scope(G.parse('富士山のふもと'),origin);assert.equal(area.radius,30000);
 assert.equal(G.scope(G.parse('川沿いを歩きたい'),origin).radius,8000);assert.throws(()=>G.scope({},{}));
});
test('queries include all OSM types, bounded geometry and no user-supplied QL',()=>{
 const intent=G.parse('悪意"];node(0,0,90,180);のふもと'),area=G.scope(intent,origin),q=G.featureQuery(intent,area);
 assert.match(q,/nwr\(around:30000/);assert.equal([...q.matchAll(/out body geom (\d+)/g)].reduce((s,m)=>s+Number(m[1]),0),48);assert.match(q,/maxsize:8388608/);assert.ok(!q.includes('悪意'));assert.ok(!q.includes('node(0,0'));
 assert.match(G.featureQuery(G.parse('川沿いを歩きたい'),{...origin,radius:8000}),/waterway="stream"/);
 assert.throws(()=>G.accessQuery(Array(17).fill(origin),()=>''));
});
test('Overpass way/relation geometry without centre metadata remains searchable',()=>{
 assert.ok(G.location(river()));assert.ok(G.location({type:'relation',members:[{geometry:[null,pt(30)]}]}));assert.equal(G.location({geometry:[null]}),null);
});
test('river search resolves onto an actual public footway and never into the river',async()=>{
 const {c,calls,request}=setup(),intent=G.parse('川沿いを歩きたい');c.reply=async q=>q.includes('around:')?[river()]:[road()];
 const updates=[],r=await c.geo.collect(intent,G.scope(intent,origin),request(),p=>updates.push(p));
 assert.equal(r.places.length,1);const p=r.places[0];assert.equal(p.geoAccess,true);assert.equal(p.accessAnchor.id,20);
 assert.ok(G.meters(p,{lat:pt(80).lat,lng:pt(80).lon})<1);assert.ok(G.meters(p,{lat:pt(100).lat,lng:pt(100).lon})>15);
 assert.equal(updates[0].places[0].geoAccess,false);assert.equal(calls.length,2);assert.ok(calls.every(q=>q.retry===false&&q.timeout===6500));
 await c.geo.collect(intent,G.scope(intent,origin),request());assert.equal(calls.length,2,'warm result avoids APIs');
});
test('private paths, locked entries and difficult trails are not eligible endpoints',async()=>{
 for(const tags of [{highway:'footway',access:'private'},{highway:'path',sac_scale:'mountain_hiking'},{highway:'path',foot:'no'},{highway:'footway',locked:'yes'}]){
  const {c,request}=setup(),i=G.parse('川沿いを歩きたい');c.reply=async q=>q.includes('around:')?[river()]:[road(tags)];
  const r=await c.geo.collect(i,G.scope(i,origin),request());assert.equal(r.places[0].geoAccess,false);
 }
});
test('unresolved geographic centres cannot be destinations or trigger automatic distance lookups',()=>{
 assert.equal(G.unresolved({geographicSearch:true,geoAccess:false}),true);assert.equal(G.unresolved({kindId:'park'}),false);
 assert.match(app,/GeographicCore\.unresolved\(place\)\) return false/);
 assert.match(fs.readFileSync(path.join(__dirname,'static/js/candidate-distances.js'),'utf8'),/GeographicCore\.unresolved\(place\)/);
});
test('fallback is one bounded, radius-limited Photon request and retains information-only results',async()=>{
 const {c,request,photonCount}=setup();c.reply=async()=>{throw Error('Overpass unavailable')};
 c.photonReply=async url=>{assert.equal(url.pathname,'/reverse');assert.equal(url.searchParams.get('radius'),'8');assert.equal(url.searchParams.getAll('osm_tag').length,2);
  return {ok:true,json:async()=>({features:[{properties:{osm_type:'W',osm_id:10,name:'川',osm_key:'waterway',osm_value:'river'},geometry:{coordinates:[pt(100).lon,pt(100).lat]}}]})};};
 const i=G.parse('川沿いを歩きたい'),r=await c.geo.collect(i,G.scope(i,origin),request());assert.equal(r.sourceFailed,true);assert.equal(r.places[0].geoAccess,false);assert.equal(photonCount(),1);
});
test('empty results and API failures are distinguishable; access errors preserve the real features',async()=>{
 const {c,request}=setup(),i=G.parse('川沿いを歩きたい'),area=G.scope(i,origin);c.reply=async()=>[];
 const empty=await c.geo.collect(i,area,request());assert.equal(empty.places.length,0);assert.equal(empty.sourceFailed,false);
 const b=setup();b.c.reply=async q=>{if(q.includes('around:'))return [river()];throw Error('unavailable')};
 const partial=await b.c.geo.collect(i,area,b.request());assert.equal(partial.accessFailed,true);assert.equal(partial.places.length,1);assert.equal(partial.places[0].geoAccess,false);
});
test('aborted searches never fall back or write reusable results',async()=>{
 const {c,request,photonCount,calls}=setup(),r=request(),i=G.parse('川沿いを歩きたい');c.reply=async()=>{r.controller.abort();throw new DOMException('Aborted','AbortError')};
 await assert.rejects(c.geo.collect(i,G.scope(i,origin),r),{name:'AbortError'});assert.equal(photonCount(),0);assert.equal(calls.length,1);
});
test('cache includes region and intent; mountain summit and inland facilities do not leak into nature candidates',async()=>{
 const {c,request,calls}=setup(),i=G.parse('川沿いを歩きたい');c.reply=async()=>[];
 await c.geo.collect(i,G.scope(i,origin),request());await c.geo.collect(i,G.scope(i,{...origin,lng:origin.lng+.1}),request());assert.equal(calls.length,2);
 const a=G.scope(G.parse('富士山のふもと'),origin);
 assert.equal(G.accept({type:'node',id:1,...pt(10000),tags:{natural:'peak'}},G.parse('富士山のふもと'),a),false);
 assert.equal(G.accept({type:'node',id:2,...pt(1000),tags:{leisure:'park'}},G.parse('海が見える場所'),a),false);
 assert.match(G.relevance(G.parse('海が見える場所'),origin,true),/眺望は未確認/);
});

test('missing OSM IDs and known freshwater marinas are rejected; invalid access anchors stay informational',()=>{
 const {c}=setup(),i=G.parse('海が見える場所'),area=G.scope(i,origin);
 assert.equal(G.accept({type:'node',...pt(1000),tags:{natural:'beach'}},i,area),false);
 assert.equal(G.accept({type:'node',id:1,...pt(1000),tags:{leisure:'marina',water:'lake'}},i,area),false);
 const p=c.geo.convert(river(),G.parse('川沿いを歩きたい'),area,{naturalAccess:{point:origin,anchorType:'way',anchorId:-1}});
 assert.equal(p.geoAccess,false);
});

test('failure of both services propagates as an error and is never cached as no results',async()=>{
 const {c,request,calls}=setup(),i=G.parse('川沿いを歩きたい'),area=G.scope(i,origin);
 c.reply=async()=>{throw Error('Overpass unavailable')};c.photonReply=async()=>({ok:false,status:503});
 await assert.rejects(c.geo.collect(i,area,request()),{httpStatus:503});
 c.reply=async()=>[];const next=await c.geo.collect(i,area,request());assert.equal(next.places.length,0);assert.equal(next.sourceFailed,false);assert.equal(calls.length,2);
});

test('very complex shapes remain informational instead of blocking the map with access geometry work',async()=>{
 const {c,request,calls}=setup(),i=G.parse('川沿いを歩きたい');
 const f={...river(),geometry:Array.from({length:1201},(_,n)=>pt(100,n/10))};c.reply=async()=>[f];
 const r=await c.geo.collect(i,G.scope(i,origin),request());assert.equal(r.places.length,1);assert.equal(r.places[0].geoAccess,false);assert.equal(calls.length,1);
});
