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
    discoveryGeometryCache: new Map(), discoveryElevationCache: new Map(), shrineIndexCache: new Map(),
    DISCOVERY_LOCAL_SOURCES: [], DISCOVERY_LOCAL_CLASSES: {}, bundledDiscoveryCache: new Map(), bundledDiscoveryAttributions: new Set(),
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
  vm.runInContext(readFileSync(join(__dirname, 'static/js/natural-discovery.js'), 'utf8'), context);
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

function enableBundledIndexes(c) {
  const config = vm.runInNewContext(source.slice(source.indexOf('const DISCOVERY_LOCAL_SOURCES'), source.indexOf('const SEASONAL_KIND_WORDS'))
    + ';({sources:DISCOVERY_LOCAL_SOURCES,classes:DISCOVERY_LOCAL_CLASSES})');
  c.DISCOVERY_LOCAL_SOURCES = config.sources;
  c.DISCOVERY_LOCAL_CLASSES = config.classes;
  c.DISCOVERY_INDEX_BASE = 'https://local.test/static/';
  const downloaded = [];
  c.fetchRouteJson = async url => {
    assert.equal(url.origin, 'https://local.test');
    downloaded.push(url.pathname);
    return JSON.parse(readFileSync(join(__dirname, decodeURIComponent(url.pathname)), 'utf8'));
  };
  return downloaded;
}

test('each actual local category can find its own records without external APIs, then reuse its spatial index', async () => {
  for (const provider of ['wikidata', 'geonames']) {
    const folder = `static/discovery-${provider}-jp-2026-11-13-v1`;
    const manifest = JSON.parse(readFileSync(join(__dirname, folder, 'index.json'), 'utf8'));
    for (const part of manifest.parts) {
      const { context: c, request, mapCalls } = setup();
      const downloads = enableBundledIndexes(c);
      c.DISCOVERY_LOCAL_SOURCES = c.DISCOVERY_LOCAL_SOURCES.filter(source => source.id === provider);
      const data = JSON.parse(readFileSync(join(__dirname, folder, part.file), 'utf8'));
      const row = data.places[0];
      const origin = { lat:row[2]-.001, lng:row[3] };
      const input = { ...criteria, kind:part.kind, minMinutes:0, minutes:10 };
      const result = await c.findDiscoveryPlaces(input, origin, request(input));
      assert.ok(result.some(p => p.osmType === provider && p.osmId === row[0]), `${provider}/${part.kind}`);
      assert.ok(result.every(p => p.kindId === part.kind && p.duration <= 600 && !p.free && !p.toilets && !p.benches));
      const first = downloads.length;
      await c.findDiscoveryPlaces(input, origin, request(input));
      assert.equal(downloads.length, first, 'successful files are reused');
      assert.equal(mapCalls.length, 0);
    }
  }
});

test('local source metadata, foreign coordinates, categories and duplicate IDs are checked before use', () => {
  const { context: c } = setup(); enableBundledIndexes(c);
  const original = JSON.parse(readFileSync(join(__dirname,'static/discovery-wikidata-jp-2026-11-13-v1/park.json'),'utf8'));
  for (const change of [d=>d.license='unknown', d=>d.kind='cafe', d=>d.source='other',
    d=>d.places[0][2]=91, d=>d.places[0][4]='unknown', d=>d.places.push(d.places[0]), d=>d.places[0][5]=NaN]) {
    const data = structuredClone(original); change(data);
    assert.throws(()=>c.bundledDiscoveryIndex(data,'wikidata','park'));
  }
});

test('a missing or cancelled local part cannot suppress the existing fallback or cache a late response', async () => {
  const { context: c, request, mapCalls } = setup(); enableBundledIndexes(c);
  const input = { ...criteria, kind:'culture' };
  c.fetchRouteJson = async()=>{throw Error('missing local file')};
  c.mapData = async()=>{throw Object.assign(Error('busy'),{routeCode:'MapBusy'})};
  await assert.rejects(c.findDiscoveryPlaces(input,start,request(input)),{routeCode:'MapBusy'});
  assert.equal(mapCalls.length,1); assert.equal(c.bundledDiscoveryCache.size,0);
  let resolve;
  c.fetchRouteJson = ()=>new Promise(r=>{resolve=r});
  const data = JSON.parse(readFileSync(join(__dirname,'static/discovery-wikidata-jp-2026-11-13-v1/culture.json'),'utf8'));
  const req=request(input),updates=[];
  const pending=c.findDiscoveryPlaces(input,start,req,p=>updates.push(p));
  req.controller.abort(); resolve(data);
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(c.bundledDiscoveryCache.size,0); assert.equal(updates.length,0);
});

