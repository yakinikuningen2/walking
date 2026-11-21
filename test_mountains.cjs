const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.cwd(),M=require(path.join(root,'static/js/mountain-core.js'));
const fuji={name:'富士山',lat:35.3628384,lng:138.7307677,kindId:'mountain'};
const access={name:'実データの登山口',lat:35.363,lng:138.731,kindId:'mountain_trailhead'};
const park={name:'公園',lat:35.364,lng:138.732,kindId:'park',key:'park/1'};
const source=fs.readFileSync(path.join(root,'static/js/app.js'),'utf8');
const element=(id,tags,extra={})=>({type:'node',id,lat:fuji.lat+.002,lon:fuji.lng+.002,tags,...extra});

test('summits, volcanoes, trailheads and fifth stations are distinct without relying on a particular mountain name',()=>{
 assert.equal(M.type(fuji),'summit');assert.equal(M.type({name:'別の山'},{natural:'volcano'}),'summit');
 assert.equal(M.type({name:'入口'},{highway:'trailhead'}),'trailhead');
 for(const name of ['五合目','５ 合 目','5th Station'])assert.equal(M.type({name},{place:'locality'}),'fifth');
 assert.equal(M.type({kindId:'mountain_fifth'}),'fifth');assert.equal(M.type({name:'山頂'},{natural:'peak'}),'summit');
});
test('ordinary stations, shops, shrines and parks are not converted into mountain destinations by their names',()=>{
 for(const [name,tags] of [['富士山駅',{railway:'station'}],['富士山公園',{leisure:'park'}],['五合目カフェ',{amenity:'cafe'}],['五合目売店',{shop:'convenience'}],['五合目神社',{amenity:'place_of_worship'}]])assert.equal(M.type({name},tags),'');
 assert.equal(M.type(park),'');
});
test('OSM access candidates preserve real coordinates, source identity and the unchanged mountain origin',()=>{
 const before=JSON.stringify(fuji),rows=[element(1,{name:'入口',highway:'trailhead'}),element(2,{name:'五合目',place:'locality'})];
 const result=M.parse(rows,fuji);assert.equal(result.places.length,2);assert.equal(JSON.stringify(fuji),before);
 assert.equal(result.places[0].lat,rows[0].lat);assert.equal(result.places[0].lng,rows[0].lon);
 assert.equal(result.places[0].sourceUrl,'https://www.openstreetmap.org/node/1');assert.equal(result.places[0].mountainOrigin.lat,fuji.lat);
 assert.equal(result.places[0].mountainType,'trailhead');assert.equal(result.places[1].mountainType,'fifth');
 assert.notEqual(result.places[0].lat,fuji.lat);
});
test('node, way and relation locations are supported; unnamed tagged trailheads remain real candidates',()=>{
 const rows=[element(1,{highway:'trailhead'}),{type:'way',id:2,center:{lat:fuji.lat+.003,lon:fuji.lng},tags:{name:'五合目広場',place:'locality'}},{type:'relation',id:3,center:{lat:fuji.lat+.004,lon:fuji.lng},tags:{name:'北登山口',highway:'trailhead'}}];
 const results=M.parse(rows,fuji).places;assert.equal(results.length,3);assert.equal(results[0].name,'名前のない登山口');
 assert.equal(results[2].sourceUrl,'https://www.openstreetmap.org/relation/3');
});
test('private, forbidden, conditional, closed, abandoned and difficult access points are excluded',()=>{
 const restrictions=[{access:'private'},{foot:'no'},{access:'permit'},{locked:'yes'},{opening_hours:'closed'},{construction:'yes'},{disused:'yes'},{'foot:conditional':'no @ (winter)'},{sac_scale:'hiking'},{sac_scale:'mountain_hiking'},{via_ferrata_scale:'1'}];
 assert.equal(M.parse(restrictions.map((r,i)=>element(i+1,{name:'登山口',highway:'trailhead',...r})),fuji).places.length,0);
});
test('unrelated facilities, invalid IDs and distant access points are not invented as access candidates',()=>{
 const rows=[element(1,{name:'五合目売店',shop:'convenience'}),element(2,{name:'近くの公園',leisure:'park'}),element(3,{name:'遠い登山口',highway:'trailhead'},{lat:fuji.lat+1}),element(0,{name:'登山口',highway:'trailhead'}),element(4,{name:'別の山頂',natural:'peak'})];
 assert.equal(M.parse(rows,fuji).places.length,0);
});
test('OSM duplicates are merged conservatively while geographically distinct entrances remain separate',()=>{
 const rows=[element(1,{name:'東登山口',highway:'trailhead'}),element(2,{name:'東登山口',highway:'trailhead'},{type:'way'}),element(3,{name:'東登山口',highway:'trailhead'},{lat:fuji.lat+.015})];
 assert.equal(M.parse(rows,fuji).places.length,2);
});
test('search query, result count and spatial range are bounded without interpolating user names',()=>{
 const query=M.query({...fuji,name:'";out body;'});assert.match(query,/around:15000/);assert.match(query,/timeout:7/);assert.match(query,/out center tags 161/);assert.doesNotMatch(query,/out body/);
 assert.throws(()=>M.query({lat:NaN,lng:0}));assert.throws(()=>M.parse(null,fuji));
 const rows=Array.from({length:161},(_,i)=>element(i+1,{name:`登山口${i}`,highway:'trailhead'}));assert.equal(M.parse(rows,fuji).limited,true);
});
test('summits cannot be routed as starts, destinations or waypoints',()=>{
 for(const args of [[park,fuji],[fuji,park],[park,access,[fuji]]])assert.throws(()=>M.guard(...args),{routeCode:'MOUNTAIN_SUMMIT'});
 assert.doesNotThrow(()=>M.guard(park,access));assert.doesNotThrow(()=>M.guard(park,{...park,lat:35.365}));
});
test('selecting a summit opens information/selection and does not mutate an existing destination',()=>{
 const previous={...park},opened=[];
 const c=vm.createContext({MountainCore:M,MountainDestinations:{open:p=>opened.push(p)},validCoordinates:(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng),destination:previous});
 vm.runInContext(source.slice(source.indexOf('function setDestination('),source.indexOf('function clearDestination(')),c);
 assert.equal(c.setDestination(fuji),false);assert.equal(c.destination,previous);assert.equal(opened[0],fuji);
});
test('actual walking requests keep hiking difficulty zero and refuse summit requests before API calls',async()=>{
 const payloads=[],c=vm.createContext({MountainCore:M,URL,loadRouteAccess:async()=>({areas:[]}),waitForRouteTurn:async()=>{},ROUTE_ENDPOINT:'https://provider.invalid/route',
  map:{distance:(a,b)=>M.meters(Array.isArray(a)?{lat:a[0],lng:a[1]}:a,Array.isArray(b)?{lat:b[0],lng:b[1]}:b)},
  fetchRouteJson:async url=>{payloads.push(JSON.parse(url.searchParams.get('json')));return {};},parseWalkingRoute:()=>({points:[[park.lat,park.lng],[access.lat,access.lng]],distance:200,duration:180})});
 vm.runInContext(source.slice(source.indexOf('async function calculateWalkingRoute('),source.indexOf('async function findNatureWaypoint(')),c);
 await assert.rejects(c.calculateWalkingRoute(park,fuji,'standard',4,{}),{routeCode:'MOUNTAIN_SUMMIT'});assert.equal(payloads.length,0);
 await c.calculateWalkingRoute(park,access,'standard',4,{});assert.equal(payloads.length,1);assert.equal(payloads[0].costing_options.pedestrian.max_hiking_difficulty,0);
});
test('mountain failures do not call ORS or segmented fallback with potentially different hiking policies',async()=>{
 const c=vm.createContext({MountainCore:M});
 vm.runInContext(source.slice(source.indexOf('async function fetchSuggestedWalkingRoutes('),source.indexOf('async function locateWalkingWaypoints(')),c);
 await assert.rejects(c.fetchSuggestedWalkingRoutes(park,access,'standard',{},()=>true),{routeCode:'MOUNTAIN_ROUTE'});
 vm.runInContext(source.slice(source.indexOf('async function recoverLongWalkingRoute('),source.indexOf('async function fetchWalkingRoute(')),c);
 await assert.rejects(c.recoverLongWalkingRoute(park,access,{},()=>true,{routeCode:'154'}),{routeCode:'MOUNTAIN_ROUTE'});
});
test('timeout, unavailable service and no route messages are distinguished for the selected type',()=>{
 assert.match(M.routeError({name:'AbortError'},access).userMessage,/タイムアウト/);
 assert.match(M.routeError({httpStatus:503},access).userMessage,/検索サービス/);
 assert.match(M.routeError({routeCode:'NoRoute'},{...access,mountainType:'fifth'}).userMessage,/五合目.*見つかりません/);
});
test('tour generation omits summit destinations but retains ordinary places and old course data helpers',()=>{
 const T=require(path.join(root,'static/js/tour-core.js'));
 const results=T.candidates([fuji,park],{lat:fuji.lat-.01,lng:fuji.lng});
 assert.equal(results.length,1);assert.equal(results[0].name,park.name);
});


