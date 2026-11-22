const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/static/js/app.js`, 'utf8');
const access = JSON.parse(readFileSync(`${__dirname}/static/route-access.json`, 'utf8'));
test('Valhalla uses the controlled Python relay without direct fallback or unrelated headers', async () => {
  const calls=[];
  const c=vm.createContext({URL,AbortController,DOMException,setTimeout,clearTimeout,MAP_PROXY_ENDPOINT:'https://app.example/api/overpass',DISCOVERY_MAP_ENDPOINTS:[],fetchMapProxy:async()=>null,
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({})};}});
  vm.runInContext(source.slice(source.indexOf('async function fetchRouteJson('),source.indexOf('async function waitForRouteTurn(')),c);
  for(const url of ['https://valhalla1.openstreetmap.de/route?json=%7B%7D','https://photon.komoot.io/api/']){
    await c.fetchRouteJson(new URL(url),{controller:new AbortController()});
  }
  assert.equal(calls[0].url.href,'https://app.example/api/valhalla');assert.equal(calls[0].options.method,'POST');
  assert.equal(JSON.parse(calls[0].options.body).action,'route');assert.equal(calls[0].options.headers['X-Client-Id'],undefined);
  assert.equal(calls[1].options.headers,undefined);
});

test('an unavailable routing relay or cancelled request never falls back to a direct provider call',async()=>{
 const calls=[],c=vm.createContext({URL,AbortController,DOMException,setTimeout,clearTimeout,MAP_PROXY_ENDPOINT:'http://127.0.0.1:8000/api/overpass',DISCOVERY_MAP_ENDPOINTS:[],
   fetchMapProxy:()=>{throw Error('must not use map fallback')},fetch:async(url,options)=>{calls.push(url.href);return{status:404}}});
 vm.runInContext(source.slice(source.indexOf('async function fetchRouteJson('),source.indexOf('async function waitForRouteTurn(')),c);
 const url=new URL('https://valhalla1.openstreetmap.de/locate?json=%7B%7D');
 await assert.rejects(c.fetchRouteJson(url,{controller:new AbortController()}),{routeCode:'ROUTING_RELAY_REQUIRED'});
 assert.deepEqual(calls,['http://127.0.0.1:8000/api/valhalla']);
 const controller=new AbortController();controller.abort();await assert.rejects(c.fetchRouteJson(url,{controller}),{name:'AbortError'});assert.equal(calls.length,1);
});
const stations = JSON.parse(readFileSync(`${__dirname}/static/stations-jp-2025-v1.json`, 'utf8'));
const busManifest = JSON.parse(readFileSync(`${__dirname}/static/bus-stops-jp-2022-v1/index.json`, 'utf8'));
const toiletData = JSON.parse(readFileSync(`${__dirname}/static/toilets-tokyo-2024-v1.json`, 'utf8'));
function functionSource(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}
function setup() {
  const context = vm.createContext({ URL, URLSearchParams, Number, Math, Map, Set, AbortController, DOMException, setTimeout, clearTimeout,
    lastSearchAt: 0, SEARCH_ENDPOINT: "https://photon.komoot.io/api/",
    PlaceIdentity: require('./static/js/place-identity.js'),
    NEARBY_CONVENIENCE_RADIUS: 2000, NEARBY_CONVENIENCE_TIMEOUT_MS: 10000, NEARBY_CONVENIENCE_LOOKUP_TIMEOUT_MS: 5000,
    ROUTE_ACCESS_ENDPOINT: 'https://app.example/static/route-access.json', routeAccessCache: access,
    STATION_INDEX_ENDPOINT: 'https://app.example/static/stations-jp-2025-v1.json', stationIndexCache: null,
    BUS_STOP_INDEX_ENDPOINT: 'https://app.example/static/bus-stops-jp-2022-v1/index.json',
    busStopManifestCache: null, busStopPartsCache: new Map(),
    TOILET_INDEX_ENDPOINT: 'https://app.example/static/toilets-tokyo-2024-v1.json', toiletIndexCache: null,
    validCoordinates: (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180,
    map: { distance(a, b) {
      if (Array.isArray(a)) a = { lat: a[0], lng: a[1] };
      if (Array.isArray(b)) b = { lat: b[0], lng: b[1] };
      return Math.hypot((a.lat - b.lat) * 111195, (a.lng - b.lng) * 90000);
    } },
  });
  vm.runInContext(functionSource('routeCrossesRestrictedArea', 'calculateWalkingRoute').replace(/async\s*$/, ''), context);
  vm.runInContext(functionSource('nearbyKindLabel', 'nearbyConvenienceArea'), context);
  vm.runInContext(functionSource('abortableRouteDelay', 'fetchMapProxy').replace(/async\s*$/, ''), context);
  vm.runInContext(functionSource('parseWalkingRoute', 'syncRouteLayers'), context);
  vm.runInContext(`${functionSource('stationIndexFromData', 'fetchNearbyConvenienceData').replace(/async\s*$/, '')}`, context);
  return context;
}

test('nearby stations preserve photo identity and load popup photos only when opened', () => {
  const c=setup(), mounts=[],layers=[];
  c.PlacePhotos={hints:require('./static/js/place-photos.js').hints,mount:(container,place)=>mounts.push({container,place})};
  const origin={lat:35.7787,lng:139.4966};
  const [place]=c.nearbyConveniencePlaces([{type:'node',id:1,lat:origin.lat,lon:origin.lng,
    tags:{railway:'station',name:'秋津',wikidata:'Q123','name:en':'Akitsu Station'}}],origin,'station');
  assert.equal(place.kindId,'station');assert.equal(place.kindLabel,'駅');
  assert.equal(place.photoHints.wikidata,'Q123');assert.equal(place.photoHints['name:en'],'Akitsu Station');
  const element=()=>({children:[],append(...items){this.children.push(...items)}});
  c.document={createElement:element};c.textElement=(tag,text)=>({tag,text});c.destinationButton=()=>({type:'destination'});
  c.nearbyConvenienceMarkers={clearLayers(){layers.length=0},getLayers:()=>layers,removeLayer(){}};
  c.map.getPane=()=>({style:{}});
  c.ui={'convenience-legend':{querySelector:()=>({classList:{toggle(){}}})},'nearby-legend-label':{}};
  c.L={divIcon:()=>({}),marker:(point,options)=>({options,handlers:{},addTo(){layers.push(this);return this},
    bindTooltip(){return this},bindPopup(popup){this.popup=popup;return this},on(name,handler){this.handlers[name]=handler;return this}})};
  vm.runInContext(functionSource('nearbyMarkerKey','cachedNearbyElements').replace(/async\s*$/,''),c);
  c.showNearbyConvenience([place],'station');assert.equal(mounts.length,0);
  layers[0].handlers.popupopen();assert.equal(mounts.length,1);assert.equal(mounts[0].place,place);
});

test('Akitsu paid passage is blocked between exterior endpoints while the public detour remains usable', () => {
  const c = setup(), rings = access.areas.map(area => area.ring);
  const paid = [[35.77859, 139.496533], [35.778473, 139.496485], [35.778435, 139.496471]];
  const detour = [[35.778918, 139.4968], [35.778347, 139.49786], [35.777959, 139.498732], [35.778235, 139.496767]];
  assert.equal(c.routeCrossesRestrictedArea(paid, rings), true);
  assert.equal(c.routeCrossesRestrictedArea(detour, rings), false);
  const route = points => ({ routes: [{ distance: 432, duration: 390,
    geometry: { type: 'LineString', coordinates: points.map(p => [p[1], p[0]]) },
    legs: [{ steps: [{ mode: 'walking', distance: 432, maneuver: { type: 'depart' } }] }] }] });
  assert.throws(() => c.parseWalkingRoute(route(paid)), /Paid station passage/);
  assert.equal(c.parseWalkingRoute(route(detour)).points.length, detour.length);
});

test('nearby stations exclude other facilities, abandoned/private stations and distant results, with Japanese labels', () => {
  const c = setup(), origin = { lat: 35.7787, lng: 139.4966 };
  const node = (id, tags, lat = origin.lat + .001) => ({ type: 'node', id, lat, lon: origin.lng, tags });
  const list = [node(1, { railway: 'station', name: 'Akitsu', 'name:ja': '秋津' }),
    node(2, { railway: 'station', name: 'Akitsu', 'name:ja': '秋津' }, origin.lat + .0011),
    node(3, { railway: 'halt', name: '別の駅' }, origin.lat + .003),
    node(4, { shop: 'convenience', name: 'コンビニ' }), node(5, { railway: 'station', access: 'private' }),
    node(6, { railway: 'station', disused: 'yes' }), node(7, { railway: 'station' }, origin.lat + .1)];
  const places = c.nearbyConveniencePlaces(list, origin, 'station');
  assert.deepEqual(Array.from(places, place => place.name), ['秋津', '別の駅']);
  assert.deepEqual(Array.from(c.nearbyConveniencePlaces(list, origin), place => place.name), ['コンビニ']);
});

test('station lookup uses the existing map provider with a bounded rounded area and preserves cancellation', async () => {
  const c = setup(), calls = [];
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  c.fetchDiscoveryMapData = async (...args) => { calls.push(args); return []; };
  c.fetchRouteJson = async () => { throw new Error('Local index unavailable'); };
  const request = { controller: new AbortController() };
  await c.fetchNearbyConvenienceData({ bounds: '35.77,139.48,35.79,139.51' }, request, 'station');
  assert.match(calls[0][0], /railway~"\^\(station\|halt\)\$"/);
  assert.match(calls[0][0], /35.77,139.48,35.79,139.51/);
  assert.equal(calls[0][1], request);
  assert.equal(calls[0][2], 10000);
  assert.equal(calls[0][3], false);
});

test('nearby toilets include unnamed public facilities and exclude private, closed, invalid and distant places', () => {
  const c = setup(), origin = { lat: 35.7787, lng: 139.4966 };
  const node = (id, tags, lat = origin.lat + .001) => ({ type: 'node', id, lat, lon: origin.lng, tags });
  const list = [node(1, { amenity: 'toilets' }),
    { type: 'way', id: 2, center: { lat: origin.lat + .002, lon: origin.lng }, tags: { amenity: 'toilets', 'name:ja': '公園トイレ', name: 'Park toilet' } },
    ...['private', 'no', 'customers', 'permit', 'members'].map((access, i) => node(i + 3, { amenity: 'toilets', access })),
    node(10, { amenity: 'toilets', opening_hours: 'closed' }), node(11, { amenity: 'toilets', disused: 'yes' }),
    node(12, { amenity: 'toilets', abandoned: 'yes' }), node(13, { amenity: 'toilets' }, origin.lat + .1),
    node(14, { shop: 'convenience' }), node(15, { amenity: 'toilets' }, NaN)];
  assert.deepEqual(Array.from(c.nearbyConveniencePlaces(list, origin, 'toilet'), place => place.name), ['トイレ', '公園トイレ']);
});

test('bus stops include bus platforms and terminals while preserving opposite stops and excluding railway-only platforms', () => {
  const c = setup(), origin = { lat: 35.7787, lng: 139.4966 };
  const node = (id, tags, offset) => ({ type: 'node', id, lat: origin.lat + offset, lon: origin.lng, tags });
  const list = [node(1, { highway: 'bus_stop', name: '中央通り' }, .001),
    node(2, { public_transport: 'platform', bus: 'yes', name: '中央通り' }, .00102),
    node(3, { highway: 'bus_stop', name: '中央通り' }, .00115),
    node(4, { public_transport: 'platform', bus: 'yes' }, .002),
    node(5, { amenity: 'bus_station', name: 'バスターミナル' }, .003),
    node(6, { public_transport: 'platform', train: 'yes' }, .004),
    node(7, { public_transport: 'stop_position', bus: 'yes' }, .004),
    node(8, { highway: 'bus_stop', access: 'private' }, .005),
    node(9, { highway: 'bus_stop', disused: 'yes' }, .005),
    node(10, { highway: 'bus_stop' }, .1)];
  assert.deepEqual(Array.from(c.nearbyConveniencePlaces(list, origin, 'bus_stop'), place => place.name),
    ['中央通り', '中央通り', 'バス停', 'バスターミナル']);
});

test('toilet and bus stop lookups use bounded category queries without slow geocoding or automatic retries', async () => {
  const c = setup(), calls = [], request = { controller: new AbortController() };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  c.fetchRouteJson = async () => { throw Error('Geocoding must not delay these categories'); };
  c.fetchDiscoveryMapData = async (...args) => { calls.push(args); return []; };
  const bounds = '35.77,139.48,35.79,139.51';
  for (const kind of ['toilet', 'bus_stop']) assert.equal((await c.fetchNearbyConvenienceData({ bounds }, request, kind)).length, 0);
  assert.match(calls[0][0], /amenity="toilets"/);
  assert.match(calls[1][0], /highway="bus_stop"/);
  assert.match(calls[1][0], /public_transport="platform"\]\[bus="yes"/);
  assert.match(calls[1][0], /amenity="bus_station"/);
  assert.doesNotMatch(calls[1][0], /stop_position/);
  for (const args of calls) {
    assert.ok(args[0].includes(bounds)); assert.ok(args[0].includes('private|no|customers|permit|members'));
    assert.equal(args[1], request); assert.equal(args[2], 10000); assert.equal(args[3], false);
    assert.equal(args[4].providerDelayMs, 1000);
  }
  c.fetchDiscoveryMapData = async () => { throw Error('Provider failed'); };
  await assert.rejects(c.fetchNearbyConvenienceData({ bounds }, request, 'toilet'), /Provider failed/);
});

test('nearby caches reuse each new category independently and discard cancelled or failed lookups', async () => {
  const c = setup(), calls = [], area = { key: '35.778,139.496' };
  vm.runInContext(`async ${functionSource('cachedNearbyElements', 'searchNearbyConvenience').replace(/async\s*$/, '')}`, c);
  c.nearbyConvenienceCache = new Map();
  c.nearbyConvenienceRequest = { controller: new AbortController() };
  c.fetchNearbyConvenienceData = async (area, request, kind) => { calls.push(kind); return [{ tags: { name: kind } }]; };
  for (const kind of ['toilet', 'bus_stop', 'toilet', 'bus_stop']) {
    const rows = await c.cachedNearbyElements(area, c.nearbyConvenienceRequest, kind);
    assert.equal(rows[0].tags.name, kind);
  }
  assert.deepEqual(calls, ['toilet', 'bus_stop']);
  c.nearbyConvenienceCache.clear();
  c.fetchNearbyConvenienceData = async (area, request) => { request.controller.abort(); return []; };
  await assert.rejects(c.cachedNearbyElements(area, c.nearbyConvenienceRequest, 'toilet'), { name: 'AbortError' });
  assert.equal(c.nearbyConvenienceCache.size, 0);
  c.nearbyConvenienceRequest = { controller: new AbortController() };
  c.fetchNearbyConvenienceData = async () => { throw Error('Unavailable'); };
  await assert.rejects(c.cachedNearbyElements(area, c.nearbyConvenienceRequest, 'bus_stop'), /Unavailable/);
  assert.equal(c.nearbyConvenienceCache.size, 0);
});

test('the bundled station index finds Akitsu and Tokyo without external queries and is reused in other areas', async () => {
  const c = setup(), requests = [];
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  c.fetchRouteJson = async (url, request, timeout) => { requests.push({ url: String(url), timeout }); return stations; };
  c.fetchDiscoveryMapData = async () => { throw new Error('No external map query should be needed'); };
  const request = { controller: new AbortController() };
  const area = { bounds: '35.768,139.483,35.790,139.511' };
  const first = await c.fetchNearbyConvenienceData(area, request, 'station');
  const names = Array.from(c.nearbyConveniencePlaces(first, { lat: 35.7787, lng: 139.4966 }, 'station'), place => place.name);
  assert.ok(names.includes('秋津') && names.includes('新秋津'));
  const city = await c.fetchNearbyConvenienceData({ bounds: '35.670,139.754,35.692,139.780' }, request, 'station');
  assert.ok(Array.from(city, station => station.tags.name).includes('東京'));
  assert.equal(requests.length, 1, 'other areas and repeat searches reuse the same local spatial index');
  assert.ok(requests[0].url.startsWith('https://app.example/static/'));
  assert.equal(requests[0].timeout, 4000);
  assert.ok(stations.stations.length > 9000);
});

test('real bundled bus stops find Akitsu across the Tokyo/Saitama boundary without external providers', async () => {
  const c = setup(), calls = [], request = { controller: new AbortController() };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  c.fetchRouteJson = async (url) => {
    assert.equal(url.origin, 'https://app.example');
    calls.push(url.pathname);
    return JSON.parse(readFileSync(`${__dirname}${url.pathname}`, 'utf8'));
  };
  c.fetchDiscoveryMapData = async () => { throw Error('External services must not delay local bus stops'); };
  const area = { bounds: '35.767,139.482,35.790,139.511' }, origin = { lat: 35.7787, lng: 139.4966 };
  const rows = await c.fetchNearbyConvenienceData(area, request, 'bus_stop');
  const places = c.nearbyConveniencePlaces(rows, origin, 'bus_stop');
  assert.ok(Array.from(places, p => p.name).includes('秋津駅北口'));
  assert.ok(Array.from(places, p => p.name).includes('新秋津駅'));
  assert.ok(places.length >= 15);
  assert.ok(Array.from(places).every(p => p.source === 'mlit-bus' && p.distance <= 2000));
  assert.deepEqual(calls.map(p => p.split('/').pop()).sort(), ['11.json', '13.json', 'index.json']);
  await c.fetchNearbyConvenienceData(area, request, 'bus_stop');
  assert.equal(calls.length, 3, 'repeat searches reuse the manifest and spatial indexes');
});

test('bus data validates regions and falls back when absent or incomplete, without caching cancelled loads', async () => {
  const c = setup(), area = { bounds: '35.767,139.482,35.790,139.511' };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  assert.throws(() => c.busStopManifestFromData({ ...busManifest, parts: [{ file: '../private.json', count: 1, bounds: [35,139,36,140] }] }), /Invalid bus stop region/);
  const invalid = { ...busManifest, parts: [{ file: '13.json', count: 1, bounds: [35,139,36,140] }, { file: '13.json', count: 1, bounds: [35,139,36,140] }] };
  assert.throws(() => c.busStopManifestFromData(invalid), /Invalid bus stop region/);
  c.fetchRouteJson = async () => { throw Error('Missing bundled file'); };
  let fallback = 0;
  c.fetchDiscoveryMapData = async () => { fallback++; return [{ tags: { highway: 'bus_stop', name: 'Fallback bus' } }]; };
  assert.equal((await c.fetchNearbyConvenienceData(area, { controller: new AbortController() }, 'bus_stop'))[0].tags.name, 'Fallback bus');
  assert.equal(c.busStopManifestCache, null);
  const cancelled = { controller: new AbortController() };
  c.fetchRouteJson = async () => { cancelled.controller.abort(); return busManifest; };
  await assert.rejects(c.fetchNearbyConvenienceData(area, cancelled, 'bus_stop'), { name: 'AbortError' });
  assert.equal(c.busStopManifestCache, null);assert.equal(c.busStopPartsCache.size, 0);assert.equal(fallback, 1);
});

test('actual Akitsu facility toilets retain hours, exclude station gates and work without external APIs', async () => {
  const c = setup(), request = { controller: new AbortController() }, calls = [];
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  c.fetchRouteJson = async url => { calls.push(url.href); return toiletData; };
  c.fetchDiscoveryMapData = async () => { throw Error('Local toilets must not wait for Overpass'); };
  const area = { bounds: '35.767,139.482,35.790,139.511' }, origin = { lat: 35.7787, lng: 139.4966 };
  const elements = await c.fetchNearbyConvenienceData(area, request, 'toilet');
  const places = c.nearbyConveniencePlaces(elements, origin, 'toilet');
  assert.equal(places.length, 8);
  assert.ok(Array.from(places).some(p => p.distance > 1000));
  assert.ok(Array.from(places).every(p => p.distance <= 2000));
  assert.ok(Array.from(places).some(p => p.name.includes('野塩地域市民センター')));
  assert.ok(Array.from(places).every(p => p.source === 'tokyo-toilet' && p.openingHours && p.address));
  assert.ok(Array.from(places).every(p => !['秋津（トイレ）', '新秋津（トイレ）'].includes(p.name)));
  await c.fetchNearbyConvenienceData(area, request, 'toilet');assert.equal(calls.length, 1);
  assert.equal(toiletData.excluded.transportFacility, 698);
});

test('invalid or cancelled local toilet records are not cached and failures preserve the external fallback', async () => {
  const c = setup(), request = { controller: new AbortController() }, area = { bounds: '35.767,139.482,35.790,139.511' };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  let fallbacks = 0;
  c.fetchRouteJson = async () => ({ ...toiletData, places: [['broken']] });
  c.fetchDiscoveryMapData = async () => { fallbacks++; return []; };
  await c.fetchNearbyConvenienceData(area, request, 'toilet');assert.equal(fallbacks, 1);assert.equal(c.toiletIndexCache, null);
  c.fetchRouteJson = async () => { request.controller.abort(); return toiletData; };
  await assert.rejects(c.fetchNearbyConvenienceData(area, request, 'toilet'), { name: 'AbortError' });
  assert.equal(c.toiletIndexCache, null);assert.equal(fallbacks, 1);
});

test('local facilities outside the exact 2km circle do not suppress the external fallback', async () => {
  const c = setup(), origin = { lat: 35.7787, lng: 139.4966 }, area = { bounds: '35.76,139.48,35.8,139.52', origin };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  for (const kind of ['bus_stop', 'toilet']) {
    const far = [{ lat: origin.lat + .0196, lon: origin.lng, tags: kind === 'toilet' ? { amenity: 'toilets' } : { highway: 'bus_stop' } }];
    c.localNearbyToilets = async () => far;c.localNearbyBusStops = async () => far;
    let calls = 0;c.fetchDiscoveryMapData = async () => { calls++;return []; };
    const returned = await c.fetchNearbyConvenienceData(area, { controller: new AbortController() }, kind);
    assert.equal(calls, 1, kind);
    assert.equal(returned.length, 1, 'retain the padded-area local point for GPS drift and shared caches');
  }
});

test('grid-border stations stay searchable and stations beyond two kilometres remain excluded', async () => {
  const c = setup(), request = { controller: new AbortController() };
  c.fetchRouteJson = async () => ({ version: 1, referenceDate: '2025-12-31', stations: [
    ['西側', 35.7999, 139.4999, '路線', '会社', '1'], ['東側', 35.8001, 139.5001, '路線', '会社', '2'],
    ['遠方', 35.825, 139.5001, '路線', '会社', '3'],
  ] });
  const elements = await c.localNearbyStations({ bounds: '35.775,139.475,35.827,139.527' }, request);
  const result = c.nearbyConveniencePlaces(elements, { lat: 35.8, lng: 139.5 }, 'station');
  assert.deepEqual(Array.from(result, place => place.name).sort(), ['東側', '西側']);
});

test('invalid and absent local station data fall back without caching failure, and cancelled loads discard late data', async () => {
  const c = setup(), request = { controller: new AbortController() }, area = { bounds: '35.768,139.483,35.790,139.511' };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  let fallbacks = 0;
  c.fetchRouteJson = async () => ({ version: 1, stations: 'invalid' });
  c.fetchDiscoveryMapData = async () => { fallbacks++; return [{ tags: { railway: 'station', name: '代替検索' } }]; };
  assert.equal((await c.fetchNearbyConvenienceData(area, request, 'station'))[0].tags.name, '代替検索');
  assert.equal(c.stationIndexCache, null);
  c.fetchRouteJson = async () => stations;
  assert.ok((await c.fetchNearbyConvenienceData(area, request, 'station')).length > 0);
  assert.equal(fallbacks, 1);
  const cancelled = { controller: new AbortController() };
  cancelled.controller.abort();
  await assert.rejects(c.localNearbyStations(area, cancelled), { name: 'AbortError' });
  c.stationIndexCache = null;
  c.fetchRouteJson = async () => { request.controller.abort(); return stations; };
  await assert.rejects(c.fetchNearbyConvenienceData(area, request, 'station'), { name: 'AbortError' });
  assert.equal(c.stationIndexCache, null);
  assert.equal(fallbacks, 1);
});


test('nearby food places accept all three OSM types, preserve metadata, dedupe features and keep different branches', () => {
  const c=setup(), origin={lat:35.7787,lng:139.4966,distanceSource:'地図の中心'};
  const node=(id,tags,offset=.001)=>({type:'node',id,lat:origin.lat+offset,lon:origin.lng,tags});
  const tags={amenity:'restaurant',name:'テスト食堂',cuisine:'japanese;ramen',opening_hours:'Mo-Su 11:00-21:00','addr:street':'試験通り','addr:housenumber':'1'};
  const elements=[node(1,tags),{type:'way',id:2,center:{lat:origin.lat+.00101,lon:origin.lng},tags:{...tags,name:'テスト 食堂'}},
    node(3,{amenity:'fast_food',name:'別のバーガー店',cuisine:'burger',opening_hours:'24/7'},.002),
    {type:'relation',id:4,center:{lat:origin.lat+.003,lon:origin.lng},tags:{amenity:'food_court',name:'フードコート'}},
    node(5,{...tags,'addr:housenumber':'2'},.004),node(6,{amenity:'cafe',name:'カフェは別'}),
    node(7,{...tags,access:'private'}),node(8,{...tags,foot:'no'}),node(9,{...tags,disused:'yes'}),
    node(10,{...tags,opening_hours:'closed'}),node(11,{...tags,access:'members'}),node(12,tags,.03)];
  const places=c.nearbyConveniencePlaces(elements,origin,'restaurant');
  assert.equal(places.length,4);
  assert.deepEqual(Array.from(places,p=>p.name),['テスト食堂','別のバーガー店','フードコート','テスト食堂']);
  assert.equal(places[0].cuisine,'japanese;ramen');assert.equal(places[0].openingHours,tags.opening_hours);
  assert.equal(places[0].distanceSource,'地図の中心');assert.equal(places[2].cuisine,'');assert.equal(places[2].openingHours,'');
  assert.ok(places.every(p=>p.kindId==='restaurant'&&p.distance<=2000));
  assert.deepEqual(Array.from(c.nearbyConveniencePlaces(elements,origin,'cafe'),p=>p.name),['カフェは別']);
  assert.equal(c.nearbyCuisineLabel('japanese; ramen;ramen;local_specialty'),'和食・ラーメン・local_specialty');
});

test('food lookup combines three amenities in one bounded call and keeps cafe and cache independent',async()=>{
  const c=setup(),calls=[],area={key:'test',bounds:'35.76,139.47,35.80,139.52',center:{lat:35.778,lng:139.496}},request={controller:new AbortController()};
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData','showNearbyConvenience').replace(/async\s*$/,'')}`,c);
  c.fetchDiscoveryMapData=async(...args)=>{calls.push(args);return [{type:'node',id:1,lat:35.779,lon:139.497,tags:{amenity:'restaurant',name:'Test restaurant'}}]};
  let foodIndexCalls=0;c.fetchRouteJson=async()=>{foodIndexCalls++;throw Error('No geocoder needed')};
  vm.runInContext(`async ${functionSource('cachedNearbyElements','searchNearbyConvenience').replace(/async\s*$/,'')}`,c);
  c.nearbyConvenienceCache=new Map();c.nearbyConvenienceRequest=request;
  const first=await c.cachedNearbyElements(area,request,'restaurant');
  assert.equal(await c.cachedNearbyElements(area,request,'restaurant'),first);assert.equal(calls.length,1);assert.equal(foodIndexCalls,0,'a fast valid Overpass result must not start Photon');
  const [query,actualRequest,timeout,retry,options]=calls[0];
  assert.match(query,/nwr\[amenity~"\^\(restaurant\|fast_food\|food_court\)\$"\]/);
  assert.match(query,/\[timeout:8\]/);assert.match(query,/out body center qt 500/);assert.ok(query.includes(area.bounds));
  assert.match(query,/foot!~/);assert.notEqual(actualRequest.controller,request.controller);assert.equal(request.controller.signal.aborted,false);assert.equal(timeout,10000);assert.equal(retry,false);assert.equal(options.providerDelayMs,1000);
  await c.cachedNearbyElements(area,request,'cafe');assert.equal(calls.length,2);assert.match(calls[1][0],/amenity="cafe"/);
  const next={controller:new AbortController()};c.nearbyConvenienceRequest=next;
  c.fetchDiscoveryMapData=async()=>{next.controller.abort();return []};
  await assert.rejects(c.cachedNearbyElements({key:'cancelled'},next,'restaurant'),{name:'AbortError'});
  assert.equal(c.nearbyConvenienceCache.has('restaurant:cancelled'),false);
});

