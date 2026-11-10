const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, 'static/js/app.js'), 'utf8');
const start = { lat: 35.7787, lng: 139.4966 };
const criteria = { kind: 'park', ambience: 'any', keyword: '', minMinutes: 360, minutes: 420, speed: 4 };
function distance(a, b) {
  if (Array.isArray(a)) a = { lat: a[0], lng: a[1] };
  if (Array.isArray(b)) b = { lat: b[0], lng: b[1] };
  const rad = Math.PI / 180;
  const term = Math.sin((b.lat - a.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, term)));
}
function feature(id, minutes = 390, angle = 0) {
  const meters = minutes * 4 * 1000 / 60 / 1.3;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [
    start.lng + Math.cos(angle) * meters / (111195 * Math.cos(start.lat * Math.PI / 180)),
    start.lat + Math.sin(angle) * meters / 111195,
  ] }, properties: { osm_type: 'W', osm_id: id, osm_key: 'leisure', osm_value: 'park', name: `公園${id}` } };
}
const features = Array.from({ length: 6 }, (_, i) => feature(i + 1, 390, i * Math.PI / 3));
function elements(list = features) {
  return list.map(f => ({ type: 'way', id: f.properties.osm_id,
    center: { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] },
    tags: { leisure: 'park', name: f.properties.name } }));
}
function setup() {
  let now = 1000000;
  const calls = [], mapCalls = [];
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, DOMException, Math, Number, Object, Map, Set, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    SEARCH_ENDPOINT: 'https://photon.komoot.io/api/', DISCOVERY_PARK_TIMEOUT_MS: 8000,
    MAP_PROXY_ENDPOINT: null,
    DISCOVERY_MAP_TIMEOUT_MS: 60000, DISCOVERY_PROVIDER_DELAY_MS: 4000,
    DISCOVERY_MAP_ENDPOINTS: [], lastSearchAt: -Infinity,
    discoveryMapCache: new Map(), discoveryParkCache: new Map(), discoveryContextCache: new Map(),
    discoveryGeometryCache: new Map(), discoveryElevationCache: new Map(),
    map: { distance }, ui: { 'discovery-status': {} }, message() {},
    validCoordinates: (lat, lng) => typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
      && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180,
    abortableRouteDelay: async (ms, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      now += ms;
    },
    fetchRouteJson: async (url, request, timeout) => {
      calls.push({ url, timeout });
      return context.photon(url, request);
    },
  });
  vm.runInContext(source.slice(source.indexOf('const SEASONAL_KIND_WORDS'), source.indexOf('const NEARBY_CONVENIENCE_RADIUS')), context);
  vm.runInContext(source.slice(source.indexOf('const DISCOVERY_DISTANCE_FACTOR'), source.indexOf('const WALKING_SETTINGS_KEY')), context);
  vm.runInContext(source.slice(source.indexOf('function discoveryText'), source.indexOf('function renderDiscoveryResults')), context);
  context.photon = async () => ({ features });
  context.mapData = async query => query.includes('.neighborhood') ? [] : elements();
  context.fetchDiscoveryMapData = async (query, request) => {
    mapCalls.push(query);
    return context.mapData(query, request);
  };
  const request = custom => ({ criteria: { ...criteria, ...custom }, controller: new AbortController() });
  return { context, calls, mapCalls, request, advance: ms => { now += ms; } };
}

test('6h30 park search returns only valid 6–7h candidates without waiting for Overpass', async () => {
  const { context: c, calls, mapCalls, request } = setup();
  const bad = [feature(21, 20), feature(22, 500), { ...feature(23), geometry: { type: 'Point', coordinates: [NaN, 35] } },
    { ...feature(24), properties: { ...feature(24).properties, osm_value: 'stadium' } },
    { ...feature(25), properties: { ...feature(25).properties, extra: { access: 'private' } } }];
  c.photon = async () => ({ features: [...features, features[0], ...bad] });
  const updates = [];
  const result = await c.findDiscoveryPlaces(criteria, start, request(), places => updates.push(places));
  assert.equal(calls.length, 1);
  assert.equal(mapCalls.length, 0);
  assert.equal(result.length, 6);
  assert.ok(result.every(p => p.duration >= 360 * 60 && p.duration <= 420 * 60));
  assert.ok(result.every(p => !p.free && !p.toilets && !p.benches));
  assert.equal(updates.length, 1);
  assert.equal(calls[0].timeout, 8000);
  const url = calls[0].url;
  assert.equal(url.searchParams.getAll('include').length, 1, 'category alternatives must be OR, not AND');
  assert.equal(url.searchParams.get('include'), 'osm.leisure.park,osm.leisure.garden,osm.leisure.nature_reserve');
  assert.notEqual(Number(url.searchParams.get('lat')), start.lat);
  assert.ok(url.searchParams.has('bbox'));
});

