const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/static/js/app.js`, 'utf8');
const acquisition = source.slice(source.indexOf('function stopWatchingLocation()'), source.indexOf('ui["location-button"].addEventListener'));

function setup({ watch = true, secure = true } = {}) {
  let now = 1000000;
  const gets = [], watches = [], cleared = [], shown = [], failures = [], listeners = {};
  const geo = {
    getCurrentPosition(success, error, options) { gets.push({ success, error, options }); },
    clearWatch(id) { cleared.push(id); },
  };
  if (watch) geo.watchPosition = (success, error, options) => {
    watches.push({ success, error, options }); return watches.length - 1;
  };
  const c = vm.createContext({
    Date: { now: () => now }, Number, Math, Object,
    navigator: { geolocation: geo },
    window: { isSecureContext: secure, addEventListener(name, callback) { listeners[name] = callback; } },
    document: { hidden: false, addEventListener(name, callback) { listeners[name] = callback; } },
    locationWatchId: null, locationWatchGeneration: 0, pendingLocationRequest: null,
    lastLocationFix: null, LOCATION_CACHE_MAX_AGE_MS: 10000,
    locating: false, recenterWhenLocated: false, locationPermissionDenied: false,
    routeAwaitingLocation: false, routeEnabled: false, selectedPlace: null, destination: null,
    searchedStart: null, currentPosition: null,
    ui: { 'location-status': { textContent: '' } },
    map: {
      center: { lat: 35, lng: 139 }, zoom: 13,
      getCenter() { return { ...this.center }; }, getZoom() { return this.zoom; },
      project(p) { return { distanceTo(q) { return Math.hypot(p.lat - q.lat, p.lng - q.lng) * 1000; }, ...p }; },
    },
    validCoordinates(lat, lng) { return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180; },
    setLocationBusy(value) { c.locating = value; },
    message(target, value) { target.textContent = value; },
    routeLocationFailed() { failures.push('route'); },
    locationFailed(error) {
      c.locationPermissionDenied = error.code === 1;
      c.recenterWhenLocated = false; c.locating = false;
      failures.push(error.code); c.ui['location-status'].textContent = `error ${error.code}`;
    },
    showCurrentLocation(position, options) {
      shown.push({ position, options });
      c.currentPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
      if (options.center) c.map.center = { ...c.currentPosition };
      if (options.refreshRoute) c.routeAwaitingLocation = false;
      c.ui['location-status'].textContent = '';
    },
  });
  vm.runInContext(acquisition, c);
  return { c, gets, watches, cleared, shown, failures, listeners,
    advance(ms) { now += ms; },
    fix(lat = 35.7, accuracy = 12, age = 0) { return { coords: { latitude: lat, longitude: 139.7, accuracy }, timestamp: now - age }; },
  };
}

test('GPS watch starts immediately alongside a cached, lower-power first lookup', () => {
  const s = setup(); s.c.requestCurrentLocation({ initial: true });
  assert.equal(s.watches.length, 1); assert.equal(s.gets.length, 1);
  assert.equal(s.watches[0].options.enableHighAccuracy, true);
  assert.equal(s.gets[0].options.enableHighAccuracy, false);
  assert.equal(s.gets[0].options.maximumAge, 10000);
  assert.equal(s.gets[0].options.timeout, 4000);
  s.watches[0].success(s.fix());
  assert.equal(s.c.locating, false); assert.equal(s.shown.length, 1);
  s.gets[0].success(s.fix(36, 200));
  assert.equal(s.shown.length, 1, 'late coarse callback cannot replace the GPS winner');
});

test('fast fix displays without waiting for GPS; refinement keeps the camera steady', () => {
  const s = setup(); s.c.requestCurrentLocation({ initial: true });
  s.advance(80); s.gets[0].success(s.fix(35.7, 80));
  assert.equal(s.shown.length, 1); assert.equal(s.c.locating, false);
  const center = { ...s.c.map.center };
  s.advance(800); s.watches[0].success(s.fix(35.7001, 8));
  assert.equal(s.shown.length, 2); assert.equal(s.shown[1].options.refreshRoute, false);
  assert.deepEqual(s.c.map.center, center);
  assert.equal(s.c.ui['location-status'].textContent, '');
});

test('a recent accurate fix avoids another one-shot request; an expired fix does not', () => {
  const s = setup(); s.c.requestCurrentLocation(); s.watches[0].success(s.fix());
  s.advance(1000); s.c.requestCurrentLocation({ recenter: true });
  assert.equal(s.gets.length, 1); assert.equal(s.watches.length, 1);
  assert.equal(s.shown.at(-1).options.center, true);
  assert.equal(s.shown.at(-1).options.refreshRoute, false, 'Current location does not reroute');
  assert.equal(s.shown.at(-1).options.updateRoute, false);
  s.advance(10001); s.c.requestCurrentLocation(); assert.equal(s.gets.length, 2);
});

test('one lookup timing out does not fail or cancel the other', () => {
  const s = setup(); s.c.requestCurrentLocation();
  s.gets[0].error({ code: 3 }); assert.equal(s.c.locating, true); assert.deepEqual(s.failures, []);
  s.watches[0].success(s.fix()); assert.equal(s.c.locating, false); assert.deepEqual(s.failures, []);
});

test('two failures finish the request, and a later GPS update recovers the marker', () => {
  const s = setup(); s.c.requestCurrentLocation();
  s.watches[0].error({ code: 3 }); assert.equal(s.c.locating, true);
  s.gets[0].error({ code: 3 }); assert.deepEqual(s.failures, [3]); assert.equal(s.c.locating, false);
  s.advance(1000); s.watches[0].success(s.fix());
  assert.equal(s.shown.length, 1); assert.equal(s.c.ui['location-status'].textContent, '');
  s.watches[0].error({ code: 3 }); assert.deepEqual(s.failures, [3], 'temporary watch failure keeps a usable position');
});

test('denial stops tracking, clears reusable data and ignores the other callback', () => {
  const s = setup(); s.c.requestCurrentLocation(); s.watches[0].error({ code: 1 });
  assert.equal(s.c.locationWatchId, null); assert.equal(s.c.lastLocationFix, null);
  assert.deepEqual(s.cleared, [0]); assert.deepEqual(s.failures, [1]);
  s.gets[0].success(s.fix()); assert.equal(s.shown.length, 0);
});

test('startup respects a manual camera change; explicit recenter wins without duplicate lookups', () => {
  const s = setup(); s.c.requestCurrentLocation({ initial: true });
  s.c.map.center = { lat: 34, lng: 138 }; s.watches[0].success(s.fix());
  assert.equal(s.shown[0].options.center, false);
  const other = setup(); other.c.requestCurrentLocation({ initial: true });
  other.c.map.center = { lat: 34, lng: 138 }; other.c.requestCurrentLocation({ recenter: true });
  other.watches[0].success(other.fix());
  assert.equal(other.shown[0].options.center, true); assert.equal(other.gets.length, 1);
});

test('page hide cancels pending callbacks and a return without a fix starts a fresh lookup', () => {
  const s = setup(); s.c.requestCurrentLocation(); s.listeners.pagehide();
  assert.equal(s.c.locating, false); assert.equal(s.c.pendingLocationRequest, null);
  s.gets[0].success(s.fix()); s.watches[0].success(s.fix()); assert.equal(s.shown.length, 0);
  s.listeners.pageshow({ persisted: true }); assert.equal(s.gets.length, 2); assert.equal(s.watches.length, 2);
  s.watches[1].success(s.fix()); assert.equal(s.shown.length, 1);
});

test('stale coordinates and a coarse regression cannot overwrite an accurate fix', () => {
  const s = setup(); s.c.requestCurrentLocation();
  s.gets[0].success(s.fix(35.7, 12, 31000)); assert.equal(s.shown.length, 0);
  s.watches[0].success(s.fix()); assert.equal(s.shown.length, 1);
  s.advance(1000); s.watches[0].success(s.fix(36, 5000)); assert.equal(s.shown.length, 1);
  s.watches[0].success(s.fix(35.8, 10, 2000)); assert.equal(s.shown.length, 1);
  s.watches[0].success(s.fix(35.7001, 10)); assert.equal(s.shown.length, 2);
});

test('coarse first response cannot start a route, but the precise GPS result can', () => {
  const s = setup(); s.c.routeAwaitingLocation = true; s.c.requestCurrentLocation();
  s.gets[0].success(s.fix(35.7, 1500));
  assert.equal(s.c.locating, true); assert.equal(s.c.routeAwaitingLocation, true);
  assert.equal(s.shown[0].options.refreshRoute, false);
  s.advance(1000); s.watches[0].success(s.fix(35.701, 10));
  assert.equal(s.c.routeAwaitingLocation, false); assert.equal(s.shown.at(-1).options.refreshRoute, true);
});

test('a route requested during startup also waits past the coarse fix', () => {
  const s = setup(); s.c.requestCurrentLocation({ initial: true });
  s.c.routeAwaitingLocation = true; s.c.routeEnabled = true; s.c.requestCurrentLocation();
  s.gets[0].success(s.fix(35.7, 1500)); assert.equal(s.c.routeAwaitingLocation, true);
  s.advance(1000); s.watches[0].success(s.fix()); assert.equal(s.c.routeAwaitingLocation, false);
});

test('discarding an older watch sample does not fail a pending route', () => {
  const s = setup(); s.c.routeAwaitingLocation = true; s.c.requestCurrentLocation();
  s.gets[0].success(s.fix(35.7, 1500));
  s.watches[0].success(s.fix(35.701, 8, 100));
  assert.deepEqual(s.failures, []); assert.equal(s.c.locating, true);
  s.advance(1000); s.watches[0].success(s.fix(35.701, 8));
  assert.equal(s.c.locating, false); assert.equal(s.c.routeAwaitingLocation, false);
});

test('browsers without watchPosition still get a high-accuracy one-shot fallback', () => {
  const s = setup({ watch: false }); s.c.requestCurrentLocation();
  assert.equal(s.gets[0].options.enableHighAccuracy, true); assert.equal(s.gets[0].options.timeout, 15000);
  s.gets[0].success(s.fix()); assert.equal(s.shown.length, 1);
});

test('insecure contexts never invoke geolocation', () => {
  const s = setup({ secure: false }); s.c.requestCurrentLocation();
  assert.equal(s.gets.length, 0); assert.equal(s.watches.length, 0); assert.equal(s.c.locating, false);
  assert.ok(s.c.ui['location-status'].textContent);
});