test('local recommendations recheck time, speed, direction, changed origin and rural evidence', async () => {
  const { context:c,request,mapCalls }=setup(); enableBundledIndexes(c);
  const input={...criteria,kind:'park',minMinutes:330,minutes:390};
  const found=await c.findDiscoveryPlaces(input,start,request(input));
  assert.ok(found.length);
  for(const direction of ['n','e','s','w']) {
    const next={...input,direction};
    const selected=await c.findDiscoveryPlaces(next,start,request(next));
    assert.ok(selected.every(p=>c.discoveryDirectionMatches(start,p,direction)&&p.duration>=330*60&&p.duration<=390*60));
  }
  const next={...input,speed:6.5}, shifted={lat:35.67,lng:139.63};
  const changed=await c.findDiscoveryPlaces(next,shifted,request(next));
  assert.ok(changed.length);
  assert.ok(changed.every(p=>Math.abs(p.directDistance-distance(shifted,p))<.001&&p.duration>=330*60&&p.duration<=390*60));
  assert.equal(mapCalls.length,0);
  c.mapData=async()=>{throw Object.assign(Error('busy'),{routeCode:'MapBusy'})};
  const rural={...input,ambience:'rural'}, req=request(rural);
  assert.equal((await c.findDiscoveryPlaces(rural,start,req)).length,0,'no unverified rural matches');
  assert.equal(req.ambienceUnavailable,true);
});

test('unspecified search publishes several local kinds before waiting for unbundled sources, and cancellation discards late updates', async () => {
  const { context:c,request }=setup();enableBundledIndexes(c);
  const input={...criteria,kind:'any',minMinutes:330,minutes:390},req=request(input),updates=[];
  let firstExternal;
  const waiting=[];
  c.mapData=async()=>{firstExternal ??= new Set(updates.at(-1)?.map(p=>p.kindId));return new Promise(r=>waiting.push(r))};
  const pending=c.runDiscoveryTask(req,()=>c.findDiscoveryPlaces(input,start,req,p=>updates.push(p)));
  for(let i=0;i<100&&!firstExternal;i++)await new Promise(setImmediate);
  assert.ok(firstExternal?.size>=3, 'multiple categories are usable before an external response');
  const count=updates.length;req.controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  waiting.forEach(r=>r([]));await new Promise(setImmediate);
  assert.equal(updates.length,count);
});

test('six-hour shrine search uses actual bundled candidates and preserves time, direction and speed', async () => {
  const { context: c, request, mapCalls } = setup();
  const data = JSON.parse(readFileSync(join(__dirname, 'static/shrines-jp-2026-11-13-v1.json'), 'utf8'));
  c.shrineIndexCache = c.shrineIndexFromData(data);
  const input = { ...criteria, kind: 'shrine', minMinutes: 330, minutes: 390 };
  const updates = [];
  const found = await c.findDiscoveryPlaces(input, start, request(input), p => updates.push(p));
  assert.ok(found.length >= 5, 'Akitsu has real shrine candidates in the 5h30–6h30 band');
  assert.equal(mapCalls.length, 0, 'no external map API is needed');
  assert.ok(found.every(p => p.duration >= 330 * 60 && p.duration <= 390 * 60 && p.kindId === 'shrine'));
  assert.ok(found.every(p => p.osmType === 'wikidata' && /^Q\d+$/.test(p.osmId)));
  assert.ok(found.every(p => !p.free && !p.toilets && !p.benches), 'unknown amenities are not invented');
  assert.ok(updates.some(p => p.length >= 5));
  for (const [speed, direction, shifted] of [[6.5, 'w', start], [2.5, 'e', { lat:35.668, lng:139.631 }]]) {
    const next = { ...input, speed, direction };
    const places = await c.findDiscoveryPlaces(next, shifted, request(next));
    assert.ok(places.length);
    assert.ok(places.every(p => p.duration >= 330 * 60 && p.duration <= 390 * 60
      && c.discoveryDirectionMatches(shifted, p, direction)));
  }
  assert.equal(mapCalls.length, 0);
});