test('cached park data is reused after small GPS drift, then filtered against the new start', async () => {
  const { context: c, calls, request, advance } = setup();
  await c.findDiscoveryPlaces(criteria, start, request());
  const moved = { lat: start.lat + .00005, lng: start.lng + .00005 };
  const result = await c.findDiscoveryPlaces(criteria, moved, request());
  assert.equal(calls.length, 1);
  assert.ok(result.every(p => Math.abs(p.directDistance - distance(moved, p)) < .001));
  advance(600001);
  await c.findDiscoveryPlaces(criteria, moved, request());
  assert.equal(calls.length, 2, 'expired data is fetched again');
});

test('a different direction is searched when the first returns only nearby parks', async () => {
  const { context: c, calls, request } = setup();
  c.photon = async () => ({ features: calls.length === 1 ? [feature(20, 10)] : features });
  const result = await c.findDiscoveryPlaces(criteria, start, request());
  assert.ok(result.length >= 5);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].url.searchParams.get('lat'), calls[1].url.searchParams.get('lat'));
});

test('Photon failure, invalid response and timeout fall back without caching failures', async () => {
  for (const failure of [new Error('offline'), new DOMException('Timeout', 'AbortError'), { features: 'invalid' }]) {
    const { context: c, calls, mapCalls, request } = setup();
    c.photon = async () => { if (failure instanceof Error || failure instanceof DOMException) throw failure; return failure; };
    const result = await c.findDiscoveryPlaces(criteria, start, request());
    assert.ok(result.length >= 5);
    assert.equal(calls.length, 1);
    assert.equal(mapCalls.length, 1);
    assert.equal(c.discoveryParkCache.size, 0);
  }
});

test('partial Photon results are selectable before the original search supplements them', async () => {
  const { context: c, calls, mapCalls, request } = setup();
  c.photon = async () => ({ features: features.slice(0, 2) });
  const updates = [];
  const result = await c.findDiscoveryPlaces(criteria, start, request(), places => updates.push(places.length));
  assert.equal(updates[0], 2);
  assert.equal(calls.length, 4);
  assert.equal(mapCalls.length, 1);
  assert.equal(result.length, 6);
});

test('cancelled searches cannot show or cache a late Photon response', async () => {
  const { context: c, mapCalls, request } = setup();
  const req = request();
  c.photon = async () => { req.controller.abort(); return { features }; };
  let updates = 0;
  await assert.rejects(c.findDiscoveryPlaces(criteria, start, req, () => updates++), { name: 'AbortError' });
  assert.equal(updates, 0);
  assert.equal(c.discoveryParkCache.size, 0);
  assert.equal(mapCalls.length, 0);
});

test('a blocked direct park search can succeed through the Python relay', async () => {
  const { context: c, calls, mapCalls, request } = setup();
  c.MAP_PROXY_ENDPOINT = 'https://walking.example/api/overpass';
  c.photon = async () => { throw new TypeError('blocked'); };
  const relayed = [];
  c.fetch = async (url, options) => {
    relayed.push({ url: url.href, options });
    return { ok: true, headers: { get: () => '1' }, json: async () => ({ features }) };
  };
  const result = await c.findDiscoveryPlaces(criteria, start, request());
  assert.ok(result.length >= 5);
  assert.equal(calls.length, 1);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].url, 'https://walking.example/api/parks');
  const body = JSON.parse(relayed[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['bbox', 'lat', 'lon']);
  assert.notEqual(body.lat, start.lat);
  assert.equal(mapCalls.length, 0, 'no expensive full-area fallback when the relay succeeds');
});

test('a missing or unrelated relay preserves the original search fallback', async () => {
  const { context: c, mapCalls, request } = setup();
  c.MAP_PROXY_ENDPOINT = 'https://walking.example/api/overpass';
  c.photon = async () => { throw new TypeError('blocked'); };
  c.fetch = async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ features }) });
  const result = await c.findDiscoveryPlaces(criteria, start, request());
  assert.ok(result.length >= 5);
  assert.equal(mapCalls.length, 1);
  assert.equal(c.discoveryParkCache.size, 0);
});