test('map-area searches retain the specified center while displayed food distances use current location',()=>{
  const c=setup();c.currentPosition={lat:35.7787,lng:139.4966};c.map.getCenter=()=>({lat:35.8,lng:139.51});
  c.ui={'nearby-scope':{value:'map'}};
  const origin=c.nearbySearchOrigin();assert.equal(origin.useCurrentLocation,false);assert.equal(origin.origin.lat,35.8);assert.equal(origin.source,'地図の中心');
  const place={lat:35.7797,lng:139.4966,distance:500,distanceSource:'地図の中心'};
  assert.match(c.nearbyDistanceLabel(place),/現在地から約111m（直線距離）/);
  c.ui['nearby-scope'].value='point';assert.equal(c.nearbySearchOrigin().origin.lat,35.7787);
  c.currentPosition=null;assert.equal(c.nearbySearchOrigin().origin.lat,35.8);
  assert.equal(c.nearbyDistanceLabel(place),'地図の中心から約500m（直線距離）');
});


test('food popup fitting respects mobile controls and legend without animation, and stops observing when closed',()=>{
  const c=setup(),handlers={},pan=[],queue=[],observed=[];let rect={left:30,right:300,top:-40,bottom:348},open=true;
  c.document={querySelector:()=>({getBoundingClientRect:()=>({top:116,bottom:148})})};
  c.ui={'nearby-convenience':{closest:()=>({getBoundingClientRect:()=>({top:12,bottom:104})})}};
  c.map.getContainer=()=>({getBoundingClientRect:()=>({left:0,right:390,top:0,bottom:780,height:780})});
  c.map.panBy=(offset,options)=>pan.push({offset,options});
  c.ResizeObserver=class {constructor(fn){this.fn=fn;observed.push(this)}observe(node){this.node=node}disconnect(){this.stopped=true}};
  c.requestAnimationFrame=fn=>{queue.push(fn);return queue.length};c.cancelAnimationFrame=()=>{};
  const popup={options:{},update(){},getElement:()=>({getBoundingClientRect:()=>rect})};
  const marker={on:(name,fn)=>{handlers[name]=fn},isPopupOpen:()=>open,getPopup:()=>popup},content={};
  vm.runInContext(functionSource('fitNearbyFoodPopup','showNearbyConvenience'),c);
  c.fitNearbyFoodPopup(marker,content);handlers.popupopen();queue.shift()();
  assert.equal(popup.options.maxHeight,360);assert.equal(pan[0].offset[1],-200);assert.equal(pan[0].options.animate,false);
  assert.equal(observed[0].node,content);
  rect={left:30,right:300,top:160,bottom:548};observed[0].fn();queue.shift()();assert.equal(pan.length,1);
  handlers.popupclose();open=false;observed[0].fn();queue.shift()();assert.equal(pan.length,1);assert.equal(observed[0].stopped,true);
});