test('shrine snapshot is fetched once, reused, and a cancelled download is neither cached nor displayed', async () => {
  const { context: c, request } = setup();
  const data = JSON.parse(readFileSync(join(__dirname, 'static/shrines-jp-2026-11-13-v1.json'), 'utf8'));
  c.shrineIndexCache = null;
  c.SHRINE_INDEX_ENDPOINT = 'https://example.test/static/shrines-jp-2026-11-13-v1.json';
  let fetches = 0;
  c.fetchRouteJson = async () => { fetches++; return data; };
  const input = { ...criteria, kind: 'shrine', minMinutes: 330, minutes: 390 };
  await c.findDiscoveryPlaces(input, start, request(input));
  await c.findDiscoveryPlaces(input, start, request(input));
  assert.equal(fetches, 1);
  c.shrineIndexCache = null;
  let finish;
  c.fetchRouteJson = () => new Promise(resolve => { finish = resolve; });
  const req = request(input), updates = [];
  const pending = c.findDiscoveryPlaces(input, start, req, p => updates.push(p));
  req.controller.abort(); finish(data);
  await assert.rejects(pending, { name:'AbortError' });
  assert.equal(c.shrineIndexCache, null);
  assert.equal(updates.length, 0);
});

test('missing, malformed or out-of-band shrine data falls back without mistaking API errors for empty results', async () => {
  for (const local of [null, { version:1, snapshotDate:'2026-11-13', places:[['Q1','Invalid',NaN,139]] },
    { version:1, snapshotDate:'2026-11-13', places:[['Q1','Too close',start.lat,start.lng]] }]) {
    const { context: c, request, mapCalls } = setup();
    c.shrineIndexCache = null;
    c.SHRINE_INDEX_ENDPOINT = 'https://example.test/shrines.json';
    c.fetchRouteJson = async () => { if (!local) throw Error('not found'); return local; };
    const input = { ...criteria, kind:'shrine', minMinutes:330, minutes:390 };
    c.mapData = async () => [];
    assert.equal((await c.findDiscoveryPlaces(input, start, request(input))).length, 0);
    assert.equal(mapCalls.length, 1);
    c.discoveryMapCache.clear();
    c.mapData = async () => { throw Object.assign(Error('busy'), { routeCode:'MapBusy' }); };
    await assert.rejects(c.findDiscoveryPlaces(input, start, request(input)), { routeCode:'MapBusy' });
    assert.equal(c.discoveryMapCache.size, 0);
  }
});

test('shrine index rejects duplicate identifiers and invalid schema before caching', () => {
  const { context: c } = setup();
  const row = ['Q1','Shrine',35,139];
  for (const places of [[], [row,row], [['bad','Shrine',35,139]], [['Q2','',35,139]], [['Q3','Wrong',91,139]]]) {
    assert.throws(() => c.shrineIndexFromData({ version:1, snapshotDate:'2026-11-13', places }));
  }
});

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

test('an empty full-range search returns after one query and reuses its confirmed empty cache', async () => {
  const { context: c, request, mapCalls, advance } = setup();
  c.mapData = async () => [];
  const short = { ...criteria, kind: 'cafe', minMinutes: 0, minutes: 60 };
  assert.equal((await c.findDiscoveryPlaces(short, start, request(short))).length, 0);
  assert.equal(mapCalls.length, 1, 'no small-radius lookup followed by an extra expansion');
  assert.equal((await c.findDiscoveryPlaces(short, start, request(short))).length, 0);
  assert.equal(mapCalls.length, 1, 'a successful empty response is cacheable');
  advance(600001);
  await c.findDiscoveryPlaces(short, start, request(short));
  assert.equal(mapCalls.length, 2);
});

