const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(`${__dirname}/static/js/app.js`, 'utf8');
const feature = readFileSync(`${__dirname}/static/js/route-nearby.js`, 'utf8');
function extract(first, next) {
  return source.slice(source.indexOf(`function ${first}(`), source.indexOf(`function ${next}(`)).replace(/async\s*$/, '');
}
function distance(a, b) {
  if (!Array.isArray(a)) a = [a.lat, a.lng];
  if (!Array.isArray(b)) b = [b.lat, b.lng];
  const rad = Math.PI / 180, dy = (b[0] - a[0]) * rad, dx = (b[1] - a[1]) * rad;
  const q = Math.sin(dy / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dx / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(q)));
}
function setup({ fastDeadline = false } = {}) {
  const route = { points: [[35.7787,139.4966], [35.7887,139.4966], [35.7887,139.5166]], distance: 3000 };
  const fields = Object.fromEntries(['nearby-scope','nearby-kind','nearby-convenience','clear-nearby-convenience','nearby-convenience-status']
    .map(id => [id, { value: '', hidden: false, setAttribute() {}, removeAttribute() {} }]));
  fields['nearby-scope'].value = 'route'; fields['nearby-kind'].value = 'cafe';
  const c = vm.createContext({ URL, Map, Set, AbortController, DOMException, setTimeout: (fn, ms) => setTimeout(fn, fastDeadline && ms === 30000 ? 15 : ms), clearTimeout,
    map: { distance }, validCoordinates: (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180,
    NEARBY_CONVENIENCE_RADIUS: 1000, ui: fields, nearbyConvenienceRequest: null,
    activeRouteKind: 'standard', routeChoices: new Map([['standard', { route }]]),
    busStopManifestCache: null, busStopPartsCache: new Map(), stationIndexCache: null, toiletIndexCache: null,
    BUS_STOP_INDEX_ENDPOINT: 'https://app.example/static/bus-stops-jp-2022-v1/index.json',
    STATION_INDEX_ENDPOINT: 'https://app.example/static/stations-jp-2025-v1.json', TOILET_INDEX_ENDPOINT: 'https://app.example/static/toilets-tokyo-2024-v1.json',
    loadRouteAccess: async () => ({ stations: [] }),
    fetchRouteJson: async url => JSON.parse(readFileSync(`${__dirname}${url.pathname}`, 'utf8')),
    message: (element, text, error = false) => { element.textContent = text; element.error = error; }, rendered: [],
  });
  vm.runInContext(extract('nearbyKindLabel','nearbyConvenienceArea'), c);
  vm.runInContext(extract('stationIndexFromData','fetchNearbyConvenienceData'), c);
  vm.runInContext(feature, c);
  c.clearNearbyConvenience = ({preserveRoute = false} = {}) => {
    c.cancelRouteNearby(preserveRoute);c.nearbyConvenienceRequest?.controller.abort();c.nearbyConvenienceRequest = null;
    c.ui['nearby-convenience-status'].textContent = '';c.rendered.length = 0;
  };
  c.showNearbyConvenience = places => {
    c.rendered.push(Array.from(places));c.savedPlaces = places;vm.runInContext('routeNearbyState.places = savedPlaces', c);
  };
  c.state = () => vm.runInContext('routeNearbyState', c);
  return c;
}

test('corridor follows bends and sparse segment middles, rather than the origin circle or route bounding rectangle', () => {
  const c = setup(), points = c.routeChoices.get('standard').route.points;
  const before = JSON.stringify(points), plan = c.routeNearbyPlan(points);
  assert.ok(c.routeNearbyPosition({lat:35.7887,lng:139.5106},plan).distance < 1);
  assert.ok(c.routeNearbyPosition({lat:35.7837,lng:139.5066},plan).distance > 500);
  assert.ok(c.routeNearbyPosition({lat:35.7817,lng:139.4966},plan).distance < 1);
  const long = c.routeNearbyPlan([[35,139],[35,140]]);
  assert.ok(c.routeNearbyPosition({lat:35,lng:139.5},long).distance < 1);
  assert.equal(JSON.stringify(points), before);
});

test('only matching, accessible places within 300m survive, ordered along the full route', () => {
  const c = setup(), plan = c.routeNearbyPlan(c.routeChoices.get('standard').route.points);
  const node = (id,lat,lng,tags={}) => ({type:'node',id,lat,lon:lng,tags:{amenity:'cafe',name:`Cafe ${id}`,...tags}});
  const places = c.nearbyConveniencePlaces([
    node(1,35.7887,139.5136), node(2,35.7797,139.4966), node(3,35.7837,139.5066),
    node(4,35.7807,139.4966,{access:'private'}),node(5,35.7807,139.4966,{disused:'yes'}),
    node(6,35.7807,139.4966,{amenity:'restaurant'}),node(7,35.7913,139.5086),node(8,35.7915,139.5086),
    node(9,35.7807,139.4966,{access:'permit'}),node(10,35.7807,139.4966,{access:'members'}),
  ],{lat:35.7787,lng:139.4966},'cafe',{plan});
  assert.deepEqual(Array.from(places,p=>p.name),['Cafe 2','Cafe 7','Cafe 1']);
  assert.ok(places.some(p=>p.distance>1000),'destinations beyond the start circle remain eligible');
  assert.ok(places.every(p=>p.distanceFromRoute<=300));
});

test('date-line geometry stays near the route instead of spanning the entire world', () => {
  const c = setup(), plan = c.routeNearbyPlan([[35,179.99],[35,-179.99]]);
  assert.ok(c.routeNearbyPosition({lat:35,lng:180},plan).distance<1);
  assert.equal(c.routeNearbyPosition({lat:35,lng:0},plan).distance,Infinity);
  assert.ok(plan.cells.size<20);
});

test('external queries cover the polyline with a margin, keep endpoints and split long detailed routes with overlap', () => {
  const c = setup(), plan = c.routeNearbyPlan(c.routeChoices.get('standard').route.points);
  const query = c.routeNearbyQueries(plan,'cafe')[0];
  assert.match(query,/around:360,35\.778700,139\.496600/);assert.match(query,/35\.788700,139\.516600/);
  assert.match(query,/amenity="cafe"/);assert.match(query,/private\|no\|permit\|members/);
  const points = Array.from({length:900},(_,i)=>[35+(i%2)*.001,139+i*.001]);
  const queries = c.routeNearbyQueries(c.routeNearbyPlan(points),'park');
  assert.ok(queries.length>1);assert.ok(queries.every(q=>q.length<200000));
  assert.ok(queries.at(-1).includes(points.at(-1)[1].toFixed(6)));
  assert.throws(()=>c.routeNearbyQueries(plan,'unknown'),/Invalid nearby category/);
});

test('real bundled route-side bus stops and Tokyo toilets avoid external APIs', async () => {
  for (const [kind,minimum] of [['bus_stop',5],['toilet',1]]) {
    const c = setup();c.ui['nearby-kind'].value = kind;
    c.routeChoices.set('standard',{route:{points:[[35.7787,139.4966],[35.7792,139.4995],[35.7823,139.5025]],distance:1000}});
    c.fetchDiscoveryMapData = async () => { throw Error('Must use local data'); };
    await c.searchRouteNearby();
    const places = c.rendered.at(-1);
    assert.ok(places.length>=minimum,kind);assert.equal(c.ui['nearby-convenience-status'].error,false);
    assert.ok(places.every(p=>p.distanceFromRoute<=300));assert.equal(c.ui['nearby-convenience'].disabled,false);
  }
});

test('external results stream, repeat lookups reuse data, and slight progress along a route reuses coverage', async () => {
  const c = setup();let calls=0;
  c.fetchDiscoveryMapData = async (query,request,timeout,retry) => {
    calls++;assert.equal(timeout,6000);assert.equal(retry,false);
    return [{type:'node',id:1,lat:35.7887,lon:139.5106,tags:{amenity:'cafe',name:'Along the route'}}];
  };
  await c.searchRouteNearby();assert.equal(c.rendered.at(-1).length,1);assert.equal(calls,1);
  c.clearNearbyConvenience();await c.searchRouteNearby();assert.equal(calls,1,'successful queries are cached');
  const oldPlan = c.state().last.plan;
  const next = c.routeNearbyPlan([[35.7792,139.4966],[35.7887,139.4966],[35.7887,139.5166]]);
  assert.equal(c.routeNearbyCovered(next,oldPlan),true);
  assert.equal(c.routeNearbyCovered(c.routeNearbyPlan([[35.7787,139.5066],[35.7887,139.5166]]),oldPlan),false);
  c.routeChoices.set('standard',{route:{points:next.points,distance:2900}});
  await c.searchRouteNearby();assert.equal(calls,1,'walking forward does not require another external lookup');
});

test('failure is not a confirmed empty result and can be retried', async () => {
  const c = setup();let calls=0;
  c.fetchDiscoveryMapData = async () => { calls++;throw Error('Unavailable'); };
  await c.searchRouteNearby();assert.equal(c.ui['nearby-convenience-status'].error,true);assert.equal(c.state().last.complete,false);
  c.fetchDiscoveryMapData = async () => { calls++;return []; };
  await c.searchRouteNearby();assert.equal(calls,2);assert.equal(c.ui['nearby-convenience-status'].error,false);
  assert.match(c.ui['nearby-convenience-status'].textContent,/地図データ/);
});

test('reusing a route snapshot does not extend the ten-minute data lifetime', async () => {
  const c = setup();let calls=0;
  c.now=1000000;vm.runInContext('Date.now=()=>now',c);
  c.fetchDiscoveryMapData = async () => { calls++;return [{type:'node',id:1,lat:35.7887,lon:139.5106,tags:{amenity:'cafe',name:'Cached'}}]; };
  await c.searchRouteNearby();const original=c.state().last.at;
  c.now=original+300000;
  await c.searchRouteNearby();assert.equal(calls,1);assert.equal(c.state().last.at,original);
  c.now=original+600001;await c.searchRouteNearby();assert.equal(calls,2);
});

test('a shortcut between nearby endpoints cannot reuse coverage across a sharp bend', () => {
  const c = setup();
  const original = c.routeNearbyPlan([[35,139],[35.00045,139.00054],[35,139.00108]]);
  const shortcut = c.routeNearbyPlan([[35,139],[35,139.00108]]);
  assert.equal(c.routeNearbyCovered(shortcut,original),false);
});

test('bounded parallel chunks stream valid places while a later chunk fails', async () => {
  const c = setup();let active=0,max=0,calls=0;
  const points=Array.from({length:850},(_,i)=>[35+(i%2)*.001,139+i*.001]);
  c.routeChoices.set('standard',{route:{points,distance:100000}});
  c.fetchDiscoveryMapData = async () => {
    const index=calls++;active++;max=Math.max(max,active);
    try {
      await new Promise(r=>setTimeout(r,index===0?2:15));
      if(index)throw Error('Later region unavailable');
      return [{type:'node',id:1,lat:points[2][0],lon:points[2][1],tags:{amenity:'cafe',name:'Available early'}}];
    }finally{active--;}
  };
  const search=c.searchRouteNearby();
  while(!c.rendered.some(group=>group.some(p=>p.name==='Available early')))await new Promise(r=>setImmediate(r));
  assert.ok(c.nearbyConvenienceRequest,'result is visible before completion');
  await search;assert.ok(max<=2);assert.ok(c.rendered.at(-1).some(p=>p.name==='Available early'));
  assert.match(c.ui['nearby-convenience-status'].textContent,/一部/);assert.equal(c.state().last.complete,false);
});

test('cancellation and changing the selected route discard late replies and do not cache them', async () => {
  for (const changeRoute of [false,true]) {
    const c = setup();let release;
    c.fetchDiscoveryMapData = async () => new Promise(resolve=>{release=resolve;});
    const pending = c.searchRouteNearby();while(!release)await new Promise(r=>setImmediate(r));
    if(changeRoute)c.routeChoices.set('standard',{route:{points:[[34,135],[34.1,135.1]]}});
    else c.clearNearbyConvenience();
    release([{type:'node',id:1,lat:35.7887,lon:139.5106,tags:{amenity:'cafe',name:'Late'}}]);await pending;
    assert.ok(!c.rendered.some(group=>group.some(p=>p.name==='Late')));
    assert.equal(vm.runInContext('routeNearbyCache.size',c),0);
  }
});

test('deadline reports an incomplete search and restores the button', async () => {
  const c = setup({fastDeadline:true});
  c.fetchDiscoveryMapData = async (query,request) => new Promise((resolve,reject)=>request.controller.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  await c.searchRouteNearby();assert.equal(c.ui['nearby-convenience'].disabled,false);assert.equal(c.ui['nearby-convenience-status'].error,true);
  assert.equal(vm.runInContext('routeNearbyCache.size',c),0);
});