const foodArea={key:'food-test',bounds:'35.758,139.472,35.798,139.522',center:{lat:35.778,lng:139.496},origin:{lat:35.7787,lng:139.4966}};
function foodFallbackContext(){
  const c=setup();
  // A released hedge still honors the cancellation/rate-limit checks in production.
  c.abortableRouteDelay=async(ms,signal)=>{if(signal.aborted)throw new DOMException('Aborted','AbortError')};
  return c;
}
const foodFeature=(overrides={})=>({type:'Feature',properties:{osm_type:'N',osm_id:101,osm_key:'amenity',osm_value:'restaurant',name:'Test dining',city:'Test city',extra:{cuisine:'ramen',opening_hours:'11:00-20:00'},...overrides},geometry:{type:'Point',coordinates:[139.4967,35.7788]}});

test('slow Overpass is cancelled after one successful bounded Photon food lookup with metadata retained',async()=>{
  const c=foodFallbackContext(),calls=[],parent={controller:new AbortController()};let cancelled=false;
  c.fetchDiscoveryMapData=(query,child)=>new Promise((resolve,reject)=>child.controller.signal.addEventListener('abort',()=>{cancelled=true;reject(new DOMException('Aborted','AbortError'))},{once:true}));
  c.fetchRouteJson=async(url,child,timeout)=>{calls.push({url,child,timeout});return{features:[foodFeature(),foodFeature({osm_type:'W',osm_id:102,osm_value:'fast_food',name:'Test burger'})]}};
  const elements=await c.fetchNearbyFoodData(foodArea,parent);
  assert.equal(elements.length,2);assert.equal(calls.length,1);assert.equal(cancelled,true);assert.equal(parent.controller.signal.aborted,false);
  const url=calls[0].url;assert.equal(url.pathname,'/api/');assert.equal(url.searchParams.get('include'),'osm.amenity.restaurant,osm.amenity.fast_food,osm.amenity.food_court');
  assert.equal(url.searchParams.get('bbox'),'139.472,35.758,139.522,35.798');assert.equal(url.searchParams.get('limit'),'50');assert.equal(url.searchParams.get('dedupe'),'0');assert.equal(calls[0].timeout,5000);
  const places=c.nearbyConveniencePlaces(elements,foodArea.origin,'restaurant');assert.equal(places[0].cuisine,'ramen');assert.equal(places[0].openingHours,'11:00-20:00');
});