test('unspecified kind searches different place categories while keeping walking-time and access limits', async () => {
  const { context: c, request, mapCalls } = setup();
  c.photon = async () => ({ features: [] });
  const pool = elements().slice(0, 4).map((element, i) => ({ ...element, type: 'node',
    tags: i === 0 ? { leisure: 'park', name: '公園' }
      : i === 1 ? { amenity: 'cafe', name: 'カフェ' }
        : i === 2 ? { natural: 'peak', name: '山' }
          : { amenity: 'cafe', name: '非公開', access: 'private' } }));
  pool.push({ type: 'node', id: 999, lat: start.lat, lon: start.lng, tags: { amenity: 'cafe', name: '時間外' } });
  c.mapData = async query => pool.filter(element => query.includes(element.tags.amenity || element.tags.natural || element.tags.leisure));
  const broad = { ...criteria, kind: 'any' };
  const found = await c.findDiscoveryPlaces(broad, start, request(broad));
  assert.deepEqual(Array.from(found, place => place.name).sort(), ['カフェ', '公園', '山'].sort());
  assert.ok(mapCalls.some(query => query.includes('cafe')));
  assert.ok(mapCalls.some(query => query.includes('park')));
  assert.ok(mapCalls.some(query => query.includes('peak')));
  assert.ok(mapCalls.every(query => !query.includes('cafe') || !query.includes('peak')), 'heavy all-kind query is split');
  assert.equal(vm.runInContext('DISCOVERY_KINDS.any.label', c), 'こだわらない');
});

