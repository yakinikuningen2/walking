const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/static/js/app.js`, 'utf8');
const access = JSON.parse(readFileSync(`${__dirname}/static/route-access.json`, 'utf8'));
const stations = JSON.parse(readFileSync(`${__dirname}/static/stations-jp-2025-v1.json`, 'utf8'));
const busManifest = JSON.parse(readFileSync(`${__dirname}/static/bus-stops-jp-2022-v1/index.json`, 'utf8'));
const toiletData = JSON.parse(readFileSync(`${__dirname}/static/toilets-tokyo-2024-v1.json`, 'utf8'));
function functionSource(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}
function setup() {
  const context = vm.createContext({ URL, Number, Math, Map, Set, AbortController, DOMException,
    NEARBY_CONVENIENCE_RADIUS: 1000, NEARBY_CONVENIENCE_TIMEOUT_MS: 10000,
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
  vm.runInContext(functionSource('parseWalkingRoute', 'syncRouteLayers'), context);
  vm.runInContext(`${functionSource('stationIndexFromData', 'fetchNearbyConvenienceData').replace(/async\s*$/, '')}`, context);
  return context;
}

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
  assert.ok(Array.from(places).every(p => p.source === 'mlit-bus' && p.distance <= 1000));
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
  assert.equal(places.length, 3);
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

test('local facilities outside the exact 1km circle do not suppress the external fallback', async () => {
  const c = setup(), origin = { lat: 35.7787, lng: 139.4966 }, area = { bounds: '35.76,139.48,35.8,139.52', origin };
  vm.runInContext(`async ${functionSource('fetchNearbyConvenienceData', 'showNearbyConvenience').replace(/async\s*$/, '')}`, c);
  for (const kind of ['bus_stop', 'toilet']) {
    const far = [{ lat: origin.lat + .012, lon: origin.lng, tags: kind === 'toilet' ? { amenity: 'toilets' } : { highway: 'bus_stop' } }];
    c.localNearbyToilets = async () => far;c.localNearbyBusStops = async () => far;
    let calls = 0;c.fetchDiscoveryMapData = async () => { calls++;return []; };
    const returned = await c.fetchNearbyConvenienceData(area, { controller: new AbortController() }, kind);
    assert.equal(calls, 1, kind);
    assert.equal(returned.length, 1, 'retain the padded-area local point for GPS drift and shared caches');
  }
});

test('grid-border stations stay searchable and stations beyond one kilometre remain excluded', async () => {
  const c = setup(), request = { controller: new AbortController() };
  c.fetchRouteJson = async () => ({ version: 1, referenceDate: '2025-12-31', stations: [
    ['西側', 35.7999, 139.4999, '路線', '会社', '1'], ['東側', 35.8001, 139.5001, '路線', '会社', '2'],
    ['遠方', 35.815, 139.5001, '路線', '会社', '3'],
  ] });
  const elements = await c.localNearbyStations({ bounds: '35.785,139.485,35.817,139.517' }, request);
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
