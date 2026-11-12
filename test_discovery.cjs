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
    MAP_PROXY_ENDPOINT: null, discoveryRequest: null,
    DISCOVERY_MAP_TIMEOUT_MS: 60000, DISCOVERY_PROVIDER_DELAY_MS: 4000,
    DISCOVERY_MAP_ENDPOINTS: [], lastSearchAt: -Infinity,
    discoveryMapCache: new Map(), discoveryParkCache: new Map(), discoveryRandomCache: new Map(), discoveryContextCache: new Map(),
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
  context.originalFetchDiscoveryMapData = context.fetchDiscoveryMapData;
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

test('four directions cover 90-degree sectors while legacy diagonal searches remain readable', () => {
  const { context: c } = setup();
  const directions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  for (const [index, direction] of directions.entries()) {
    const bearing = index * 45;
    const halfWidth = index % 2 === 0 ? 45 : 22.5;
    const point = c.discoveryOffset(start, 10000, bearing);
    assert.ok(c.discoveryDirectionMatches(start, point, direction));
    assert.equal(c.discoveryDirectionMatches(start, c.discoveryOffset(start, 10000, bearing + halfWidth + 1), direction), false);
    assert.ok(c.discoveryDirectionMatches(start, c.discoveryOffset(start, 10000, bearing - halfWidth), direction));
    assert.ok(c.discoveryDirectionMatches(start, c.discoveryOffset(start, 10000, bearing + halfWidth - 1), direction));
  }
  assert.ok(c.discoveryDirectionMatches(start, c.discoveryOffset(start, 10000, 359), 'n'));
  assert.equal(c.discoveryDirectionMatches(start, start, 'n'), false);
  assert.equal(c.discoveryDirectionMatches(start, features[0], 'invalid'), false);
  assert.ok(c.discoveryDirectionMatches({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 }, 'e'));
  assert.ok(c.discoveryDirectionMatches({ lat: 0, lng: -179.9 }, { lat: 0, lng: 179.9 }, 'w'));
});

test('sector bounding boxes include the whole selected sector without collecting the opposite side', () => {
  const { context: c } = setup();
  for (const origin of [start, { lat: 70, lng: -45 }, { lat: -40, lng: 170 }]) {
    for (const [index, direction] of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].entries()) {
      const bounds = c.discoveryDirectionalBounds(origin, 80000, direction).split(',').map(Number);
      const halfWidth = index % 2 === 0 ? 45 : 22.5;
      for (const delta of [-halfWidth, -15, 0, 15, halfWidth]) {
        for (const radius of [1, 40000, 80000]) {
          const p = c.discoveryOffset(origin, radius, index * 45 + delta);
          assert.ok(p.lat >= bounds[0] && p.lat <= bounds[2] && p.lng >= bounds[1] && p.lng <= bounds[3],
            `${direction} sector point must be inside its lookup bounds`);
        }
      }
    }
  }
  const west = c.discoveryDirectionalBounds(start, 20000, 'w').split(',').map(Number);
  assert.ok(west[3] < start.lng + .01);
});

test('park search focuses on the requested direction and keeps its cache separate', async () => {
  const { context: c, calls, request } = setup();
  await c.findDiscoveryPlaces(criteria, start, request());
  c.photon = async () => ({ features: Array.from({ length: 6 }, (_, i) => {
    const p = c.discoveryOffset(start, 20000, 255 + i * 6);
    return { ...feature(100 + i), geometry: { type: 'Point', coordinates: [p.lng, p.lat] } };
  }) });
  const west = { ...criteria, direction: 'w' };
  const result = await c.findDiscoveryPlaces(west, start, request(west));
  assert.equal(calls.length, 2, 'unrestricted and west-only queries must not share cached responses');
  assert.ok(Number(calls[1].url.searchParams.get('lon')) < start.lng);
  assert.equal(result.length, 6);
  assert.ok(result.every(p => c.discoveryDirectionMatches(start, p, 'w')));
});