test('cancelling during a relayed lookup discards the late response', async () => {
  const { context: c, mapCalls, request } = setup();
  c.MAP_PROXY_ENDPOINT = 'https://walking.example/api/overpass';
  const req = request();
  c.photon = async () => { throw new TypeError('blocked'); };
  c.fetch = async (_url, options) => {
    req.controller.abort();
    assert.equal(options.signal.aborted, true);
    return { ok: true, headers: { get: () => '1' }, json: async () => ({ features }) };
  };
  await assert.rejects(c.findDiscoveryPlaces(criteria, start, req), { name: 'AbortError' });
  assert.equal(c.discoveryParkCache.size, 0);
  assert.equal(mapCalls.length, 0);
});

test('Overpass relay gateway failures allow a direct lookup within the same timeout', async () => {
  const c = vm.createContext({ URL, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout,
    DISCOVERY_MAP_ENDPOINTS: ['https://overpass.private.coffee/api/interpreter'] });
  vm.runInContext(source.slice(source.indexOf('async function fetchRouteJson'), source.indexOf('async function waitForRouteTurn')), c);
  let directCalls = 0;
  c.fetchMapProxy = async () => ({ status: 504, ok: false, json: async () => ({ error: 'timeout', code: 'MapTimeout' }) });
  c.fetch = async (url, options) => {
    directCalls++;
    assert.equal(url.href, 'https://overpass.private.coffee/api/interpreter');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('data'), 'query');
    return { status: 200, ok: true, json: async () => ({ elements: [] }) };
  };
  const url = new URL('https://overpass.private.coffee/api/interpreter?data=query');
  const result = await c.fetchRouteJson(url, { controller: new AbortController() }, 1000);
  assert.equal(result.elements.length, 0);
  assert.equal(directCalls, 1);
  c.fetchMapProxy = async () => ({ status: 503, ok: false, json: async () => ({ error: 'busy', code: 'MapBusy' }) });
  c.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(c.fetchRouteJson(url, { controller: new AbortController() }, 1000), e => e.routeCode === 'MapBusy');
  c.fetchMapProxy = async () => ({ status: 400, ok: false, json: async () => ({ error: 'bad query', code: 'MapQuery' }) });
  c.fetch = async () => { throw new Error('invalid queries must not be retried'); };
  await assert.rejects(c.fetchRouteJson(url, { controller: new AbortController() }, 1000), e => e.routeCode === 'MapQuery');
});

test('rural candidates still require surrounding data and reject dense urban parks', async () => {
  const { context: c, mapCalls, request } = setup();
  const point = features[0].geometry.coordinates;
  c.mapData = async () => Array.from({ length: 6 }, (_, i) => ({ type: 'node', id: 800 + i,
    lat: point[1] + i * .0001, lon: point[0], tags: { shop: 'convenience' } }));
  const rural = { ...criteria, ambience: 'rural' }, updates = [];
  const result = await c.findDiscoveryPlaces(rural, start, request(rural), places => updates.push(Array.from(places, p => p.osmId)));
  assert.equal(updates[0].length, 0);
  assert.equal(result.length, 5);
  assert.ok(result.every(p => p.osmId !== 1 && p.ruralMatch));
  assert.equal(mapCalls.length, 2);
});

test('surroundings cache survives reordered batches and fetches only missing points', async () => {
  const { context: c, mapCalls, request, advance } = setup();
  const places = features.map(f => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
  const req = request({ ambience: 'rural' });
  await c.fetchDiscoveryContext(places.slice(0, 2), req);
  await c.fetchDiscoveryContext([places[1], places[0]], req);
  assert.equal(mapCalls.length, 1);
  await c.fetchDiscoveryContext([places[1], places[2]], req);
  assert.equal(mapCalls.length, 2);
  assert.equal((mapCalls[1].match(/->\.neighborhood/g) || []).length, 4, 'one missing place, not the whole batch');
  await c.fetchDiscoveryContext([places[1]], request());
  assert.equal(mapCalls.length, 3, 'urban/nature and rural have different cache keys');
  advance(600001);
  await c.fetchDiscoveryContext([places[1]], req);
  assert.equal(mapCalls.length, 4);
});

test('surroundings failures do not confirm a rural candidate or poison the cache', async () => {
  const { context: c, request } = setup();
  c.mapData = async () => { throw new Error('offline'); };
  const rural = { ...criteria, ambience: 'rural' }, req = request(rural);
  const result = await c.findDiscoveryPlaces(rural, start, req);
  assert.equal(result.length, 0);
  assert.equal(req.ambienceUnavailable, true);
  assert.equal(c.discoveryContextCache.size, 0);
});