test('Photon fallback preserves actual OSM identities and excludes same-name historical monuments',()=>{
 const feature=(id,key,value,name,coordinates=[fuji.lng+.01,fuji.lat+.01])=>({properties:{osm_id:id,osm_type:'N',osm_key:key,osm_value:value,name},geometry:{coordinates}});
 const elements=M.photonElements({features:[feature(1,'place','locality','五合目'),feature(2,'historic','monument','五合目 中宮'),feature(3,'shop','convenience','五合目売店'),feature(4,'place','locality','遠い五合目',[139.3,37])]});
 const result=M.parse(elements,fuji);assert.equal(result.places.length,1);assert.equal(result.places[0].name,'五合目');assert.equal(result.places[0].sourceUrl,'https://www.openstreetmap.org/node/1');
 assert.throws(()=>M.photonElements({error:'unavailable'}));assert.equal(M.photonElements({features:[{properties:{osm_id:-1},geometry:{coordinates:[0,0]}}]}).length,0);
});

test('a summit policy error retains its information-only explanation',()=>{
 let error;try{M.guard(park,fuji);}catch(e){error=e;}
 assert.equal(M.routeError(error,fuji),error);assert.match(error.userMessage,/地点情報/);
});


test('names alone never classify ordinary buildings as a fifth station; explicit access restrictions survive selection',()=>{
 assert.equal(M.type({name:'五合目マンション'}),'');assert.equal(M.type({name:'五合目 中宮'},{historic:'monument'}),'');
 const blocked=M.decorate({name:'西登山口',lat:fuji.lat+.01,lng:fuji.lng},{highway:'trailhead',access:'private'});
 assert.equal(blocked.mountainRestricted,true);assert.equal(M.metadata(blocked).mountainRestricted,true);
 assert.throws(()=>M.guard(park,blocked),{routeCode:'MOUNTAIN_ACCESS_RESTRICTED'});
});
