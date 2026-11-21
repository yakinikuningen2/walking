const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/static/js/app.js`, 'utf8');

function headingSetup(sensor = {}) {
  const listeners = {}, markers = [], timers = new Map(), status = {textContent:"",hidden:true};
  let now=1000000, timerId=0;
  const context = vm.createContext({
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},
    clearTimeout(id){timers.delete(id);},
    window: { isSecureContext: true, DeviceOrientationEvent: sensor,
      screen: { orientation: { angle: 0, addEventListener() {} } },
      addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type,fn){if(listeners[type]===fn)delete listeners[type];} },
    document: { hidden: false, getElementById(){return status;}, addEventListener(type, fn) { listeners[type] = fn; } },
    headingListening: false, headingReading: null, currentHeadingMarker: null,
    headingPermission: null, headingPermissionRequest: null, headingAutoTried:false, headingMonitorTimer:null, headingNeedsGesture:false, headingStartupPromise:null,
    currentPosition: { lat: 35, lng: 139 }, map: {},
    L: { divIcon: x => x, marker(point, options) {
      const marker = { point, options, angle: null, removed: false,
        addTo() { markers.push(this); return this; }, remove() { this.removed = true; },
        getLatLng() { return { lat: this.point[0], lng: this.point[1] }; },
        setLatLng(value) { this.point = value; },
        getElement() { return { style: { setProperty: (_, value) => { marker.angle = value; } } }; } };
      return marker;
    } },
  });
  vm.runInContext(source.slice(source.indexOf('function screenOrientationAngle()'), source.indexOf('function showCurrentLocation(')), context);
  const advance=ms=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}};
  return { context, listeners, markers, status, advance, timers };
}

test('Safari heading permission is requested from the existing location controls, once per grant', async () => {
  let calls = 0;
  const { context: c } = headingSetup({ requestPermission(absolute) {
    calls++; assert.equal(absolute, true); return Promise.resolve('granted');
  } });
  assert.equal(calls, 0, 'startup must not request gesture-only permission');
  const a = c.enableHeadingFromGesture(), b = c.enableHeadingFromGesture();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(calls, 1);
  assert.equal(await c.enableHeadingFromGesture(), true);
  assert.equal(calls, 1);
  for (const id of ['location-button', 'follow-location']) {
    const handler = source.slice(source.indexOf(`ui["${id}"].addEventListener("click"`));
    assert.match(handler.slice(0, handler.indexOf('\n});')), /enableHeadingFromGesture\(\{ retry: true \}\)/);
  }
});

test('denied, failing, unsupported and insecure sensors never break map/location operations', async () => {
  for (const requestPermission of [() => Promise.resolve('denied'), () => Promise.reject(Error('blocked')), () => { throw Error('blocked'); }]) {
    const { context: c } = headingSetup({ requestPermission });
    assert.equal(await c.enableHeadingFromGesture(), false);
    assert.equal(c.currentHeadingMarker, null);
  }
  const { context: c } = headingSetup();
  c.window.DeviceOrientationEvent = undefined;
  assert.equal(await c.enableHeadingFromGesture(), false);
  c.window.DeviceOrientationEvent = { requestPermission() { throw Error('must not call'); } };
  c.window.isSecureContext = false;
  assert.equal(await c.enableHeadingFromGesture(), false);
});

test('real compass updates the arrow at the GPS dot, including landscape and visibility changes', () => {
  const { context: c, markers, listeners } = headingSetup();
  c.handleDeviceOrientation({ webkitCompassHeading: 90, webkitCompassAccuracy: 10 });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].angle, '90.0deg');
  c.currentPosition = { lat: 36, lng: 140 };
  c.renderCurrentHeading();
  assert.deepEqual(Array.from(markers[0].point), [36, 140]);
  c.window.screen.orientation.angle = 90;
  c.renderCurrentHeading();
  assert.equal(markers[0].angle, '180.0deg');
  c.handleDeviceOrientation({ webkitCompassHeading: 0, webkitCompassAccuracy: -1 });
  assert.equal(c.currentHeadingMarker, null);
  c.handleDeviceOrientation({ alpha: 120, beta: 0, gamma: 0, absolute: false });
  assert.equal(c.currentHeadingMarker, null, 'relative rotation cannot establish facing');
  c.window.screen.orientation.angle = 0;
  c.handleDeviceOrientation({ alpha: 270, beta: 0, gamma: 0, absolute: true });
  assert.equal(c.currentHeadingMarker.angle, '90.0deg');
  c.document.hidden = true;
  listeners.visibilitychange();
  assert.equal(c.currentHeadingMarker, null);
});


function headingTarget({inside=true,field=false,external=false}={}) {
  return {closest(selector){
    if(selector==='input, textarea, select, label')return field?{}:null;
    if(selector==='a[href]')return external?{}:null;
    if(selector==='.app-brand')return null;
    return inside?{}:null;
  }};
}

test('first real map/menu interaction requests permission synchronously, while scripted clicks do not consume it',async()=>{
  let calls=0;const {context:c,listeners}=headingSetup({requestPermission(){calls++;return Promise.resolve('granted');}});
  assert.equal(typeof listeners.click,'function');
  listeners.click({isTrusted:false,target:headingTarget()});assert.equal(c.headingAutoTried,false);assert.equal(calls,0);
  for(const options of [{inside:false},{field:true},{external:true}])listeners.click({isTrusted:true,target:headingTarget(options)});
  assert.equal(calls,0);
  listeners.click({isTrusted:true,target:headingTarget()});assert.equal(calls,1,'invoke before any deferred task');
  await c.headingPermissionRequest;await Promise.resolve();assert.equal(c.headingPermission,'granted');
  listeners.click({isTrusted:true,target:headingTarget()});assert.equal(calls,1);
});

test('refused permission is explained and can be retried after changing browser settings',async()=>{
  let calls=0;const {context:c,status}=headingSetup({requestPermission(){return Promise.resolve(++calls===1?'denied':'granted');}});
  assert.equal(await c.enableHeadingFromGesture(),false);assert.equal(status.hidden,false);assert.equal(status.textContent,"向きを取得できませんでした。");
  assert.equal(await c.enableHeadingFromGesture(),false);assert.equal(calls,1,'no repeated automatic prompts');
  c.handleDeviceOrientation({webkitCompassHeading:75,webkitCompassAccuracy:5});assert.equal(c.currentHeadingMarker,null,'ignore events while denied');
  assert.equal(await c.enableHeadingFromGesture({retry:true}),true);assert.equal(calls,2);
  c.handleDeviceOrientation({webkitCompassHeading:75,webkitCompassAccuracy:5});assert.equal(c.currentHeadingMarker.angle,'75.0deg');assert.equal(status.hidden,true);
});

test('missing, insecure and unsupported sensors report only the failure without inventing a direction',async()=>{
  const {context:c,status,advance}=headingSetup({requestPermission:()=>Promise.resolve('granted')});
  await c.enableHeadingFromGesture();advance(8000);assert.equal(c.currentHeadingMarker,null);assert.equal(status.hidden,false);assert.match(status.textContent,/取得できません/);
  c.handleDeviceOrientation({alpha:45,beta:0,gamma:0,absolute:false});assert.equal(c.currentHeadingMarker,null);
  c.window.isSecureContext=false;await c.enableHeadingFromGesture({retry:true});assert.equal(status.textContent,"向きを取得できませんでした。");
  c.window.isSecureContext=true;c.window.DeviceOrientationEvent=undefined;await c.enableHeadingFromGesture({retry:true});assert.equal(status.textContent,"向きを取得できませんでした。");
});

test('empty WebKit properties do not mask Android absolute readings or erase valid headings',()=>{
  const {context:c,status}=headingSetup();
  c.handleDeviceOrientation({webkitCompassHeading:null,alpha:270,beta:0,gamma:0,absolute:true});assert.equal(c.currentHeadingMarker.angle,'90.0deg');
  c.handleDeviceOrientation({webkitCompassHeading:undefined,alpha:200,beta:0,gamma:0,absolute:false});assert.equal(c.currentHeadingMarker.angle,'90.0deg');
  c.handleDeviceOrientation({webkitCompassHeading:45,webkitCompassAccuracy:-1,absolute:false});assert.equal(c.currentHeadingMarker,null);assert.equal(status.textContent,"向きを取得できませんでした。");
  c.handleDeviceOrientation({webkitCompassHeading:0,webkitCompassAccuracy:5});assert.equal(c.currentHeadingMarker.angle,'0.0deg');assert.equal(status.hidden,true);
});

test('an idle phone keeps a valid arrow and resume waits for new direction data',()=>{
  const {context:c,advance,listeners,status}=headingSetup();
  c.handleDeviceOrientation({webkitCompassHeading:180,webkitCompassAccuracy:5});const marker=c.currentHeadingMarker;
  advance(60000);assert.equal(c.currentHeadingMarker,marker);assert.equal(status.hidden,true,'no false missing-data warning on stationary devices');
  c.document.hidden=true;listeners.visibilitychange();assert.equal(c.currentHeadingMarker,null);
  c.document.hidden=false;listeners.visibilitychange();advance(8000);assert.equal(status.hidden,false);
  c.handleDeviceOrientation({webkitCompassHeading:270,webkitCompassAccuracy:5});assert.equal(c.currentHeadingMarker.angle,'270.0deg');assert.equal(status.hidden,true);
});



test('already permitted heading starts on page initialization with no map interaction',async()=>{
  let calls=0;const {context:c}=headingSetup({requestPermission(){calls++;return Promise.resolve('granted');}});
  await c.initializeHeadingPermission();await c.initializeHeadingPermission();
  assert.equal(calls,1);assert.equal(c.headingPermission,'granted');
  c.handleDeviceOrientation({webkitCompassHeading:90,webkitCompassAccuracy:5});assert.equal(c.currentHeadingMarker.angle,'90.0deg');
  assert.deepEqual(Array.from(c.currentHeadingMarker.options.icon.iconSize),[44,44]);
});

test('gesture-only Safari continues startup and requests native permission on the next normal action',async()=>{
  let calls=0;const {context:c,listeners,status}=headingSetup({requestPermission(){
    if(++calls===1)return Promise.reject(Object.assign(Error('user activation required'),{name:'NotAllowedError'}));
    return Promise.resolve('granted');
  }});
  await c.initializeHeadingPermission();assert.equal(calls,1);assert.equal(c.headingAutoTried,false);assert.equal(status.hidden,true);
  listeners.click({isTrusted:false,target:headingTarget()});assert.equal(calls,1);
  listeners.click({isTrusted:true,target:headingTarget()});assert.equal(calls,2,'direct native request within the normal user gesture');
  await c.headingPermissionRequest;await Promise.resolve();assert.equal(c.headingPermission,'granted');
});

test('startup permission errors never block the app or show instructions',async()=>{
  const {context:c,status}=headingSetup({requestPermission(){throw Error('sensor unavailable');}});
  await c.initializeHeadingPermission();assert.equal(c.currentHeadingMarker,null);assert.equal(status.textContent,'向きを取得できませんでした。');
  for(const entry of ['index.html','templates/index.html']){
    const html=fs.readFileSync(`${__dirname}/${entry}`,'utf8');assert.doesNotMatch(html,/heading-permission-dialog|allow-heading-startup|skip-heading-startup/);
  }
});

test('unsupported sensors and a cached native denial do not trap startup',async()=>{
  const unsupported=headingSetup();unsupported.context.window.DeviceOrientationEvent=undefined;
  await unsupported.context.initializeHeadingPermission();assert.equal(unsupported.context.currentHeadingMarker,null);
  const denied=headingSetup({requestPermission:()=>Promise.resolve('denied')});
  await denied.context.initializeHeadingPermission();assert.equal(denied.context.headingPermission,'denied');assert.equal(denied.context.currentHeadingMarker,null);
});

function navigationSetup() {
  let now = 1000000, sequence = 0;
  const timers = new Map(), requests = [], listeners = {};
  const distance = (a, b) => {
    if (Array.isArray(a)) a = { lat: a[0], lng: a[1] };
    if (Array.isArray(b)) b = { lat: b[0], lng: b[1] };
    return Math.hypot(a.lat - b.lat, a.lng - b.lng);
  };
  const c = vm.createContext({
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { hidden: false, addEventListener(type, fn) { listeners[type] = fn; } },
    window: { addEventListener(type, fn) { listeners[type] = fn; } },
    ROUTE_PROGRESS_REFRESH_METERS: Number(source.match(/ROUTE_PROGRESS_REFRESH_METERS = (\d+)/)[1]),
    ROUTE_DEVIATION_METERS: 50, ROUTE_REFRESH_INTERVAL_MS: Number(source.match(/ROUTE_REFRESH_INTERVAL_MS = (\d+)/)[1]),
    ROUTE_POSITION_CONFIRM_MS: 2000, routeNavigationTimer: null,
    routeEnabled: true, destination: { lat: 1000, lng: 0 }, searchedStart: null,
    routeAwaitingLocation: false, currentPosition: { lat: 0, lng: 0 },
    routeNavigation: null, lastAutomaticRouteAt: -Infinity,
    routeChoices: new Map([['standard', { route: { points: [[0, 0], [1000, 0]], distance: 1000 } }]]),
    activeRouteKind: 'standard', walkingRouteMode: 'standard', routeTimer: null, routeRequest: null,
    map: { distance },
    walkingRoutePosition(point) { return { along: point.lat, distance: Math.abs(point.lng), total: 1000 }; },
    requestWalkingRoute(options) { requests.push(options); c.cancelNavigationRefresh(); },
  });
  vm.runInContext(source.slice(source.indexOf('function cancelNavigationRefresh()'), source.indexOf('function routePointsChanged()')), c);
  const fix = (lat = 35, lng = 0, accuracy = 5, age = 0) => {
    c.currentPosition = { lat, lng };
    c.updateWalkingRouteFromLocation({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: now - age });
  };
  const advance = ms => {
    const until = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = until;
  };
  return { c, fix, advance, requests, timers, listeners };
}

test('confirmed progress refreshes the route without reopening or touching the map', () => {
  const { c, fix, advance, requests, timers } = navigationSetup();
  assert.equal(c.ROUTE_PROGRESS_REFRESH_METERS, 30);
  assert.equal(c.ROUTE_REFRESH_INTERVAL_MS, 10000);
  fix(); advance(1000); fix(36); // two good fixes, still inside confirmation period
  assert.equal(requests.length, 0); assert.equal(timers.size, 1);
  advance(1000); // no more GPS callbacks or UI actions
  assert.equal(requests.length, 1); assert.equal(requests[0].automatic, true);
  assert.equal(timers.size, 0);
  assert.equal(c.lastAutomaticRouteAt, 1002000);
});

test('cooldown expires on the open map but does not spam the API or cancel active requests', () => {
  const { c, fix, advance, requests, timers } = navigationSetup();
  c.lastAutomaticRouteAt = 1000000;
  fix(); advance(1000); fix(36);
  advance(8999); assert.equal(requests.length, 0);
  c.routeRequest = { replaceExisting: false };
  advance(1); assert.equal(requests.length, 0); assert.equal(timers.size, 1);
  c.routeRequest = null;
  advance(1000); assert.equal(requests.length, 1);
  advance(20000); assert.equal(requests.length, 1, 'stationary map is not a polling loop');
});

test('single/noisy/stale fixes and stationary positions do not trigger rerouting', () => {
  for (const [lat, lng, accuracy, age] of [[10, 0, 5, 0], [35, 0, 80, 0], [35, 0, 5, 21000]]) {
    const s = navigationSetup(); s.fix(lat, lng, accuracy, age); s.advance(3000); s.fix(lat, lng, accuracy, age);
    s.advance(10000); assert.equal(s.requests.length, 0);
  }
  const s = navigationSetup(); s.fix(); s.advance(10000);
  assert.equal(s.requests.length, 0, 'a single deviation/progress fix is not confirmed');
  s.fix(0); s.advance(10000); assert.equal(s.requests.length, 0);
});

test('off-route positions refresh; explicit start, hidden page and navigation cancellation stop pending work', () => {
  const s = navigationSetup(); s.fix(0, 70); s.advance(2000); s.fix(0, 72);
  assert.equal(s.requests.length, 1);
  for (const stop of ['hidden', 'pagehide', 'explicit', 'cancel', 'stale']) {
    const t = navigationSetup(); t.c.lastAutomaticRouteAt = 1000000;
    t.fix(); t.advance(1000); t.fix(36);
    if (stop === 'hidden') { t.c.document.hidden = true; t.listeners.visibilitychange(); }
    if (stop === 'pagehide') t.listeners.pagehide();
    if (stop === 'explicit') t.c.searchedStart = { lat: 0, lng: 0 };
    if (stop === 'cancel') t.c.cancelNavigationRefresh();
    if (stop === 'stale') t.c.routeRequest = {}; // busy until the fix expires
    t.advance(30000);
    assert.equal(t.requests.length, 0, stop); assert.equal(t.timers.size, 0, stop);
    if (stop === 'hidden' || stop === 'pagehide') {
      assert.equal(t.c.routeNavigation.pending, null);
      t.c.document.hidden = false;
      t.fix(40);
      assert.equal(t.requests.length, 0, 'resuming needs new confirmation');
    }
  }
});

test('destination content precedes the distance/details control in both entry points', () => {
  for (const name of ['index.html', 'templates/index.html']) {
    const html = fs.readFileSync(`${__dirname}/${name}`, 'utf8');
    assert.ok(html.indexOf('id="destination-panel"') < html.indexOf('id="toggle-route-details"'));
    assert.ok(html.indexOf('id="route-panel"') < html.indexOf('id="toggle-route-details"'));
    assert.ok(html.indexOf('id="refresh-route-on-map"') > html.indexOf('id="route-map-actions"'));
  }
});

test('map refresh uses background replacement and ignores clicks during retrieval or after stopping', () => {
  const calls = [];
  let click;
  const c = vm.createContext({
    ui: { 'refresh-route-on-map': { addEventListener(_, fn) { click = fn; } } },
    routeEnabled: true, destination: {}, routeRequest: null, routeTimer: null,
    getStartPoint: () => ({ lat: 35, lng: 139 }), lastAutomaticRouteAt: -Infinity,
    Date: { now: () => 10000 }, requestWalkingRoute: options => calls.push(options),
  });
  vm.runInContext(source.slice(source.indexOf('ui["refresh-route-on-map"].addEventListener'), source.indexOf('function stopWalkingRoute()')), c);
  click(); assert.equal(calls.length, 1); assert.equal(calls[0].automatic, true);
  assert.equal(c.lastAutomaticRouteAt, 10000);
  for (const state of [{ routeRequest: {} }, { routeRequest: null, routeTimer: 1 }, { routeTimer: null, routeEnabled: false }]) {
    Object.assign(c, state); click(); assert.equal(calls.length, 1);
  }
});
