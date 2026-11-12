const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/static/js/app.js`, 'utf8');
const access = JSON.parse(readFileSync(`${__dirname}/static/route-access.json`, 'utf8'));
const stations = JSON.parse(readFileSync(`${__dirname}/static/stations-jp-2025-v1.json`, 'utf8'));
function functionSource(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}
function setup() {
  const context = vm.createContext({ URL, Number, Math, Map, Set, AbortController, DOMException,
    NEARBY_CONVENIENCE_RADIUS: 1000, NEARBY_CONVENIENCE_TIMEOUT_MS: 10000,
    ROUTE_ACCESS_ENDPOINT: 'https://app.example/static/route-access.json', routeAccessCache: access,
    STATION_INDEX_ENDPOINT: 'https://app.example/static/stations-jp-2025-v1.json', stationIndexCache: null,
    validCoordinates: (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180,
    map: { distance(a, b) {
      if (Array.isArray(a)) a = { lat: a[0], lng: a[1] };
      if (Array.isArray(b)) b = { lat: b[0], lng: b[1] };
      return Math.hypot((a.lat - b.lat) * 111195, (a.lng - b.lng) * 90000);
    } },
  });
  vm.runInContext(functionSource('routeCrossesRestrictedArea', 'calculateWalkingRoute').replace(/async\s*$/, ''), context);
  vm.runInContext(functionSource('nearbyConveniencePlaces', 'nearbyConvenienceArea'), context);
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