test('Overpass fallback also limits both the query bounds and returned candidates to the selected direction', async () => {
  const { context: c, mapCalls, request } = setup();
  c.photon = async () => { throw new Error('offline'); };
  const west = { ...criteria, direction: 'w' };
  const result = await c.findDiscoveryPlaces(west, start, request(west));
  assert.ok(result.length > 0);
  assert.ok(result.every(p => c.discoveryDirectionMatches(start, p, 'w')));
  const bounds = mapCalls[0].match(/nwr\(([-\d.,]+)\)/)[1].split(',').map(Number);
  assert.ok(bounds[3] < start.lng + .01);
});

test('seasonal places use the same direction relative to the configured start', async () => {
  const { context: c, calls, mapCalls, request } = setup();
  c.fetchSeasonalPlaces = async () => [90, 270].map((bearing, index) => {
    const p = c.discoveryOffset(start, 20000, bearing);
    return { type: 'seasonal', id: `listed-${index}`, lat: p.lat, lon: p.lng,
      tags: { name: `桜の名所${index}` }, seasons: ['cherry_blossom'] };
  });
  const west = { ...criteria, kind: 'cherry_blossom', direction: 'w' };
  const result = await c.findDiscoveryPlaces(west, start, request(west));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, '桜の名所1');
  assert.equal(calls.length, 0);
  assert.equal(mapCalls.length, 0);
});

test('history keeps undisplayed candidates and remains compatible with older five-place entries', () => {
  const { context: c } = setup();
  vm.runInContext(source.match(/^const DISCOVERY_HISTORY_(?:KEY|LIMIT) = .*$/gm).join('\n'), c);
  vm.runInContext(source.slice(source.indexOf('function loadDiscoveryHistory'), source.indexOf('function rememberDiscoverySearch')), c);
  c.validWalkingSpeed = speed => Number.isFinite(speed) && speed >= 2.5 && speed <= 6.5;
  const places = Array.from(c.discoveryCandidates(elements(), criteria, start, 250));
  const entry = { id: 'current', at: 1000000, start, criteria, places, elapsedSeconds: 1.2, visibleCount: 5 };
  c.localStorage = { getItem: () => JSON.stringify({ version: 1, searches: [entry,
    { ...entry, id: 'legacy', places: places.slice(0, 5), visibleCount: undefined },
    { ...entry, id: 'invalid', visibleCount: 1000 }] }) };
  const history = c.loadDiscoveryHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].places.length, 6, 'the sixth candidate must survive saving/loading');
  assert.equal(history[0].visibleCount, 5);
  assert.equal(history[1].places.length, 5);
});

test('random suggestions use only time and speed, probe separate kinds and select beyond the nearest result', async () => {
  const { context: c, request } = setup();
  c.Math = Object.create(Math);
  c.Math.random = () => .999999;
  const input = { ...criteria, kind: 'random', ambience: 'rural', direction: 'n', highElevation: true, keyword: '山' };
  const normalized = c.randomDiscoveryCriteria({ minMinutes: 360, minutes: 420 }, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
    minMinutes: 360, minutes: 420, kind: 'random', ambience: 'any', direction: 'any', highElevation: false, keyword: '', speed: 4,
  });
  const tried = [], pool = [{ key: 'near' }, { key: 'middle' }, { key: 'far' }], updates = [];
  c.findDiscoveryPlaces = async (selected, origin) => {
    tried.push(selected.kind);
    assert.equal(origin, start);
    assert.equal(selected.ambience, 'any');
    assert.equal(selected.direction, 'any');
    assert.equal(selected.highElevation, false);
    assert.equal(selected.keyword, '');
    assert.equal(selected.minMinutes, 360);
    assert.equal(selected.minutes, 420);
    assert.equal(selected.speed, 4);
    return tried.length < 3 ? [] : pool;
  };
  const result = await c.findRandomDiscoveryPlaces(input, start, request(input), places => updates.push(places));
  assert.deepEqual(tried.slice(0, 3), ['mountain', 'forest', 'waterside']);
  assert.equal(new Set(tried).size, tried.length);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'far');
  assert.equal(updates.length, 1);
  assert.equal(pool.length, 3, 'selection must not mutate the cached candidate pool');
});