test('6h unspecified search streams parks before the other batches finish and keeps 5h30–6h30 bounds', async () => {
  const { context: c, request, calls, mapCalls } = setup();
  const sixHours = { ...criteria, kind: 'any', minMinutes: 330, minutes: 390 };
  c.photon = async () => ({ features: [...features.map((_, i) => feature(i + 1, 360, i * Math.PI / 3)), feature(90, 20), feature(91, 440)] });
  const extra = elements([feature(200, 360), feature(201, 360)]).map((element, index) => ({ ...element, type: 'node',
    tags: index === 0 ? { amenity: 'place_of_worship', religion: 'shinto', name: '神社' }
      : { tourism: 'viewpoint', name: '展望台' } }));
  let releaseBatch;
  c.mapData = async query => {
    if (query.includes('cafe')) return new Promise(resolve => { releaseBatch = () => resolve(extra); });
    return [];
  };
  const started = performance.now();
  const req = request(sixHours);
  const updates = [];
  let finished = false;
  const pending = c.runDiscoveryTask(req, () => c.findDiscoveryPlaces(sixHours, start, req, places => updates.push(places)))
    .then(places => { finished = true; return places; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.ok(updates.some(places => places.some(place => place.kindId === 'park')), 'parks are selectable while the batch is pending');
  releaseBatch();
  const found = await pending;
  assert.ok(performance.now() - started < 1000);
  assert.equal(found.length, 8); assert.equal(calls.length, 1);
  assert.equal(new Set(found.slice(0, 5).map(place => place.kindId)).size, 3);
  assert.equal(mapCalls.length, 6); assert.match(mapCalls[0], /cafe/);
  assert.match(mapCalls[0], /place_of_worship/); assert.match(mapCalls[0], /viewpoint/);
  assert.ok(found.every(place => place.duration >= 330 * 60 && place.duration <= 390 * 60));
  const before = calls.length;
  await c.findDiscoveryPlaces(sixHours, start, request(sixHours));
  assert.equal(calls.length, before, 'repeat search uses the park cache');
});

test('many early parks stay selectable while other kinds are pending, rather than ending the search', async () => {
  const { context: c, request } = setup();
  let finishCafe;
  const parks = Array.from({ length: 10 }, (_, i) => ({ key: `park/${i}`, kindId: 'park', duration: 100 + i, preferenceScore: 0 }));
  const updates = [], tried = [];
  c.findDiscoveryPlaces = async (selected, origin, child, onUpdate) => {
    tried.push(selected.kind);
    if (selected.kind === 'park') { onUpdate(parks); return parks; }
    if (selected.kind === 'cafe') return new Promise(resolve => { finishCafe = resolve; });
    return [{ key: 'shrine/1', kindId: 'shrine', duration: 1000, preferenceScore: 0 }];
  };
  let finished = false;
  const broad = { ...criteria, kind: 'any' };
  const found = c.findAnyDiscoveryPlaces(broad, start, request(broad), places => updates.push(places)).then(places => { finished = true; return places; });
  await new Promise(setImmediate);
  assert.equal(finished, false, 'two kinds are not enough even when parks alone exceed five');
  assert.ok(updates.some(places => places.some(place => place.kindId === 'park')), 'early candidates remain usable');
  finishCafe([{ key: 'cafe/1', kindId: 'cafe', duration: 2000, preferenceScore: 0 }]);
  const result = await found;
  assert.equal(new Set(result.slice(0, 5).map(place => place.kindId)).size, 3);
  assert.ok(tried.includes('shrine'));
});

test('unspecified ordering keeps diverse kinds before truncation, more pages and history; specific kinds keep original ranking', () => {
  const { context: c } = setup();
  const pool = Array.from({ length: 260 }, (_, i) => ({ key: `park/${i}`, kindId: 'park', duration: i, distance: i, preferenceScore: 0 }));
  pool.push(...['cafe', 'mountain', 'shrine'].flatMap(kindId => Array.from({ length: 3 }, (_, i) => ({
    key: `${kindId}/${i}`, kindId, duration: 1000 + i, distance: 1000 + i, preferenceScore: 0,
  }))));
  const broad = { ...criteria, kind: 'any' };
  const mixed = c.sortDiscoveryPlaces(pool, broad);
  assert.equal(mixed.length, 250);
  assert.equal(new Set(mixed.slice(0, 5).map(place => place.kindId)).size, 4);
  assert.equal(new Set(mixed.slice(5, 10).map(place => place.kindId)).size, 4);
  assert.equal(mixed.filter(place => place.kindId === 'cafe').length, 3);
  assert.deepEqual(c.sortDiscoveryPlaces(mixed, broad).map(place => place.key), mixed.map(place => place.key), 'rendering or restoring must preserve diversity');
  assert.deepEqual(Array.from(mixed.filter(place => place.kindId === 'park').slice(0, 3), place => place.duration), [0, 1, 2]);
  assert.ok(c.sortDiscoveryPlaces(pool, criteria).slice(0, 5).every(place => place.kindId === 'park'), 'a specific-kind search keeps the original ordering');
});

test('unspecified search limits concurrent kinds, keeps filters and advances past stalled kinds within eight seconds', async () => {
  const { context: c, request } = setup();
  const timers = [], pending = [], updates = [];
  c.setTimeout = (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; };
  c.clearTimeout = timer => { timer.cleared = true; };
  const input = { ...criteria, kind: 'any', ambience: 'rural', direction: 'w', highElevation: true, keyword: '山' };
  let active = 0, maxActive = 0;
  c.findDiscoveryPlaces = (selected, origin, child, onUpdate) => {
    assert.equal(selected.ambience, 'rural'); assert.equal(selected.direction, 'w');
    assert.equal(selected.highElevation, true); assert.equal(selected.minMinutes, input.minMinutes);
    active++; maxActive = Math.max(maxActive, active);
    child.controller.signal.addEventListener('abort', () => { active--; }, { once: true });
    pending.push({ child, onUpdate }); return new Promise(() => {});
  };
  const req = request(input);
  const found = c.findAnyDiscoveryPlaces(input, start, req, places => updates.push(places));
  await new Promise(setImmediate);
  assert.equal(pending.length, 2); assert.equal(timers[0].ms, 8000);
  timers[0].callback(); await new Promise(setImmediate);
  assert.equal(pending.length, 3, 'a timeout starts the next kind');
  req.controller.abort(); await assert.rejects(found, { name: 'AbortError' });
  pending.forEach(item => item.onUpdate([{ key: 'late' }]));
  assert.equal(updates.length, 0); assert.equal(maxActive, 2);
  assert.ok(timers.every(timer => timer.cleared));
});

test('unspecified search distinguishes unavailable kinds from confirmed empty results and caches only successful responses', async () => {
  const { context: c, request, mapCalls, calls } = setup();
  c.photon = async () => ({ features: [] });
  c.mapData = async () => { throw Object.assign(new Error('busy'), { routeCode: 'MapBusy' }); };
  const broad = { ...criteria, kind: 'any' };
  await assert.rejects(c.findDiscoveryPlaces(broad, start, request(broad)), { routeCode: 'MapBusy' });
  assert.equal(c.discoveryMapCache.size, 0);
  c.mapData = async () => [];
  const firstCalls = mapCalls.length;
  assert.equal((await c.findDiscoveryPlaces(broad, start, request(broad))).length, 0);
  assert.equal(mapCalls.length - firstCalls, 7, 'empty point kinds are confirmed in three batches, plus park and three geometry kinds');
  assert.equal(calls.length, 1, 'an empty Photon bounding box is not retried with three more ranking focuses');
  const before = mapCalls.length;
  assert.equal((await c.findDiscoveryPlaces(broad, start, request(broad))).length, 0);
  assert.equal(mapCalls.length, before);
});

test('unspecified search continues all kinds beyond three kinds and five candidates, publishing each completed kind', async () => {
  const { context: c, request } = setup();
  c.prefetchDiscoveryKinds = async () => {};
  const tried = [], updates = [];
  c.findDiscoveryPlaces = async selected => {
    tried.push(selected.kind);
    return [{ key: selected.kind, kindId: selected.kind, preferenceScore: 0, duration: 100 }];
  };
  const broad = { ...criteria, kind: 'any' };
  const found = await c.findAnyDiscoveryPlaces(broad, start, request(broad), places => updates.push(places.length));
  assert.equal(new Set(tried).size, 13);
  assert.equal(found.length, 13);
  assert.ok(updates.includes(1)); assert.ok(updates.includes(5)); assert.equal(updates.at(-1), 13);
});

test('cancelling a point-kind batch discards a late response without caching it', async () => {
  const { context: c, request } = setup();
  let finish;
  c.mapData = async () => new Promise(resolve => { finish = resolve; });
  const broad = { ...criteria, kind: 'any' }, req = request(broad);
  const pending = c.prefetchDiscoveryKinds(['cafe', 'shrine', 'sightseeing'], broad, start, req);
  req.controller.abort(); finish(elements());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(c.discoveryMapCache.size, 0);
});

test('direct Overpass runtime errors cannot become a false empty result', async () => {
  const { context: c, request } = setup();
  const req = request(); req.deadlineAt = c.Date.now() + 8000;
  c.DISCOVERY_MAP_ENDPOINTS = ['https://one.example/interpreter'];
  c.discoveryMapProviders = [{ retryAt: 0 }]; c.preferredDiscoveryMapProvider = 0; c.lastDiscoveryMapError = null;
  c.fetchRouteJson = async () => ({ elements: [], remark: 'runtime error: Query timed out' });
  await assert.rejects(c.originalFetchDiscoveryMapData('query', req), /Incomplete/);
  assert.equal(c.discoveryMapCache.size, 0);
});

test('seasonal keywords in unspecified search retain local data without external lookups', async () => {
  const { context: c, request, calls, mapCalls } = setup();
  const broad = { ...criteria, kind: 'any', keyword: '桜' };
  c.fetchSeasonalPlaces = async () => elements().map(element => ({ ...element, seasons: ['cherry_blossom'] }));
  assert.ok((await c.findDiscoveryPlaces(broad, start, request(broad))).length > 0);
  assert.equal(calls.length, 0); assert.equal(mapCalls.length, 0);
});

test('removed legacy walking-place option restores as unspecified while preserving historical candidates', () => {
  const { context: c } = setup();
  for (const file of ['index.html', 'templates/index.html']) {
    const html = readFileSync(join(__dirname, file), 'utf8');
    assert.doesNotMatch(html, /<option value="places">/); assert.match(html, /<option value="any">こだわらない/);
  }
  c.ui = new Proxy({}, { get: (obj, key) => obj[key] ||= {} });
  c.updateDiscoveryTimeRange = () => {}; c.renderDiscoveryResults = places => { c.restored = places; };
  c.discoveryDisplayedCount = () => 1;
  vm.runInContext(source.slice(source.indexOf('function restoreDiscoverySearch('), source.indexOf('function finishDiscoverySearch(')), c);
  c.restoreDiscoverySearch({ id: 'old', criteria: { ...criteria, kind: 'places' }, places: [{ key: 'saved' }], elapsedSeconds: 1 }, false);
  assert.equal(c.ui['discovery-kind'].value, 'any'); assert.equal(c.restored[0].key, 'saved');
  assert.equal(vm.runInContext('DISCOVERY_SEARCH_TIMEOUT_MS', c), 60000);
});

test('a bounded search reports busy providers after both fail without waiting for automatic retries', async () => {
  const { context: c, request } = setup();
  const req = request(); req.deadlineAt = c.Date.now() + 15000;
  c.DISCOVERY_MAP_ENDPOINTS = ['https://one.example/interpreter', 'https://two.example/interpreter'];
  c.discoveryMapProviders = [{ retryAt: 0 }, { retryAt: 0 }];
  c.preferredDiscoveryMapProvider = 0; c.lastDiscoveryMapError = null;
  const attempts = [], waits = [];
  c.fetchRouteJson = async (url, request, timeout) => {
    attempts.push(timeout); throw Object.assign(new Error('busy'), { routeCode: 'MapBusy', httpStatus: 503 });
  };
  c.abortableRouteDelay = async ms => { waits.push(ms); };
  await assert.rejects(c.originalFetchDiscoveryMapData('query', req), { routeCode: 'MapBusy' });
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(ms => ms <= 15000));
  assert.ok(waits.every(ms => ms <= 1000), 'no 30-second retry delay');
});

test('search deadline stops a source that ignores abort, while normal completion cancels the timer', async () => {
  const { context: c, request } = setup();
  const stalled = request();
  await assert.rejects(c.runDiscoveryTask(stalled, () => new Promise(() => {}), 15), { name: 'AbortError' });
  assert.equal(stalled.timedOut, true); assert.equal(stalled.controller.signal.aborted, true);
  const complete = request();
  assert.deepEqual(await c.runDiscoveryTask(complete, async () => [], 15), []);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(complete.controller.signal.aborted, false);
});

test('UI distinguishes a complete empty result from a deadline, keeps partial candidates and discards late callbacks', async () => {
  const { context: c, request } = setup();
  vm.runInContext(source.slice(source.indexOf('async function fetchDiscoverySuggestions('),
    source.indexOf('ui["open-discovery"].addEventListener')), c);
  c.message = (target, text, error = false) => { target.textContent = text; target.error = error; };
  c.finishDiscoverySearch = () => {};
  c.showDiscoveryResults = () => {};
  c.setDiscoveryBusy = value => { c.busy = value; };
  c.renderDiscoveryResults = (places, req) => { req.places = places; req.visibleCount = 5; };
  const original = c.runDiscoveryTask;
  c.runDiscoveryTask = (req, work) => original(req, work, 15);
  const empty = request(); c.discoveryRequest = empty; c.findDiscoveryPlaces = async () => [];
  await c.fetchDiscoverySuggestions(empty);
  assert.equal(c.ui['discovery-status'].textContent, '条件に合う場所は見つかりませんでした。');
  assert.equal(c.ui['discovery-status'].error, false);
  for (const flag of ['natureUnavailable','kindsUnavailable']) {
    const incomplete = request(); c.discoveryRequest = incomplete;
    c.findDiscoveryPlaces = async (_criteria,_start,req) => { req[flag] = true; req.natureLimited = true; return []; };
    await c.fetchDiscoverySuggestions(incomplete);
    assert.match(c.ui['discovery-status'].textContent, /検索できませんでした/);
    assert.ok(!c.ui['discovery-status'].textContent.includes('見つかりませんでした'));
    assert.equal(c.ui['discovery-status'].error, true);
  }
  for (const flag of ['natureLimited','natureAccessUnresolved']) {
    const unconfirmed = request(); c.discoveryRequest = unconfirmed;
    c.findDiscoveryPlaces = async (_criteria,_start,req) => { req[flag] = true; return []; };
    await c.fetchDiscoverySuggestions(unconfirmed);
    assert.match(c.ui['discovery-status'].textContent, /見つかりませんでした/);
    assert.match(c.ui['discovery-status'].textContent, flag === 'natureLimited' ? /範囲の一部/ : /徒歩アクセス/);
  }
  let late;
  const stalled = request(); c.discoveryRequest = stalled;
  c.findDiscoveryPlaces = (criteria, start, req, onUpdate) => { late = onUpdate; return new Promise(() => {}); };
  await c.fetchDiscoverySuggestions(stalled);
  assert.match(c.ui['discovery-status'].textContent, /検索できませんでした.*タイムアウト/);
  assert.equal(c.busy, false);
  const status = c.ui['discovery-status'].textContent;
  late([{ key: 'late' }]); assert.equal(c.ui['discovery-status'].textContent, status);
  assert.equal(stalled.places, undefined);
  const partial = request(); c.discoveryRequest = partial;
  c.findDiscoveryPlaces = (criteria, start, req, onUpdate) => { onUpdate([{ key: 'known' }]); return new Promise(() => {}); };
  await c.fetchDiscoverySuggestions(partial);
  assert.match(c.ui['discovery-status'].textContent, /候補 1件.*時間切れ/);
  assert.equal(partial.places[0].key, 'known');
});

test('sea search includes harbours, fishing ports and marinas, retains beaches and filters restricted or water-centre points', async () => {
  const { context: c, request, mapCalls } = setup();
  c.L = { latLng: (lat, lng) => ({ lat, lng }), CRS: { EPSG3857: {
    projection: { R: 6378137 }, project: p => ({ x: p.lng, y: p.lat }),
  } } };
  const point = elements()[0].center;
  const tags = [{ harbour: 'yes' }, { harbour: 'fishing' }, { leisure: 'marina' },
    { landuse: 'harbour' }, { landuse: 'port' }, { industrial: 'port' }, { natural: 'beach' },
    { harbour: 'yes', access: 'private' }, { leisure: 'marina', foot: 'no' },
    { harbour: 'no' }, { water: 'harbour' }, { leisure: 'marina', natural: 'water' }];
  const nodes = tags.map((tag, i) => ({ type: 'node', id: i + 100, lat: point.lat, lon: point.lon,
    tags: { ...tag, name: `海辺${i}` } }));
  c.mapData = async () => nodes;
  const sea = { ...criteria, kind: 'coast' };
  const found = await c.findDiscoveryPlaces(sea, start, request(sea));
  assert.equal(found.length,0,'raw harbour/beach points without mapped pedestrian access are not destinations');
  const resolved=nodes.slice(0,7).map(node=>({...node,naturalAccess:{version:1,kind:'coast',point:{lat:node.lat,lng:node.lon},
    anchorType:'way',anchorId:500,status:'unknown',note:'徒歩アクセス未確認'}}));
  assert.deepEqual(Array.from(c.discoveryCandidates(resolved,sea,start),p=>p.osmId),[100],'overlapping natural features sharing the same footway point collapse');
  assert.ok(nodes.slice(0,7).every(node=>c.discoveryKindMatches(node.tags,'coast')));
  assert.match(mapCalls[0], /harbour/); assert.match(mapCalls[0], /marina/);
  assert.match(mapCalls[0], /industrial/); assert.match(mapCalls[0], /beach\|coastline/);
  assert.ok(c.discoveryPreferences({ ...sea, keyword: '港' }).kinds.has('coast'));
  assert.ok(c.discoveryPreferences({ ...sea, keyword: '漁港' }).kinds.has('coast'));
  assert.equal(c.discoveryCandidates(nodes, { ...sea, direction: 'w' }, start).length, 0);
  const far = { ...nodes[0], lat: start.lat, lon: start.lng };
  assert.equal(c.discoveryCandidates([far], sea, start).length, 0, 'walking-time limits remain enforced');
});