test('food fallback distinguishes confirmed absence, unavailable providers and invalid Photon data',async()=>{
  const c=foodFallbackContext();let request=()=>({controller:new AbortController()});
  c.fetchDiscoveryMapData=async()=>[];c.fetchRouteJson=async()=>({features:[foodFeature()]});
  assert.equal((await c.fetchNearbyFoodData(foodArea,request())).length,1,'an empty Overpass result still tries the food index');
  c.lastSearchAt=0;c.fetchRouteJson=async()=>({features:[]});
  assert.equal((await c.fetchNearbyFoodData(foodArea,request())).length,0);
  c.lastSearchAt=0;c.fetchDiscoveryMapData=async()=>{throw Error('Overpass unavailable')};
  await assert.rejects(c.fetchNearbyFoodData(foodArea,request()),/Overpass unavailable/);
  c.lastSearchAt=0;c.fetchDiscoveryMapData=async()=>[];c.fetchRouteJson=async()=>({invalid:true});
  await assert.rejects(c.fetchNearbyFoodData(foodArea,request()),/Invalid nearby food response/);
});

test('food index cannot replace valid results with cafes, distant or private shops, and preserves cancellation',async()=>{
  const c=foodFallbackContext();let finish;
  c.fetchDiscoveryMapData=()=>new Promise(resolve=>{finish=resolve});
  c.fetchRouteJson=async()=>({features:[foodFeature({osm_value:'cafe'}),foodFeature({extra:{access:'private'}}),{...foodFeature(),geometry:{type:'Point',coordinates:[140,36]}}]});
  const parent={controller:new AbortController()},pending=c.fetchNearbyFoodData(foodArea,parent);
  await new Promise(resolve=>setImmediate(resolve));
  finish([{type:'way',id:202,center:{lat:35.7789,lon:139.4967},tags:{amenity:'food_court',name:'Valid food court'}}]);
  assert.equal((await pending)[0].id,202);
  const aborted={controller:new AbortController()};aborted.controller.abort();
  await assert.rejects(c.fetchNearbyFoodData(foodArea,aborted),{name:'AbortError'});
  c.lastSearchAt=0;
  c.fetchDiscoveryMapData=(query,child)=>new Promise((resolve,reject)=>child.controller.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
  c.fetchRouteJson=(url,child)=>new Promise((resolve,reject)=>child.controller.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
  const active={controller:new AbortController()},lookup=c.fetchNearbyFoodData(foodArea,active);
  await new Promise(resolve=>setImmediate(resolve));active.controller.abort();
  await assert.rejects(lookup,{name:'AbortError'});
});


test('food lookup does not repeat a failed relay call directly to the same Overpass provider',async()=>{
  let direct=0,relayed=0;const c=vm.createContext({URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,
    DISCOVERY_MAP_ENDPOINTS:['https://overpass.example/api/interpreter'],MAP_PROXY_ENDPOINT:'https://app.example/api/overpass',
    fetchMapProxy:async()=>{relayed++;return{status:503,ok:false,json:async()=>({error:'Busy',code:'MapBusy'})}},
    fetch:async()=>{direct++;throw Error('Repeated direct query must not run')}});
  vm.runInContext(source.slice(source.indexOf('async function fetchRouteJson('),source.indexOf('async function waitForRouteTurn(')),c);
  await assert.rejects(c.fetchRouteJson(new URL('https://overpass.example/api/interpreter?data=test'),{controller:new AbortController(),skipMapDirectFallback:true}),{routeCode:'MapBusy'});
  assert.equal(relayed,1);assert.equal(direct,0);
});