test('random search checks every supported kind at most once when the time window has no matches', async () => {
  const { context: c, request } = setup();
  const tried = [];
  c.findDiscoveryPlaces = async selected => { tried.push(selected.kind); return []; };
  const result = await c.findRandomDiscoveryPlaces(criteria, start, request({ kind: 'random' }));
  assert.equal(result.length, 0);
  assert.equal(new Set(tried).size, tried.length);
  assert.ok(tried.includes('park') && tried.includes('mountain') && tried.includes('cafe') && tried.includes('cherry_blossom'));
  assert.ok(!tried.some(kind => ['any', 'places', 'random'].includes(kind)));
});

test('random search discards late results on cancellation and never starts a cancelled lookup', async () => {
  const { context: c, request } = setup();
  const req = request({ kind: 'random' });
  let calls = 0, updates = 0;
  c.findDiscoveryPlaces = async () => { calls++; req.controller.abort(); return [{ key: 'late' }]; };
  await assert.rejects(c.findRandomDiscoveryPlaces(criteria, start, req, () => updates++), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(updates, 0);
  await assert.rejects(c.findRandomDiscoveryPlaces(criteria, start, req), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('one valid park is enough for a random suggestion without extra map or surroundings lookups', async () => {
  const { context: c, calls, mapCalls, request } = setup();
  const random = c.randomDiscoveryCriteria({ minMinutes: 360, minutes: 420 }, 4);
  c.photon = async () => ({ features: [feature(501, 390), feature(502, 30), feature(503, 500)] });
  const result = await c.findDiscoveryPlaces({ ...random, kind: 'park' }, start, request(random));
  assert.equal(result.length, 1);
  assert.ok(result[0].duration >= 360 * 60 && result[0].duration <= 420 * 60);
  assert.equal(calls.length, 1);
  assert.equal(mapCalls.length, 0);
});

test('a stalled first kind does not block a fast second kind, and outstanding probes are cancelled', async () => {
  const { context: c, request } = setup();
  const pending = [], pool = c.discoveryCandidates(elements(), criteria, start, 250);
  let active = 0, peak = 0;
  c.findDiscoveryPlaces = async (selected, origin, probe) => {
    active++; peak = Math.max(peak, active);
    pending.push(probe);
    if (pending.length === 2) { active--; return pool; }
    return new Promise((resolve) => probe.controller.signal.addEventListener('abort', () => {
      active--; resolve(pool); // A late response from the losing lookup must be discarded.
    }, { once: true }));
  };
  const updates = [];
  const result = await c.findRandomDiscoveryPlaces(criteria, start, request({ kind: 'random' }), places => updates.push(places));
  assert.equal(result.length, 1);
  assert.equal(peak, 2);
  assert.equal(pending.length, 2);
  assert.ok(pending.every(probe => probe.controller.signal.aborted));
  assert.equal(updates.length, 1);
  assert.equal(active, 0);
});

test('repeat random draws reuse the complete pool but recheck time, speed, location and expiry', async () => {
  const { context: c, request, advance } = setup();
  const random = c.randomDiscoveryCriteria({ minMinutes: 360, minutes: 420 }, 4);
  const pool = c.discoveryCandidates(elements(), criteria, start, 250);
  let lookups = 0;
  c.findDiscoveryPlaces = async () => { lookups++; return pool; };
  await c.findRandomDiscoveryPlaces(random, start, request(random));
  const firstLookups = lookups;
  assert.equal(c.discoveryRandomCache.size, pool.length);
  const shifted = { lat: start.lat + .0001, lng: start.lng };
  const result = await c.findRandomDiscoveryPlaces(random, shifted, request(random));
  assert.equal(lookups, firstLookups, 'a second draw must not contact providers');
  assert.ok(Math.abs(result[0].directDistance - distance(shifted, result[0])) < .001);
  assert.ok(result[0].duration >= 360 * 60 && result[0].duration <= 420 * 60);
  assert.equal(c.cachedRandomDiscoveryPlaces({ ...random, speed: 2.5 }, start).length, 0);
  assert.equal(c.cachedRandomDiscoveryPlaces({ ...random, minMinutes: 0, minutes: 60 }, start).length, 0);
  assert.equal(c.cachedRandomDiscoveryPlaces(random, { lat: 34, lng: 135 }).length, 0);
  advance(600001);
  assert.equal(c.cachedRandomDiscoveryPlaces(random, start).length, 0);
  assert.equal(c.discoveryRandomCache.size, 0);
});

test('a random probe has a finite budget even if its data source ignores cancellation', async () => {
  const { context: c, request } = setup();
  const timers = [];
  c.setTimeout = (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; };
  c.clearTimeout = timer => { timer.cleared = true; };
  let signal;
  c.findDiscoveryPlaces = async (criteria, origin, probe) => { signal = probe.controller.signal; return new Promise(() => {}); };
  const pending = c.probeRandomDiscoveryKind('forest', criteria, start, request({ kind: 'random' }));
  assert.equal(timers[0].ms, 8000);
  timers[0].callback();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(timers[0].cleared, true);
});

test('failed random probes remain an incomplete search rather than a false empty result', async () => {
  const { context: c, request } = setup();
  c.findDiscoveryPlaces = async () => { throw Object.assign(new Error('busy'), { routeCode: 'MapBusy' }); };
  await assert.rejects(c.findRandomDiscoveryPlaces(criteria, start, request({ kind: 'random' })), { routeCode: 'MapBusy' });
  assert.equal(c.discoveryRandomCache.size, 0);
});

test('small random map samples cannot replace the full normal-search cache or retry indefinitely', async () => {
  const { context: c, request } = setup();
  const cafe = { ...criteria, kind: 'cafe' }, queries = [];
  c.fetchDiscoveryMapData = async (...args) => {
    queries.push(args);
    return elements().map(element => ({ ...element, tags: { name: element.tags.name, amenity: 'cafe' } }));
  };
  await c.findDiscoveryPlaces(cafe, start, { ...request({ kind: 'random' }), randomProbe: true });
  assert.match(queries[0][0], /timeout:5/);
  assert.match(queries[0][0], /center 60;/);
  assert.equal(queries[0][2], 6000);
  assert.equal(queries[0][3], false);
  assert.equal(queries[0][4].ignoreCooldown, true);
  await c.findDiscoveryPlaces(cafe, start, request(cafe));
  assert.equal(queries.length, 2, 'a complete normal search must fetch its own full sample');
  assert.match(queries[1][0], /timeout:30/);
  assert.match(queries[1][0], /center 250;/);
});

test('progress distinguishes pending data and verified candidates without repeated announcements', () => {
  const { context: c, request, advance } = setup();
  const req = request(), updates = [];
  c.discoveryRequest = req;
  c.message = (target, text) => { target.textContent = text; updates.push(text); };
  c.setDiscoveryProgress(req, '候補を取得中…');
  assert.equal(updates.at(-1), '候補を取得中…');
  advance(11000);
  c.renderDiscoveryProgress(req);
  assert.ok(updates.at(-1).includes('応答待ち'));
  const count = updates.length;
  c.renderDiscoveryProgress(req);
  assert.equal(updates.length, count, 'unchanged status must not repeat aria-live announcements');
  req.places = [{}, {}, {}];
  c.setDiscoveryProgress(req, '周辺情報を確認中…');
  assert.equal(updates.at(-1), '候補 3件・周辺情報を確認中…');
  c.discoveryRequest = request();
  c.setDiscoveryProgress(req, 'old request');
  assert.equal(updates.at(-1), '候補 3件・周辺情報を確認中…');
});

test('unavailable providers show retry waiting instead of claiming no candidates exist', async () => {
  const { context: c, request } = setup();
  const req = request();
  c.discoveryRequest = req;
  c.DISCOVERY_MAP_ENDPOINTS = ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter'];
  c.discoveryMapProviders = [{ retryAt: 0 }, { retryAt: 0 }];
  c.preferredDiscoveryMapProvider = 0;
  c.lastDiscoveryMapError = null;
  c.message = (target, text) => { target.textContent = text; };
  c.fetchRouteJson = async () => { throw Object.assign(new Error('busy'), { routeCode: 'MapBusy', httpStatus: 503 }); };
  c.abortableRouteDelay = async (ms) => {
    if (ms >= 10000) {
      assert.ok(c.ui['discovery-status'].textContent.includes('再試行待ち'));
      assert.ok(!c.ui['discovery-status'].textContent.includes('候補なし'));
      req.controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }
  };
  await assert.rejects(c.originalFetchDiscoveryMapData('query', req), { name: 'AbortError' });
});
